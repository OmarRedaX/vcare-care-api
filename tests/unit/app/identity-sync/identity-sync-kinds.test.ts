import type { Knex } from "knex";
import { DoctorProfile } from "../../../../src/app/doctors/entity/doctor-profile.entity";
import { IdentitySyncStatus, VerificationStatus } from "../../../../src/app/doctors/enums";
import { IdentitySyncJobKind, IdentitySyncJobStatus } from "../../../../src/app/identity-sync/enums";
import * as syncRepo from "../../../../src/app/identity-sync/repository/identity-sync.repo";
import { IdentitySyncService } from "../../../../src/app/identity-sync/service/identity-sync.service";
import type { IdentitySyncJobRow } from "../../../../src/app/identity-sync/types";
import { backoffMs } from "../../../../src/lib/async/backoff";
import type { AuditRecorder } from "../../../../src/lib/audit/audit";
import { getEnv } from "../../../../src/lib/config/env";
import type { IdentityClient } from "../../../../src/lib/identity-client/identity-client";
import * as locks from "../../../../src/lib/knex/session-advisory-lock";
import { logger } from "../../../../src/lib/logger/logger";
import type { AuthContext } from "../../../../src/lib/types/types";
import { FakeClock } from "../../../helpers/fake-clock";

const TARGET = { verification: "active", suspension: "suspended", reinstatement: "active" } as const;
const KINDS = [IdentitySyncJobKind.Verification, IdentitySyncJobKind.Suspension, IdentitySyncJobKind.Reinstatement] as const;
const admin = { userId: 303, role: "admin", status: "active", emailVerified: true } as AuthContext;
const START = Date.UTC(2026, 9, 9, 12, 0, 0);
const EMOJI = String.fromCodePoint(0x1f600);

describe("identity sync engine (per job kind)", () => {
    const clock = new FakeClock(START);
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const identity = { setUserStatus: jest.fn() };
    const trx = {} as Knex.Transaction;
    const db = { transaction: jest.fn(async (work: (t: Knex.Transaction) => Promise<unknown>) => work(trx)) };
    const service = new IdentitySyncService(db as unknown as Knex, audit as unknown as AuditRecorder, identity as unknown as IdentityClient, getEnv(), clock);

    const job = (kind: IdentitySyncJobKind, changes: Partial<IdentitySyncJobRow> = {}): IdentitySyncJobRow => ({ id: 9, doctor_profile_id: 1, doctor_user_id: 202, kind,
        target_status: TARGET[kind], reason: "synthetic reason", actor_user_id: 303, request_id: "synthetic-request", status: "pending", attempts: 0, consecutive_failures: 0,
        last_error_code: null, next_attempt_at: new Date(clock.now() - 1000), succeeded_at: null, created_at: new Date(clock.now()), updated_at: new Date(clock.now()), ...changes } as IdentitySyncJobRow);
    const profile = (changes: Partial<DoctorProfile> = {}) => new DoctorProfile({ id: 1, userId: 202, verificationStatus: VerificationStatus.Approved,
        identitySyncStatus: IdentitySyncStatus.Pending, suspendedAt: null, submittedAt: null, ...changes });

    function arrange(row: IdentitySyncJobRow) {
        jest.spyOn(locks, "withSessionAdvisoryLock").mockImplementation(async (_db, _namespace, _id, work) => work());
        jest.spyOn(syncRepo, "findSyncJob").mockResolvedValue(row);
        jest.spyOn(syncRepo, "findPendingSyncJob").mockResolvedValue(row);
        jest.spyOn(syncRepo, "findProfileForSync").mockResolvedValue(profile());
        return { update: jest.spyOn(syncRepo, "updateSyncJob").mockResolvedValue(undefined), setProfile: jest.spyOn(syncRepo, "setProfileIdentitySync").mockResolvedValue(undefined) };
    }

    beforeEach(() => {
        jest.restoreAllMocks(); jest.clearAllMocks(); clock.set(START);
        audit.record.mockResolvedValue(undefined);
        identity.setUserStatus.mockResolvedValue({ outcome: "applied" });
    });

    describe("processDue", () => {
        it.each(KINDS)("should send the %s job's target status to Identity (no kind filter)", async (kind) => {
            const { setProfile } = arrange(job(kind));
            await service.processDue(9);
            expect(identity.setUserStatus).toHaveBeenCalledWith(202, TARGET[kind], "synthetic reason", 303, "synthetic-request", 1);
            expect(setProfile).toHaveBeenCalledWith(1, IdentitySyncStatus.Synced, trx);
        });

        it.each([IdentitySyncJobStatus.Succeeded, IdentitySyncJobStatus.Failed, IdentitySyncJobStatus.Superseded])("should ignore a %s job", async (status) => {
            arrange(job(IdentitySyncJobKind.Suspension, { status }));
            await service.processDue(9);
            expect(identity.setUserStatus).not.toHaveBeenCalled();
        });

        it("should ignore a job that no longer exists", async () => {
            arrange(job(IdentitySyncJobKind.Suspension));
            jest.spyOn(syncRepo, "findSyncJob").mockResolvedValue(undefined);
            await service.processDue(9);
            expect(identity.setUserStatus).not.toHaveBeenCalled();
        });

        it.each(KINDS)("should honour a future next_attempt_at of a %s job until the clock reaches it", async (kind) => {
            arrange(job(kind, { attempts: 1, next_attempt_at: new Date(clock.now() + 30_000) }));
            await service.processDue(9);
            expect(identity.setUserStatus).not.toHaveBeenCalled();
            clock.advance(30_000);
            await service.processDue(9);
            expect(identity.setUserStatus).toHaveBeenCalledTimes(1);
        });
    });

    describe("listDueJobIds", () => {
        it("should pass the injected clock as now and keep the repository order (suspension first)", async () => {
            const list = jest.spyOn(syncRepo, "listDuePendingJobs").mockResolvedValue([job(IdentitySyncJobKind.Suspension, { id: 4 }), job(IdentitySyncJobKind.Verification, { id: 2 }), job(IdentitySyncJobKind.Reinstatement, { id: 3 })]);
            await expect(service.listDueJobIds(50)).resolves.toEqual([4, 2, 3]);
            expect(list).toHaveBeenCalledWith(50, new Date(START), expect.anything());
            clock.advance(5000);
            await service.listDueJobIds(10);
            expect(list).toHaveBeenLastCalledWith(10, new Date(START + 5000), expect.anything());
        });
    });

    describe("enqueue", () => {
        it.each(KINDS)("should insert a pending %s job due at the injected clock inside the caller's transaction", async (kind) => {
            const insert = jest.spyOn(syncRepo, "insertSyncJob").mockResolvedValue(job(kind));
            await service.enqueue(trx, { profile: { id: 1, userId: 202 }, kind, targetStatus: TARGET[kind], reason: "synthetic reason", actorUserId: 303, requestId: "synthetic-request" });
            expect(insert).toHaveBeenCalledWith({ doctor_profile_id: 1, doctor_user_id: 202, kind, target_status: TARGET[kind], reason: "synthetic reason", actor_user_id: 303,
                request_id: "synthetic-request", status: "pending", next_attempt_at: new Date(START) }, trx);
        });
    });

    describe("suspension alert (page)", () => {
        const failing = async (consecutiveBefore: number) => {
            arrange(job(IdentitySyncJobKind.Suspension, { consecutive_failures: consecutiveBefore, attempts: consecutiveBefore }));
            identity.setUserStatus.mockResolvedValue({ outcome: "transient", errorCode: "HTTP_503" });
            const error = jest.spyOn(logger, "error").mockImplementation(() => undefined);
            await service.processDue(9);
            return error;
        };

        it.each([[2, 3], [12, 13], [22, 23]])("should log IdentitySuspensionSyncFailing when the consecutive failure count goes %i -> %i", async (before, now) => {
            const error = await failing(before);
            expect(error).toHaveBeenCalledWith("IdentitySuspensionSyncFailing", { kind: "suspension", jobId: 9, profileId: 1, consecutiveFailures: now, lastErrorCode: "HTTP_503" });
        });

        it.each([[0], [1], [3], [11], [13]])("should not alert when the consecutive failure count goes %i -> %i", async (before) => {
            const error = await failing(before);
            expect(error).not.toHaveBeenCalled();
        });

        it("should not alert on elapsed time alone", async () => {
            arrange(job(IdentitySyncJobKind.Suspension, { created_at: new Date(START - 7 * 86_400_000), updated_at: new Date(START - 7 * 86_400_000) }));
            identity.setUserStatus.mockResolvedValue({ outcome: "transient", errorCode: "HTTP_503" });
            const error = jest.spyOn(logger, "error").mockImplementation(() => undefined);
            await service.processDue(9);
            expect(error).not.toHaveBeenCalled();
        });

        it("should reset consecutive failures on success and raise no alert", async () => {
            const { update } = arrange(job(IdentitySyncJobKind.Suspension, { consecutive_failures: 7, attempts: 7 }));
            const error = jest.spyOn(logger, "error").mockImplementation(() => undefined);
            await service.processDue(9);
            expect(update).toHaveBeenCalledWith(9, expect.objectContaining({ status: "succeeded", consecutive_failures: 0, attempts: 8, succeeded_at: new Date(START) }), trx);
            expect(error).not.toHaveBeenCalled();
        });
    });

    describe("unsynced-too-long alert (ticket)", () => {
        const failing = async (kind: IdentitySyncJobKind, changes: Partial<IdentitySyncJobRow> = {}) => {
            arrange(job(kind, changes));
            identity.setUserStatus.mockResolvedValue({ outcome: "transient", errorCode: "HTTP_503" });
            const error = jest.spyOn(logger, "error").mockImplementation(() => undefined);
            await service.processDue(9);
            return error;
        };

        it("should not log IdentityReinstatementSyncPending before 900 s of fake time", async () => {
            clock.set(START + 899_999);
            const early = await failing(IdentitySyncJobKind.Reinstatement, { created_at: new Date(START), updated_at: new Date(START) });
            expect(early).not.toHaveBeenCalled();
        });

        it("should log IdentityReinstatementSyncPending at 900 s of fake time", async () => {
            clock.set(START + 900_000);
            const due = await failing(IdentitySyncJobKind.Reinstatement, { created_at: new Date(START), updated_at: new Date(START + 1000) });
            expect(due).toHaveBeenCalledWith("IdentityReinstatementSyncPending", { kind: "reinstatement", jobId: 9, profileId: 1 });
        });

        it("should not repeat the alert once a previous attempt already crossed the window", async () => {
            clock.set(START + 1_800_000);
            const error = await failing(IdentitySyncJobKind.Reinstatement, { created_at: new Date(START), updated_at: new Date(START + 901_000) });
            expect(error).not.toHaveBeenCalled();
        });

        it("should keep IdentityApprovalSyncPending for verification jobs", async () => {
            clock.set(START + 901_000);
            const error = await failing(IdentitySyncJobKind.Verification, { created_at: new Date(START), updated_at: new Date(START) });
            expect(error).toHaveBeenCalledWith("IdentityApprovalSyncPending", { kind: "verification", jobId: 9, profileId: 1 });
        });
    });

    describe("Identity 409", () => {
        it.each(KINDS)("should fail the %s job and the profile, audit identity_sync.failed as system and log the kind", async (kind) => {
            const { update, setProfile } = arrange(job(kind, { attempts: 2 }));
            identity.setUserStatus.mockResolvedValue({ outcome: "rejected-transition" });
            const error = jest.spyOn(logger, "error").mockImplementation(() => undefined);
            await service.processDue(9);
            expect(update).toHaveBeenCalledWith(9, { status: "failed", attempts: 3, last_error_code: "InvalidStatusTransition" }, trx);
            expect(setProfile).toHaveBeenCalledWith(1, IdentitySyncStatus.Failed, trx);
            expect(audit.record).toHaveBeenCalledWith(trx, { actor: { kind: "system" }, action: "identity_sync.failed", entityType: "doctor_profile", entityId: 1, metadata: { jobId: 9 } });
            expect(error).toHaveBeenCalledWith("IdentitySyncTransitionRejected", { code: "InvalidStatusTransition", kind, jobId: 9, profileId: 1 });
        });

        it.each(KINDS)("should not call Identity again for a %s job that already failed", async (kind) => {
            arrange(job(kind, { status: IdentitySyncJobStatus.Failed }));
            await service.processDue(9); await service.processDue(9);
            expect(identity.setUserStatus).not.toHaveBeenCalled();
        });
    });

    describe("transient failure", () => {
        it.each(KINDS)("should schedule the next %s attempt from the fake clock and count the failure", async (kind) => {
            const { update, setProfile } = arrange(job(kind, { attempts: 2, consecutive_failures: 1 }));
            identity.setUserStatus.mockResolvedValue({ outcome: "transient", errorCode: "HTTP_503" });
            jest.spyOn(logger, "error").mockImplementation(() => undefined);
            await service.processDue(9);
            const delay = backoffMs(2, () => 0.5, getEnv().IDENTITY_SYNC_RETRY_CAP_SECONDS * 1000);
            expect(update).toHaveBeenCalledWith(9, { attempts: 3, consecutive_failures: 2, last_error_code: "HTTP_503", next_attempt_at: new Date(START + delay), updated_at: new Date(START) }, trx);
            expect(setProfile).not.toHaveBeenCalled();
        });

        it("should cap the backoff at IDENTITY_SYNC_RETRY_CAP_SECONDS", async () => {
            const { update } = arrange(job(IdentitySyncJobKind.Suspension, { attempts: 40, consecutive_failures: 20 }));
            identity.setUserStatus.mockResolvedValue({ outcome: "transient", errorCode: "NetworkError" });
            jest.spyOn(logger, "error").mockImplementation(() => undefined);
            await service.processDue(9);
            expect(update).toHaveBeenCalledWith(9, expect.objectContaining({ next_attempt_at: new Date(START + getEnv().IDENTITY_SYNC_RETRY_CAP_SECONDS * 1000) }), trx);
        });

        it.each([[0, 1], [3, 0], [1, 0]])("should audit identity_sync.pending only when attempts_before is 0 (attempts_before=%i -> %i audit rows)", async (before, rows) => {
            arrange(job(IdentitySyncJobKind.Suspension, { attempts: before }));
            identity.setUserStatus.mockResolvedValue({ outcome: "transient", errorCode: "HTTP_503" });
            jest.spyOn(logger, "error").mockImplementation(() => undefined);
            await service.processDue(9);
            expect(audit.record).toHaveBeenCalledTimes(rows);
            if (rows) expect(audit.record).toHaveBeenCalledWith(trx, expect.objectContaining({ action: "identity_sync.pending", actor: { kind: "system" }, metadata: { jobId: 9 } }));
        });
    });

    describe("stale and superseded jobs", () => {
        it.each(KINDS)("should mark a %s job superseded and never send it when another job is the profile's open one", async (kind) => {
            const { update, setProfile } = arrange(job(kind));
            jest.spyOn(syncRepo, "findPendingSyncJob").mockResolvedValue(job(IdentitySyncJobKind.Suspension, { id: 10 }));
            await service.processDue(9);
            expect(update).toHaveBeenCalledWith(9, { status: "superseded" }, expect.anything());
            expect(identity.setUserStatus).not.toHaveBeenCalled();
            expect(setProfile).not.toHaveBeenCalled();
        });

        it.each(KINDS)("should not record the result of a %s job that was superseded while Identity was being called", async (kind) => {
            const { update, setProfile } = arrange(job(kind));
            jest.spyOn(syncRepo, "findPendingSyncJob").mockResolvedValueOnce(job(kind)).mockResolvedValueOnce(job(IdentitySyncJobKind.Reinstatement, { id: 11 }));
            await service.processDue(9);
            expect(identity.setUserStatus).toHaveBeenCalledTimes(1);
            expect(update).toHaveBeenCalledWith(9, { status: "superseded" }, trx);
            expect(setProfile).not.toHaveBeenCalled();
            expect(audit.record).not.toHaveBeenCalled();
        });

        it.each(KINDS)("should report locked:false as 202 pending for a %s job when the doctor lock is not obtained", async (kind) => {
            arrange(job(kind));
            jest.spyOn(locks, "withSessionAdvisoryLock").mockResolvedValue(undefined);
            const report = await service.syncNow(9, admin, 3);
            expect(report).toMatchObject({ status: 202, identitySync: "pending" });
            expect(identity.setUserStatus).not.toHaveBeenCalled();
        });
    });

    describe("syncNow", () => {
        it.each([
            [IdentitySyncStatus.Synced, 200, undefined], [IdentitySyncStatus.Failed, 202, "failed"], [IdentitySyncStatus.Pending, 202, "pending"],
        ] as const)("should report a profile left %s as status %i", async (profileStatus, status, identitySync) => {
            arrange(job(IdentitySyncJobKind.Suspension));
            jest.spyOn(syncRepo, "findProfileForSync").mockResolvedValue(profile({ identitySyncStatus: profileStatus }));
            const report = await service.syncNow(9, admin, 3);
            expect(report.status).toBe(status); expect(report.identitySync).toBe(identitySync);
        });

        it.each(KINDS)("should send %s with the requested inline attempts and audit the result as the acting admin", async (kind) => {
            arrange(job(kind));
            await service.syncNow(9, admin, 3);
            expect(identity.setUserStatus).toHaveBeenCalledWith(202, TARGET[kind], "synthetic reason", 303, "synthetic-request", 3);
            expect(audit.record).toHaveBeenCalledWith(trx, expect.objectContaining({ action: "identity_sync.synced", actor: { kind: "user", userId: 303, role: "admin" } }));
        });

        it("should send a job even when its next_attempt_at is in the future (the inline path is not due-gated)", async () => {
            arrange(job(IdentitySyncJobKind.Suspension, { next_attempt_at: new Date(START + 60_000) }));
            await service.syncNow(9, admin, 3);
            expect(identity.setUserStatus).toHaveBeenCalledTimes(1);
        });
    });

    describe("Identity-bound reason clamp (500 code points)", () => {
        const sent = async (reason: string | null, kind: IdentitySyncJobKind = IdentitySyncJobKind.Suspension): Promise<string> => {
            identity.setUserStatus.mockClear();
            arrange(job(kind, { reason }));
            await service.processDue(9);
            return identity.setUserStatus.mock.calls[0]?.[2] as string;
        };

        it.each(KINDS)("should clamp a 600 character %s reason to exactly 500 code points", async (kind) => {
            const result = await sent("a".repeat(600), kind);
            expect([...result]).toHaveLength(500); expect(result).toBe("a".repeat(500));
        });

        it("should never split a surrogate pair when clamping an emoji reason", async () => {
            const result = await sent(EMOJI.repeat(600));
            expect([...result]).toHaveLength(500); expect(result.length).toBe(1000);
            expect(result).toBe(EMOJI.repeat(500));
        });

        it("should clamp at a pair that straddles the 500th UTF-16 unit", async () => {
            const result = await sent(`${"a".repeat(499)}${EMOJI}tail`);
            expect(result).toBe(`${"a".repeat(499)}${EMOJI}`); expect([...result]).toHaveLength(500);
        });

        it("should pass a reason of 500 or fewer code points untouched", async () => {
            expect(await sent("b".repeat(500))).toBe("b".repeat(500));
            expect(await sent("short reason")).toBe("short reason");
        });

        it.each(KINDS)("should fall back to the kind %s when the job has no reason", async (kind) => {
            expect(await sent(null, kind)).toBe(kind);
        });
    });
});
