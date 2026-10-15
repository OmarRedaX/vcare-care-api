import type { Logger } from "../logger/logger";
import { currentRequestId, currentRequestIdOrNew } from "../logger/request-context";
import type { IdentityClient } from "./identity-client";
import type { HydratedUser } from "./types";

/**
 * Case 2 degrade wrapper: one batched call for the distinct ids; an Identity failure, or an unexpected throw, degrades to an
 * empty map (callers render `profileHydrated: false`) and never fails the read. No ids -> no call.
 */
export async function hydrateUsersOrEmpty(identity: Pick<IdentityClient, "getUsersBatch">, logger: Logger, userIds: readonly number[]): Promise<Map<number, HydratedUser>> {
    const ids = [...new Set(userIds)];
    if (ids.length === 0) return new Map();
    try {
        return (await identity.getUsersBatch(ids, currentRequestIdOrNew())).users;
    } catch {
        logger.warn("identity_hydration_failed", { requestId: currentRequestId() });
        return new Map();
    }
}
