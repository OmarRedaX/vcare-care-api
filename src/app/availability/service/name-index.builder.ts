import { randomUUID } from "node:crypto";
import type { IdentityClient } from "../../../lib/identity-client/identity-client";
import type { Logger } from "../../../lib/logger/logger";
import type { Clock } from "../../../lib/types/types";
import { normalizeName } from "../../../pkg/utils/name";
import type { IndexDoctor } from "../../doctors/types";
import { LOG_NAME_INDEX_BUILT, LOG_NAME_INDEX_STALE, NAME_HYDRATE_CHUNK, NAME_MEMBER_SEPARATOR } from "../constants";
import { NameIndexOutcome } from "../enums";
import type { NextAvailableIndex } from "./next-available.index";

/**
 * Builds the derived display-name index (ADR 0025, AV-R28) for `care-worker`: hydrates the bookable doctors through `lib/identity-client` (Case 2,
 * `identity:user:*` cache first, 100 ids per call), indexes only Identity-`active` users that have a name, and swaps the result in. Hydration that is
 * degraded (any chunk failed) keeps the previous build: a partial index would silently hide doctors. Names live in Redis only and are never logged.
 */
export class NameIndexBuilder {
    constructor(
        private readonly identity: Pick<IdentityClient, "getUsersBatch">,
        private readonly index: NextAvailableIndex,
        private readonly logger: Logger,
        private readonly clock: Clock,
    ) {}

    async rebuild(doctors: readonly IndexDoctor[], signal: AbortSignal): Promise<NameIndexOutcome> {
        const members: string[] = [];
        // One call per 100 ids so a dead Identity stops the pass at the first failed chunk instead of timing out chunk after chunk.
        for (let offset = 0; offset < doctors.length; offset += NAME_HYDRATE_CHUNK) {
            if (signal.aborted) return this.stale();
            const userIds = doctors.slice(offset, offset + NAME_HYDRATE_CHUNK).map((doctor) => doctor.userId);
            const { users, degraded } = await this.identity.getUsersBatch(userIds, randomUUID());
            if (degraded) return this.stale();
            for (const userId of userIds) {
                const user = users.get(userId);
                if (user === undefined || user.status !== "active") continue;
                const name = normalizeName(user.displayName);
                if (name.length > 0) members.push(`${name}${NAME_MEMBER_SEPARATOR}${userId}`);
            }
        }
        if (signal.aborted) return this.stale();
        if (!(await this.index.replaceNameIndex(members, this.clock.now()))) return NameIndexOutcome.Failed;
        this.logger.info(LOG_NAME_INDEX_BUILT, { members: members.length });
        return NameIndexOutcome.Built;
    }

    private stale(): NameIndexOutcome {
        this.logger.warn(LOG_NAME_INDEX_STALE);
        return NameIndexOutcome.Stale;
    }
}
