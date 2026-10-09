/* eslint-disable @typescript-eslint/unbound-method */
import type { Knex } from "knex";
import { IdentitySyncService } from "../../../../src/app/identity-sync/service/identity-sync.service";
import * as syncRepo from "../../../../src/app/identity-sync/repository/identity-sync.repo";
import * as locks from "../../../../src/lib/knex/session-advisory-lock";
import { DoctorProfile } from "../../../../src/app/doctors/entity/doctor-profile.entity";
import { IdentitySyncStatus, VerificationStatus } from "../../../../src/app/doctors/enums";
import type { AuditRecorder } from "../../../../src/lib/audit/audit";
import type { IdentityClient } from "../../../../src/lib/identity-client/identity-client";
import { getEnv } from "../../../../src/lib/config/env";
import { logger } from "../../../../src/lib/logger/logger";

// Ported from tests/unit/app/verification/verification-service.test.ts (sync engine extraction, ADR 0021): bodies unchanged
// except for the repository spy targets and `processDueSyncJob` -> `processDue`.
const profile = (status: VerificationStatus, changes: Partial<DoctorProfile> = {}) => new DoctorProfile({ id: 1, userId: 202, verificationStatus: status,
    identitySyncStatus: IdentitySyncStatus.NotRequired, suspendedAt: null, submittedAt: null, ...changes });

describe("identity sync engine (verification jobs)", () => {
    const audit = { record: jest.fn().mockResolvedValue(undefined) } as unknown as AuditRecorder;
    const identity = { setUserStatus: jest.fn(), getUsersBatch: jest.fn().mockResolvedValue({ users: new Map(), degraded: true }) } as unknown as IdentityClient;
    const update = jest.fn().mockResolvedValue(1);
    const whereNull = jest.fn(() => ({ update }));
    const where = jest.fn(() => ({ whereNull, update }));
    const trx = Object.assign(jest.fn(() => ({ where, update })), { fn: { now: () => new Date() } });
    const db = Object.assign(jest.fn(() => ({ where, update })), { transaction: jest.fn(async (work: (t: Knex.Transaction) => Promise<unknown>) => work(trx as unknown as Knex.Transaction)) });
    const identitySync = new IdentitySyncService(db as unknown as Knex, audit, identity, getEnv(), { now: () => Date.now(), random: () => Math.random() });

    beforeEach(() => { jest.restoreAllMocks(); jest.clearAllMocks(); });

    const syncJob = (changes: Partial<NonNullable<Awaited<ReturnType<typeof syncRepo.findSyncJob>>>> = {}) => ({ id: 9, doctor_profile_id: 1, doctor_user_id: 202, kind: "verification", status: "pending", target_status: "active", reason: "synthetic reason",
        actor_user_id: 303, request_id: "synthetic-request", attempts: 0, consecutive_failures: 0, next_attempt_at: new Date(Date.now() - 1000), created_at: new Date(), updated_at: new Date(), ...changes }) as NonNullable<Awaited<ReturnType<typeof syncRepo.findSyncJob>>>;
    const lockPassesThrough = () => jest.spyOn(locks, "withSessionAdvisoryLock").mockImplementation(async (_db, _namespace, _id, work) => work());

    it.each([
        ["applied", "succeeded", "synced"],
        ["rejected-transition", "failed", "failed"],
        ["transient", "pending", "pending"],
    ] as const)("identityFailurePolicyDistinguishes409: should record %s outcome as %s", async (outcome, jobStatus, profileStatus) => {
        const job = { id: 9, doctor_profile_id: 1, doctor_user_id: 202, kind: "verification", status: "pending", target_status: "active", reason: "synthetic reason",
            actor_user_id: 303, request_id: "synthetic-request", attempts: 0, consecutive_failures: 0, next_attempt_at: new Date(Date.now() - 1000), created_at: new Date(), updated_at: new Date() } as Awaited<ReturnType<typeof syncRepo.findSyncJob>>;
        jest.spyOn(locks, "withSessionAdvisoryLock").mockImplementation(async (_db, _namespace, _id, work) => work());
        jest.spyOn(syncRepo, "findSyncJob").mockResolvedValue(job);
        jest.spyOn(syncRepo, "findPendingSyncJob").mockResolvedValue(job);
        jest.spyOn(syncRepo, "findProfileForSync").mockResolvedValue(profile(VerificationStatus.Approved, { identitySyncStatus: IdentitySyncStatus.Pending }));
        const updateJob = jest.spyOn(syncRepo, "updateSyncJob").mockResolvedValue(undefined);
        if (outcome === "transient") jest.mocked(identity.setUserStatus).mockResolvedValue({ outcome, errorCode: "HTTP_503" });
        else jest.mocked(identity.setUserStatus).mockResolvedValue({ outcome });
        const before = Date.now();
        await identitySync.processDue(9);
        if (outcome !== "transient") expect(updateJob).toHaveBeenCalledWith(9, expect.objectContaining({ status: jobStatus }), expect.anything());
        if (outcome !== "transient") expect(update).toHaveBeenCalledWith(expect.objectContaining({ identity_sync_status: profileStatus }));
        else {
            expect(updateJob).toHaveBeenCalledWith(9, expect.objectContaining({ next_attempt_at: expect.any(Date) }), expect.anything());
            const scheduled = updateJob.mock.calls[0]?.[1].next_attempt_at;
            expect(scheduled?.getTime()).toBeGreaterThanOrEqual(before + 160);
            expect(scheduled?.getTime()).toBeLessThanOrEqual(Date.now() + 240);
        }
    });

    it("staleSyncResultCannotMarkNewDecisionSynced: should skip a superseded job", async () => {
        jest.spyOn(syncRepo, "findSyncJob").mockResolvedValue({ id: 1, kind: "verification", status: "superseded" } as Awaited<ReturnType<typeof syncRepo.findSyncJob>>);
        await identitySync.processDue(1);
        expect(identity.setUserStatus).not.toHaveBeenCalled();
    });

    it("twoWorkersHonourBackoff: should not call Identity for a job whose next attempt is still in the future", async () => {
        lockPassesThrough();
        const job = syncJob({ next_attempt_at: new Date(Date.now() + 30_000), attempts: 1 });
        jest.spyOn(syncRepo, "findSyncJob").mockResolvedValue(job);
        jest.spyOn(syncRepo, "findPendingSyncJob").mockResolvedValue(job);
        await identitySync.processDue(9);
        expect(identity.setUserStatus).not.toHaveBeenCalled();
    });

    it("alertLogsCarryIds: should log job and profile ids with the transition-rejected alert", async () => {
        lockPassesThrough();
        const job = syncJob();
        jest.spyOn(syncRepo, "findSyncJob").mockResolvedValue(job);
        jest.spyOn(syncRepo, "findPendingSyncJob").mockResolvedValue(job);
        jest.spyOn(syncRepo, "findProfileForSync").mockResolvedValue(profile(VerificationStatus.Approved, { identitySyncStatus: IdentitySyncStatus.Pending }));
        jest.spyOn(syncRepo, "updateSyncJob").mockResolvedValue(undefined);
        const error = jest.spyOn(logger, "error").mockImplementation(() => undefined);
        jest.mocked(identity.setUserStatus).mockResolvedValue({ outcome: "rejected-transition" });
        await identitySync.processDue(9);
        expect(error).toHaveBeenCalledWith("IdentitySyncTransitionRejected", { code: "InvalidStatusTransition", kind: "verification", jobId: 9, profileId: 1 });
    });

    it("alertLogsCarryIds: should log job and profile ids with the unsynced-too-long alert", async () => {
        lockPassesThrough();
        const old = new Date(Date.now() - 3_600_000);
        const job = syncJob({ created_at: old, updated_at: old });
        jest.spyOn(syncRepo, "findSyncJob").mockResolvedValue(job);
        jest.spyOn(syncRepo, "findPendingSyncJob").mockResolvedValue(job);
        jest.spyOn(syncRepo, "findProfileForSync").mockResolvedValue(profile(VerificationStatus.Approved, { identitySyncStatus: IdentitySyncStatus.Pending }));
        jest.spyOn(syncRepo, "updateSyncJob").mockResolvedValue(undefined);
        const error = jest.spyOn(logger, "error").mockImplementation(() => undefined);
        jest.mocked(identity.setUserStatus).mockResolvedValue({ outcome: "transient", errorCode: "HTTP_503" });
        await identitySync.processDue(9);
        expect(error).toHaveBeenCalledWith("IdentityApprovalSyncPending", { kind: "verification", jobId: 9, profileId: 1 });
    });
});
