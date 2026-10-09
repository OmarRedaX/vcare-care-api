/* eslint-disable @typescript-eslint/unbound-method */
import type { Knex } from "knex";
import * as repo from "../../../../src/app/admin-doctors/repository/admin-doctors.repo";
import { AdminDoctorsService } from "../../../../src/app/admin-doctors/service/admin-doctors.service";
import { DoctorProfile } from "../../../../src/app/doctors/entity/doctor-profile.entity";
import { IdentitySyncStatus, VerificationStatus } from "../../../../src/app/doctors/enums";
import type { IdentitySyncService } from "../../../../src/app/identity-sync/service/identity-sync.service";
import type { AuditRecorder } from "../../../../src/lib/audit/audit";
import { logger } from "../../../../src/lib/logger/logger";
import type { AuthContext } from "../../../../src/lib/types/types";
import { FakeClock } from "../../../helpers/fake-clock";

const admin = { userId: 303, role: "admin", status: "active", emailVerified: true } as AuthContext;
const START = Date.UTC(2026, 9, 9, 12, 0, 0);
const SUSPENDED_AT = new Date(START - 60_000);
const REASON = "SYNTHETIC-REASON-9001 needs review";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const profile = (changes: Partial<DoctorProfile> = {}) => new DoctorProfile({ id: 9, userId: 202, verificationStatus: VerificationStatus.Approved,
    identitySyncStatus: IdentitySyncStatus.Synced, suspendedAt: null, submittedAt: null, ...changes });

describe("AdminDoctorsService", () => {
    const clock = new FakeClock(START);
    const order: string[] = [];
    let transactionSettled = false;
    const trx = {} as Knex.Transaction;
    const db = { transaction: jest.fn(async (work: (t: Knex.Transaction) => Promise<unknown>) => { order.push("begin"); const result = await work(trx); order.push("commit"); transactionSettled = true; return result; }) };
    const audit = { record: jest.fn((_trx: unknown, entry: { action: string }) => { order.push(`audit:${entry.action}`); return Promise.resolve(); }) };
    const identitySync = { supersedeOpen: jest.fn(), enqueue: jest.fn(), syncNow: jest.fn(), findLatestJob: jest.fn() };
    const impact = { flagFutureConsultations: jest.fn(), listFlaggedConsultations: jest.fn() };
    const service = new AdminDoctorsService(db as unknown as Knex, audit as unknown as AuditRecorder, identitySync as unknown as IdentitySyncService, impact, clock);
    let lock: jest.SpiedFunction<typeof repo.lockProfileByUserId>;
    let apply: jest.SpiedFunction<typeof repo.applySuspension>;
    let clear: jest.SpiedFunction<typeof repo.clearSuspension>;
    const noWrites = () => {
        expect(apply).not.toHaveBeenCalled(); expect(clear).not.toHaveBeenCalled(); expect(identitySync.enqueue).not.toHaveBeenCalled();
        expect(identitySync.supersedeOpen).not.toHaveBeenCalled(); expect(identitySync.syncNow).not.toHaveBeenCalled();
        expect(audit.record).not.toHaveBeenCalled(); expect(impact.flagFutureConsultations).not.toHaveBeenCalled();
    };
    const report = (status: IdentitySyncStatus, http: 200 | 202 = status === IdentitySyncStatus.Synced ? 200 : 202) =>
        ({ profile: profile({ identitySyncStatus: status }), status: http, identitySync: http === 202 ? status : undefined });

    beforeEach(() => {
        jest.restoreAllMocks(); jest.clearAllMocks(); clock.set(START); order.length = 0; transactionSettled = false;
        lock = jest.spyOn(repo, "lockProfileByUserId").mockImplementation(() => { order.push("lock"); return Promise.resolve(profile()); });
        apply = jest.spyOn(repo, "applySuspension").mockImplementation(() => { order.push("apply"); return Promise.resolve(SUSPENDED_AT); });
        clear = jest.spyOn(repo, "clearSuspension").mockImplementation(() => { order.push("clear"); return Promise.resolve(SUSPENDED_AT); });
        identitySync.supersedeOpen.mockImplementation(() => { order.push("supersede"); return Promise.resolve(); });
        identitySync.enqueue.mockImplementation(() => { order.push("enqueue"); return Promise.resolve({ id: 77 }); });
        identitySync.syncNow.mockImplementation(() => { order.push(`syncNow:settled=${String(transactionSettled)}`); return Promise.resolve(report(IdentitySyncStatus.Synced)); });
        identitySync.findLatestJob.mockResolvedValue(undefined);
        impact.flagFutureConsultations.mockImplementation(() => { order.push("flag"); return Promise.resolve([]); });
        impact.listFlaggedConsultations.mockResolvedValue([]);
        jest.spyOn(logger, "info").mockImplementation(() => undefined);
        jest.spyOn(logger, "metric").mockImplementation(() => undefined);
    });

    describe("suspend", () => {
        it("should throw NotFound when no live profile has that Identity user id", async () => {
            lock.mockResolvedValueOnce(undefined);
            await expect(service.suspend(admin, 999, REASON)).rejects.toMatchObject({ code: "NotFound" });
            noWrites();
        });

        it.each([
            ["draft", VerificationStatus.Draft, IdentitySyncStatus.NotRequired],
            ["submitted", VerificationStatus.Submitted, IdentitySyncStatus.NotRequired],
            ["rejected", VerificationStatus.Rejected, IdentitySyncStatus.Synced],
            ["approved with a pending sync", VerificationStatus.Approved, IdentitySyncStatus.Pending],
            ["approved with a failed sync", VerificationStatus.Approved, IdentitySyncStatus.Failed],
            ["approved with sync not_required", VerificationStatus.Approved, IdentitySyncStatus.NotRequired],
        ])("should throw InvalidTransition and write nothing for a %s profile", async (_label, verification, sync) => {
            lock.mockResolvedValueOnce(profile({ verificationStatus: verification, identitySyncStatus: sync }));
            await expect(service.suspend(admin, 202, REASON)).rejects.toMatchObject({ code: "InvalidTransition", status: 409 });
            noWrites();
        });

        it("should run lock, supersede, apply, flag, enqueue and audit in one transaction, then sync after it committed", async () => {
            const outcome = await service.suspend(admin, 202, REASON);
            expect(db.transaction).toHaveBeenCalledTimes(1);
            expect(order).toEqual(["begin", "lock", "supersede", "apply", "flag", "enqueue", "audit:doctor.suspended", "commit", "syncNow:settled=true"]);
            expect(outcome.confirmed).toBe(true);
        });

        it("should hand the decision to the engine with the full reason, the admin and a request id", async () => {
            await service.suspend(admin, 202, REASON);
            expect(repo.applySuspension).toHaveBeenCalledWith(9, 303, REASON, trx);
            expect(identitySync.supersedeOpen).toHaveBeenCalledWith(9, trx);
            expect(identitySync.enqueue).toHaveBeenCalledWith(trx, expect.objectContaining({ kind: "suspension", targetStatus: "suspended", reason: REASON, actorUserId: 303 }));
            expect((identitySync.enqueue.mock.calls[0]?.[1] as { requestId: string }).requestId).toMatch(UUID);
            expect(identitySync.enqueue.mock.calls[0]?.[1]).toHaveProperty("profile.id", 9);
        });

        it("should call syncNow with the job id, the actor and exactly 3 inline attempts", async () => {
            await service.suspend(admin, 202, REASON);
            expect(identitySync.syncNow).toHaveBeenCalledWith(77, admin, 3);
        });

        it("should audit doctor.suspended on the profile with ids, statuses and reasonLength only", async () => {
            await service.suspend(admin, 202, "résumé reason");
            expect(audit.record).toHaveBeenCalledTimes(1);
            expect(audit.record).toHaveBeenCalledWith(trx, { actor: { kind: "user", userId: 303, role: "admin" }, action: "doctor.suspended", entityType: "doctor_profile", entityId: 9,
                metadata: { doctorUserId: 202, jobId: 77, flaggedCount: 0, reasonLength: 13, fromSyncStatus: "synced", toSyncStatus: "pending" } });
        });

        it("should count the reason in code points for reasonLength", async () => {
            await service.suspend(admin, 202, String.fromCodePoint(0x1f600).repeat(5));
            expect(audit.record.mock.calls[0]?.[1]).toMatchObject({ metadata: { reasonLength: 5 } });
        });

        it("should never put the reason text into audit metadata or logs", async () => {
            await service.suspend(admin, 202, REASON);
            expect(JSON.stringify(audit.record.mock.calls)).not.toContain("SYNTHETIC-REASON-9001");
            expect(JSON.stringify(jest.mocked(logger.info).mock.calls)).not.toContain("SYNTHETIC-REASON-9001");
            expect(JSON.stringify(jest.mocked(logger.metric).mock.calls)).not.toContain("SYNTHETIC-REASON-9001");
        });

        it("should audit one consultation.flagged_for_followup row per flagged id on entity consultation after the profile row", async () => {
            impact.flagFutureConsultations.mockResolvedValueOnce([11, 12]);
            const outcome = await service.suspend(admin, 202, REASON);
            const actions = audit.record.mock.calls.map((call) => call[1] as { action: string; entityType: string; entityId: number; metadata: Record<string, unknown> });
            expect(actions.map((a) => [a.action, a.entityType, a.entityId])).toEqual([["doctor.suspended", "doctor_profile", 9], ["consultation.flagged_for_followup", "consultation", 11], ["consultation.flagged_for_followup", "consultation", 12]]);
            expect(actions[0]?.metadata.flaggedCount).toBe(2);
            expect(actions[1]?.metadata).toEqual({ doctorProfileId: 9, followupReason: "doctor_suspended" });
            expect(outcome.view.flaggedConsultationIds).toEqual([11, 12]);
        });

        it("should call the flag port with the profile, the Identity user id, the fake clock and the transaction", async () => {
            await service.suspend(admin, 202, REASON);
            expect(impact.flagFutureConsultations).toHaveBeenCalledWith({ doctorProfileId: 9, doctorUserId: 202, now: new Date(START) }, trx);
        });

        it("should propagate an audit failure and never reach Identity", async () => {
            audit.record.mockRejectedValueOnce(new Error("audit_down"));
            await expect(service.suspend(admin, 202, REASON)).rejects.toThrow("audit_down");
            expect(order).not.toContain("commit");
            expect(identitySync.syncNow).not.toHaveBeenCalled();
        });

        it("should propagate a flag port failure before the job is enqueued and never reach Identity", async () => {
            impact.flagFutureConsultations.mockRejectedValueOnce(new Error("port_down"));
            await expect(service.suspend(admin, 202, REASON)).rejects.toThrow("port_down");
            expect(identitySync.enqueue).not.toHaveBeenCalled();
            expect(audit.record).not.toHaveBeenCalled();
            expect(identitySync.syncNow).not.toHaveBeenCalled();
        });

        it("should propagate a job insert failure and never reach Identity", async () => {
            identitySync.enqueue.mockRejectedValueOnce(new Error("insert_failed"));
            await expect(service.suspend(admin, 202, REASON)).rejects.toThrow("insert_failed");
            expect(audit.record).not.toHaveBeenCalled();
            expect(identitySync.syncNow).not.toHaveBeenCalled();
        });

        it("should return the committed suspended_at and the confirmed view when Identity answered", async () => {
            const outcome = await service.suspend(admin, 202, REASON);
            expect(outcome).toEqual({ view: { doctorUserId: 202, suspendedAt: SUSPENDED_AT, identitySyncStatus: "synced", flaggedConsultationIds: [] }, confirmed: true });
        });

        it.each([
            ["pending", report(IdentitySyncStatus.Pending)],
            ["failed", report(IdentitySyncStatus.Failed)],
            ["pending because the doctor lock was not held", { profile: profile({ identitySyncStatus: IdentitySyncStatus.Pending }), status: 202 as const, identitySync: "pending" as const }],
        ])("should report not confirmed with the port's flagged ids when the sync is %s", async (_label, syncReport) => {
            impact.flagFutureConsultations.mockResolvedValueOnce([5]);
            identitySync.syncNow.mockResolvedValueOnce(syncReport);
            const outcome = await service.suspend(admin, 202, REASON);
            expect(outcome.confirmed).toBe(false);
            expect(outcome.view).toMatchObject({ identitySyncStatus: syncReport.profile.identitySyncStatus, flaggedConsultationIds: [5], suspendedAt: SUSPENDED_AT });
        });

        it("should not confirm a synced profile whose report is a 202 (lock not held)", async () => {
            identitySync.syncNow.mockResolvedValueOnce({ profile: profile({ identitySyncStatus: IdentitySyncStatus.Synced }), status: 202, identitySync: "pending" });
            expect((await service.suspend(admin, 202, REASON)).confirmed).toBe(false);
        });

        describe("already suspended (no-op)", () => {
            it.each([
                [IdentitySyncStatus.Synced, true],
                [IdentitySyncStatus.Pending, false],
                [IdentitySyncStatus.Failed, false],
            ])("should confirm only when the sync is synced (sync=%s -> confirmed=%s) and write nothing", async (sync, confirmed) => {
                lock.mockResolvedValueOnce(profile({ suspendedAt: SUSPENDED_AT, identitySyncStatus: sync }));
                impact.listFlaggedConsultations.mockResolvedValueOnce([11, 12]);
                const outcome = await service.suspend(admin, 202, REASON);
                expect(outcome).toEqual({ confirmed, view: { doctorUserId: 202, suspendedAt: SUSPENDED_AT, identitySyncStatus: sync, flaggedConsultationIds: [11, 12] } });
                noWrites();
                expect(impact.listFlaggedConsultations).toHaveBeenCalledWith({ doctorProfileId: 9, doctorUserId: 202, now: new Date(START) }, trx);
            });

            it("should be a no-op even for a profile that is no longer approved", async () => {
                lock.mockResolvedValueOnce(profile({ suspendedAt: SUSPENDED_AT, verificationStatus: VerificationStatus.Rejected }));
                await expect(service.suspend(admin, 202, REASON)).resolves.toMatchObject({ confirmed: true });
                noWrites();
            });
        });
    });

    describe("reinstate", () => {
        const suspended = (sync: IdentitySyncStatus = IdentitySyncStatus.Synced) => profile({ suspendedAt: SUSPENDED_AT, identitySyncStatus: sync });

        it("should throw NotFound when no live profile has that Identity user id", async () => {
            lock.mockResolvedValueOnce(undefined);
            await expect(service.reinstate(admin, 999, REASON)).rejects.toMatchObject({ code: "NotFound" });
            noWrites();
        });

        it.each([IdentitySyncStatus.Pending, IdentitySyncStatus.Failed, IdentitySyncStatus.NotRequired])("should throw InvalidTransition and write nothing for a suspended profile whose sync is %s", async (sync) => {
            lock.mockResolvedValueOnce(suspended(sync));
            await expect(service.reinstate(admin, 202, REASON)).rejects.toMatchObject({ code: "InvalidTransition", status: 409 });
            noWrites();
        });

        it("should run lock, supersede, clear, enqueue and audit in one transaction, then sync after it committed", async () => {
            lock.mockImplementationOnce(() => { order.push("lock"); return Promise.resolve(suspended()); });
            await service.reinstate(admin, 202, REASON);
            expect(order).toEqual(["begin", "lock", "supersede", "clear", "enqueue", "audit:doctor.reinstated", "commit", "syncNow:settled=true"]);
        });

        it("should enqueue a reinstatement job targeting active and never call the flag port", async () => {
            lock.mockResolvedValueOnce(suspended());
            await service.reinstate(admin, 202, REASON);
            expect(identitySync.enqueue).toHaveBeenCalledWith(trx, expect.objectContaining({ kind: "reinstatement", targetStatus: "active", reason: REASON, actorUserId: 303 }));
            expect(impact.flagFutureConsultations).not.toHaveBeenCalled();
            expect(impact.listFlaggedConsultations).not.toHaveBeenCalled();
            expect(identitySync.syncNow).toHaveBeenCalledWith(77, admin, 3);
        });

        it("should audit doctor.reinstated with ids, statuses and reasonLength and no reason text", async () => {
            lock.mockResolvedValueOnce(suspended());
            await service.reinstate(admin, 202, REASON);
            expect(audit.record).toHaveBeenCalledTimes(1);
            expect(audit.record).toHaveBeenCalledWith(trx, { actor: { kind: "user", userId: 303, role: "admin" }, action: "doctor.reinstated", entityType: "doctor_profile", entityId: 9,
                metadata: { doctorUserId: 202, jobId: 77, reasonLength: [...REASON].length, fromSyncStatus: "synced", toSyncStatus: "pending" } });
            expect(JSON.stringify(audit.record.mock.calls)).not.toContain("SYNTHETIC-REASON-9001");
        });

        it("should propagate an audit failure and never reach Identity", async () => {
            lock.mockResolvedValueOnce(suspended());
            audit.record.mockRejectedValueOnce(new Error("audit_down"));
            await expect(service.reinstate(admin, 202, REASON)).rejects.toThrow("audit_down");
            expect(identitySync.syncNow).not.toHaveBeenCalled();
        });

        it("should answer 200 with the committed time and synced when Identity confirmed", async () => {
            lock.mockResolvedValueOnce(suspended());
            await expect(service.reinstate(admin, 202, REASON)).resolves.toEqual({ status: 200, view: { doctorUserId: 202, reinstatedAt: SUSPENDED_AT, identitySyncStatus: "synced" } });
        });

        it.each([
            [IdentitySyncStatus.Pending, "pending"],
            [IdentitySyncStatus.Failed, "failed"],
        ] as const)("should answer 202 identitySync %s when the sync ended %s", async (sync, expected) => {
            lock.mockResolvedValueOnce(suspended());
            identitySync.syncNow.mockResolvedValueOnce(report(sync));
            await expect(service.reinstate(admin, 202, REASON)).resolves.toEqual({ status: 202, identitySync: expected, view: { doctorUserId: 202, reinstatedAt: SUSPENDED_AT, identitySyncStatus: sync } });
        });

        it("should answer 202 pending when the doctor lock was not held", async () => {
            lock.mockResolvedValueOnce(suspended());
            identitySync.syncNow.mockResolvedValueOnce({ profile: profile({ identitySyncStatus: IdentitySyncStatus.Synced }), status: 202, identitySync: "pending" });
            await expect(service.reinstate(admin, 202, REASON)).resolves.toMatchObject({ status: 202, identitySync: "pending" });
        });

        describe("not suspended (no-op)", () => {
            it.each([IdentitySyncStatus.Synced, IdentitySyncStatus.NotRequired])("should answer 200 carrying the current sync status %s and write nothing", async (sync) => {
                lock.mockResolvedValueOnce(profile({ identitySyncStatus: sync }));
                const outcome = await service.reinstate(admin, 202, REASON);
                expect(outcome).toEqual({ status: 200, view: { doctorUserId: 202, reinstatedAt: new Date(START), identitySyncStatus: sync } });
                noWrites();
            });

            it.each([
                [IdentitySyncStatus.Pending, "pending"],
                [IdentitySyncStatus.Failed, "failed"],
            ] as const)("should answer 202 %s while the latest job is an unsynced reinstatement", async (sync, expected) => {
                lock.mockResolvedValueOnce(profile({ identitySyncStatus: sync }));
                identitySync.findLatestJob.mockResolvedValueOnce({ id: 5, kind: "reinstatement", status: "pending" });
                const outcome = await service.reinstate(admin, 202, REASON);
                expect(outcome).toEqual({ status: 202, identitySync: expected, view: { doctorUserId: 202, reinstatedAt: new Date(START), identitySyncStatus: sync } });
                expect(identitySync.findLatestJob).toHaveBeenCalledWith(9, trx);
                noWrites();
            });

            it.each(["suspension", "verification"])("should answer 200 when the unsynced sync belongs to a %s job", async (kind) => {
                lock.mockResolvedValueOnce(profile({ identitySyncStatus: IdentitySyncStatus.Pending }));
                identitySync.findLatestJob.mockResolvedValueOnce({ id: 5, kind, status: "pending" });
                await expect(service.reinstate(admin, 202, REASON)).resolves.toMatchObject({ status: 200 });
                noWrites();
            });

            it("should answer 200 when there is no job at all", async () => {
                lock.mockResolvedValueOnce(profile({ identitySyncStatus: IdentitySyncStatus.Failed }));
                await expect(service.reinstate(admin, 202, REASON)).resolves.toMatchObject({ status: 200 });
            });

            it("should not look at jobs for a synced profile", async () => {
                lock.mockResolvedValueOnce(profile({ identitySyncStatus: IdentitySyncStatus.Synced }));
                await service.reinstate(admin, 202, REASON);
                expect(identitySync.findLatestJob).not.toHaveBeenCalled();
            });
        });
    });
});
