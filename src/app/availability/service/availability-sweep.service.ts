import type { Knex } from "knex";
import { withSessionAdvisoryLock } from "../../../lib/knex/session-advisory-lock";
import type { Logger } from "../../../lib/logger/logger";
import type { Clock } from "../../../lib/types/types";
import type { TickOutcome } from "../../../lib/worker/types";
import type { DoctorDiscoveryReader } from "../../doctors/service/doctor-discovery.reader";
import { LOG_CANDIDATES_TRUNCATED, LOG_SWEEP_DONE, LOG_SWEEP_SKIPPED, METRIC_SWEEP_DURATION_MS, SWEEP_BATCH, SWEEP_LOCK_ID, SWEEP_LOCK_NAMESPACE } from "../constants";
import type { NextAvailableComputer } from "./next-available.computer";
import type { NextAvailableIndex } from "./next-available.index";

/**
 * `availability-sweep` (AV-R23): recomputes every bookable doctor, removes index members that are no longer bookable, then stamps
 * `next-available:swept-at`. A singleton by session advisory lock. Anything short of a full pass (lock held, Redis unreachable, aborted,
 * a truncated doctor list) is `"incomplete"` and leaves the stamp alone, so the alert measures real freshness.
 */
export class AvailabilitySweepService {
    constructor(
        private readonly db: Knex,
        private readonly reader: DoctorDiscoveryReader,
        private readonly computer: NextAvailableComputer,
        private readonly index: NextAvailableIndex,
        private readonly logger: Logger,
        private readonly clock: Clock,
    ) {}

    async tick(signal: AbortSignal): Promise<TickOutcome | void> {
        const ran = await withSessionAdvisoryLock(this.db, SWEEP_LOCK_NAMESPACE, SWEEP_LOCK_ID, () => this.sweep(signal));
        if (ran === undefined) this.logger.debug(LOG_SWEEP_SKIPPED);
        return ran ?? "incomplete";
    }

    private async sweep(signal: AbortSignal): Promise<TickOutcome> {
        if (!this.index.isUsable()) return "incomplete";
        const startedAt = this.clock.now();
        const listed = await this.reader.listBookableForIndex();
        if (listed.truncated) this.logger.warn(LOG_CANDIDATES_TRUNCATED);
        let batches = 0;
        for (let offset = 0; offset < listed.items.length; offset += SWEEP_BATCH) {
            if (signal.aborted) return "incomplete";
            const result = await this.computer.refresh(listed.items.slice(offset, offset + SWEEP_BATCH), this.clock.now());
            if (result.failed.length > 0) return "incomplete";
            batches += 1;
        }
        if (signal.aborted || listed.truncated) return "incomplete";
        const members = await this.index.members();
        if (members === undefined) return "incomplete";
        const bookable = new Set(listed.items.map((doctor) => doctor.userId));
        const candidates = members.filter((member) => !bookable.has(member));
        // The list above is minutes old on a big pass: a doctor who became bookable (and was freshly written) meanwhile must not be removed.
        const stale = candidates.length === 0 ? candidates : await this.withoutBookable(candidates);
        if (stale.length > 0 && !(await this.index.remove(stale))) return "incomplete";
        if (!(await this.index.markSwept(this.clock.now()))) return "incomplete";
        const durationMs = this.clock.now() - startedAt;
        this.logger.metric(METRIC_SWEEP_DURATION_MS, durationMs);
        this.logger.info(LOG_SWEEP_DONE, { doctors: listed.items.length, batches, durationMs });
        return "done";
    }

    private async withoutBookable(userIds: readonly number[]): Promise<number[]> {
        const still = new Set((await this.reader.listBookableForIndex(userIds)).items.map((doctor) => doctor.userId));
        return userIds.filter((userId) => !still.has(userId));
    }
}
