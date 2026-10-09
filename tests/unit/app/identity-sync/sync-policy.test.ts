import { IdentitySyncJobKind } from "../../../../src/app/identity-sync/enums";
import { buildSyncPolicies } from "../../../../src/app/identity-sync/sync-policy";
import type { IdentitySyncJobRow, TransientFailureContext } from "../../../../src/app/identity-sync/types";

const START = Date.UTC(2026, 9, 9, 12, 0, 0);
const policies = buildSyncPolicies({ IDENTITY_SYNC_ALERT_AFTER_SECONDS: 900 });
const context = (changes: Partial<TransientFailureContext> = {}, job: Partial<IdentitySyncJobRow> = {}): TransientFailureContext => ({
    job: { created_at: new Date(START), updated_at: new Date(START), ...job } as IdentitySyncJobRow,
    consecutiveFailures: 1, lastErrorCode: "HTTP_503", nowMs: START, ...changes,
});

describe("buildSyncPolicies", () => {
    it("should define a policy for every job kind", () => {
        expect(Object.keys(policies).sort()).toEqual(Object.values(IdentitySyncJobKind).sort());
    });

    describe.each([[IdentitySyncJobKind.Verification, "IdentityApprovalSyncPending"], [IdentitySyncJobKind.Reinstatement, "IdentityReinstatementSyncPending"]] as const)("%s", (kind, message) => {
        it("should not alert before the window and alert exactly at it", () => {
            expect(policies[kind].alertOnTransient(context({ nowMs: START + 899_999 }))).toBeNull();
            expect(policies[kind].alertOnTransient(context({ nowMs: START + 900_000 }))).toEqual({ message, fields: {} });
        });

        it("should alert only for the first attempt that crosses the window", () => {
            expect(policies[kind].alertOnTransient(context({ nowMs: START + 2_000_000 }, { updated_at: new Date(START + 900_000) }))).toBeNull();
            expect(policies[kind].alertOnTransient(context({ nowMs: START + 2_000_000 }, { updated_at: new Date(START + 899_000) }))).toEqual({ message, fields: {} });
        });

        it("should ignore the consecutive failure count", () => {
            expect(policies[kind].alertOnTransient(context({ consecutiveFailures: 3 }))).toBeNull();
        });

        it("should follow the configured window", () => {
            const short = buildSyncPolicies({ IDENTITY_SYNC_ALERT_AFTER_SECONDS: 60 });
            expect(short[kind].alertOnTransient(context({ nowMs: START + 60_000 }))).toEqual({ message, fields: {} });
        });
    });

    describe("suspension", () => {
        it.each([3, 13, 23, 103])("should alert at consecutive failure %i", (count) => {
            expect(policies[IdentitySyncJobKind.Suspension].alertOnTransient(context({ consecutiveFailures: count })))
                .toEqual({ message: "IdentitySuspensionSyncFailing", fields: { consecutiveFailures: count, lastErrorCode: "HTTP_503" } });
        });

        it.each([1, 2, 4, 12, 14])("should not alert at consecutive failure %i", (count) => {
            expect(policies[IdentitySyncJobKind.Suspension].alertOnTransient(context({ consecutiveFailures: count }))).toBeNull();
        });

        it("should never alert on time", () => {
            expect(policies[IdentitySyncJobKind.Suspension].alertOnTransient(context({ nowMs: START + 86_400_000, consecutiveFailures: 1 }))).toBeNull();
        });
    });
});
