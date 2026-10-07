/* eslint-disable @typescript-eslint/unbound-method */
import type { Knex } from "knex";
import { VerificationService } from "../../../../src/app/verification/service/verification.service";
import * as repo from "../../../../src/app/verification/repository/verification.repo";
import * as locks from "../../../../src/lib/knex/session-advisory-lock";
import { DoctorProfile } from "../../../../src/app/doctors/entity/doctor-profile.entity";
import { VerificationDocument } from "../../../../src/app/verification/entity/verification-document.entity";
import { IdentitySyncStatus, VerificationStatus } from "../../../../src/app/doctors/enums";
import { VerificationDocumentType } from "../../../../src/app/verification/enums";
import type { AuthContext } from "../../../../src/lib/types/types";
import type { AuditRecorder } from "../../../../src/lib/audit/audit";
import type { ObjectStorage } from "../../../../src/lib/storage/types";
import type { IdentityClient } from "../../../../src/lib/identity-client/identity-client";
import { getEnv } from "../../../../src/lib/config/env";
import { isBookable } from "../../../../src/app/doctors/service/doctors.service";
import { buildVerificationPolicies } from "../../../../src/app/verification/policies";
import { logger } from "../../../../src/lib/logger/logger";

const actor = { userId: 202, role: "doctor", status: "active", emailVerified: true } as AuthContext;
const admin = { userId: 303, role: "admin", status: "active", emailVerified: true } as AuthContext;
const profile = (status: VerificationStatus, changes: Partial<DoctorProfile> = {}) => new DoctorProfile({ id: 1, userId: 202, verificationStatus: status,
    identitySyncStatus: IdentitySyncStatus.NotRequired, suspendedAt: null, submittedAt: null, ...changes });
const document = (type: VerificationDocumentType) => new VerificationDocument({ id: type === VerificationDocumentType.License ? 1 : 2, doctorProfileId: 1, type,
    objectKey: `verification-documents/${type}`, fileType: "application/pdf", sizeBytes: 5, createdAt: new Date() });

describe("verification service rules", () => {
    const audit = { record: jest.fn().mockResolvedValue(undefined) } as unknown as AuditRecorder;
    const storage = { createUploadPolicy: jest.fn().mockResolvedValue({ url: "https://storage.test/upload", fields: {} }),
        delete: jest.fn().mockResolvedValue(undefined), headObject: jest.fn(), readHead: jest.fn(), promote: jest.fn(), presignDownload: jest.fn().mockResolvedValue({ url: "https://storage.test/download", expiresAt: new Date().toISOString() }) } as unknown as ObjectStorage;
    const identity = { setUserStatus: jest.fn(), getUsersBatch: jest.fn().mockResolvedValue({ users: new Map(), degraded: true }) } as unknown as IdentityClient;
    const update = jest.fn().mockResolvedValue(1);
    const whereNull = jest.fn(() => ({ update }));
    const where = jest.fn(() => ({ whereNull, update }));
    const trx = Object.assign(jest.fn(() => ({ where, update })), { fn: { now: () => new Date() } });
    const db = Object.assign(jest.fn(() => ({ where, update })), { transaction: jest.fn(async (work: (t: Knex.Transaction) => Promise<unknown>) => work(trx as unknown as Knex.Transaction)) });
    const service = new VerificationService(db as unknown as Knex, audit, storage, identity, getEnv());

    beforeEach(() => { jest.restoreAllMocks(); jest.clearAllMocks(); });

    it("submitRequiresLicenseAndId: should reject draft submission when either credential is missing", async () => {
        jest.spyOn(repo, "listDocuments").mockResolvedValue([document(VerificationDocumentType.License)]);
        await expect(service.submitInTransaction(actor, profile(VerificationStatus.Draft), trx as unknown as Knex.Transaction)).rejects.toMatchObject({ code: "ValidationFailed" });
        expect(update).not.toHaveBeenCalled();
    });

    it("submitRejectsForeignPrincipal: should resolve intent ownership from the persisted owner", async () => {
        jest.spyOn(repo, "findIntent").mockResolvedValue({ kind: "verification_document", owner_user_id: 204, target_id: 1 } as Awaited<ReturnType<typeof repo.findIntent>>);
        jest.spyOn(repo, "findProfileById").mockResolvedValue(profile(VerificationStatus.Draft));
        const policy = buildVerificationPolicies().complete;
        if (policy.owner.kind !== "resolver") throw new Error("expected resolver policy");
        await expect(policy.owner.resolve({ auth: actor, params: { uploadId: "1" } })).resolves.toBe("deny-not-found");
    });

    it("submittedProfileAndDocumentsAreImmutable: should reject submitted application mutations", async () => {
        await expect(service.submitInTransaction(actor, profile(VerificationStatus.Submitted), trx as unknown as Knex.Transaction)).rejects.toMatchObject({ code: "ApplicationNotEditable" });
        jest.spyOn(repo, "findProfileByUserId").mockResolvedValue(profile(VerificationStatus.Submitted));
        await expect(service.createIntent(actor, VerificationDocumentType.License)).rejects.toMatchObject({ code: "ApplicationNotEditable" });
    });

    it("resubmitSyncsPendingOnlyForRejected: should create a job only for rejected resubmission", async () => {
        jest.spyOn(repo, "listDocuments").mockResolvedValue([document(VerificationDocumentType.License), document(VerificationDocumentType.Id)]);
        jest.spyOn(repo, "supersedePendingSyncJob").mockResolvedValue(undefined);
        const insert = jest.spyOn(repo, "insertSyncJob").mockResolvedValue({ id: 9 } as Awaited<ReturnType<typeof repo.insertSyncJob>>);
        expect(await service.submitInTransaction(actor, profile(VerificationStatus.Draft), trx as unknown as Knex.Transaction)).toEqual({ jobId: null });
        expect(insert).not.toHaveBeenCalled();
        expect(await service.submitInTransaction(actor, profile(VerificationStatus.Rejected), trx as unknown as Knex.Transaction)).toEqual({ jobId: 9 });
        expect(insert).toHaveBeenCalledWith(expect.objectContaining({ target_status: "pending" }), expect.anything());
    });

    it("approvalPendingIsNotBookable: should gate an approved profile until Identity sync succeeds", () => {
        const pending = profile(VerificationStatus.Approved, { identitySyncStatus: IdentitySyncStatus.Pending, isAcceptingPatients: true });
        expect(isBookable(pending, true)).toBe(false);
        pending.identitySyncStatus = IdentitySyncStatus.Synced;
        expect(isBookable(pending, true)).toBe(true);
    });

    it("auditFailureRollsBackVerificationWrite: should propagate a failed submit audit to the transaction", async () => {
        jest.spyOn(repo, "listDocuments").mockResolvedValue([document(VerificationDocumentType.License), document(VerificationDocumentType.Id)]);
        jest.spyOn(repo, "supersedePendingSyncJob").mockResolvedValue(undefined);
        jest.spyOn(audit, "record").mockRejectedValueOnce(new Error("synthetic audit failure"));
        await expect(service.submitInTransaction(actor, profile(VerificationStatus.Draft), trx as unknown as Knex.Transaction)).rejects.toThrow("synthetic audit failure");
    });

    it("reviewTransitionRequiresExpectedState: should reject approving a draft or reopening a submitted application", async () => {
        jest.spyOn(repo, "findProfileById").mockResolvedValue(profile(VerificationStatus.Draft));
        await expect(service.decide(admin, 1, "approve", undefined)).rejects.toMatchObject({ code: "ApplicationNotReviewable" });
        jest.spyOn(repo, "findProfileById").mockResolvedValue(profile(VerificationStatus.Submitted));
        await expect(service.decide(admin, 1, "reopen", "synthetic reason")).rejects.toMatchObject({ code: "ApplicationNotReviewable" });
    });

    it("newDecisionSupersedesOpenJob: should supersede an older job before inserting a decision", async () => {
        jest.spyOn(repo, "findProfileById").mockResolvedValue(profile(VerificationStatus.Submitted));
        const supersede = jest.spyOn(repo, "supersedePendingSyncJob").mockResolvedValue(undefined);
        jest.spyOn(repo, "insertSyncJob").mockResolvedValue({ id: 9 } as Awaited<ReturnType<typeof repo.insertSyncJob>>);
        jest.spyOn(repo, "findSyncJob").mockResolvedValue(undefined);
        await expect(service.decide(admin, 1, "reject", "synthetic reason")).rejects.toMatchObject({ code: "NotFound" });
        expect(supersede).toHaveBeenCalledWith(1, expect.anything());
        expect(repo.insertSyncJob).toHaveBeenCalledWith(expect.objectContaining({ target_status: "rejected" }), expect.anything());
    });

    it("intentOwnerReplayAndExpiry: should reject foreign intent before storage access", async () => {
        jest.spyOn(locks, "withSessionAdvisoryLock").mockImplementation(async (_db, _namespace, _id, work) => work());
        jest.spyOn(repo, "findIntent").mockResolvedValue({ id: 3, kind: "verification_document", owner_user_id: 204 } as Awaited<ReturnType<typeof repo.findIntent>>);
        await expect(service.complete(actor, 3)).rejects.toMatchObject({ code: "NotFound" });
        expect(storage.headObject).not.toHaveBeenCalled();
    });

    it("intentOwnerReplayAndExpiry: should close an expired intent before document creation", async () => {
        jest.spyOn(locks, "withSessionAdvisoryLock").mockImplementation(async (_db, _namespace, _id, work) => work());
        jest.spyOn(repo, "findIntent").mockResolvedValue({ id: 3, kind: "verification_document", owner_user_id: 202, target_id: 1, result_id: null, consumed_at: null,
            expires_at: new Date(Date.now() - 1000), quarantine_key: "quarantine/synthetic" } as Awaited<ReturnType<typeof repo.findIntent>>);
        jest.spyOn(repo, "findProfileById").mockResolvedValue(profile(VerificationStatus.Draft));
        const close = jest.spyOn(repo, "closeIntent").mockResolvedValue(undefined);
        await expect(service.complete(actor, 3)).rejects.toMatchObject({ code: "UploadIntentExpired" });
        expect(storage.delete).toHaveBeenCalledWith("quarantine/synthetic");
        expect(close).toHaveBeenCalledWith(3, null, expect.anything());
    });

    it("completeRejectsFalsePdfAndWritesNoRow: should reject invalid stored bytes before inserting a document", async () => {
        jest.spyOn(locks, "withSessionAdvisoryLock").mockImplementation(async (_db, _namespace, _id, work) => work());
        jest.spyOn(repo, "findIntent").mockResolvedValue({ id: 3, kind: "verification_document", owner_user_id: 202, target_id: 1, result_id: null, consumed_at: null,
            expires_at: new Date(Date.now() + 60_000), quarantine_key: "quarantine/synthetic", max_bytes: 10_485_760 } as Awaited<ReturnType<typeof repo.findIntent>>);
        jest.spyOn(repo, "findProfileById").mockResolvedValue(profile(VerificationStatus.Draft));
        jest.mocked(storage.headObject).mockResolvedValue({ sizeBytes: 18, etag: '"etag-1"' });
        jest.mocked(storage.readHead).mockResolvedValue(Buffer.from("synthetic false PDF"));
        jest.spyOn(repo, "closeIntent").mockResolvedValue(undefined);
        const insert = jest.spyOn(repo, "insertDocument");
        await expect(service.complete(actor, 3)).rejects.toMatchObject({ code: "ValidationFailed" });
        expect(insert).not.toHaveBeenCalled();
        expect(storage.delete).toHaveBeenCalledWith("quarantine/synthetic");
    });

    it.each([
        ["applied", "succeeded", "synced"],
        ["rejected-transition", "failed", "failed"],
        ["transient", "pending", "pending"],
    ] as const)("identityFailurePolicyDistinguishes409: should record %s outcome as %s", async (outcome, jobStatus, profileStatus) => {
        const job = { id: 9, doctor_profile_id: 1, doctor_user_id: 202, kind: "verification", status: "pending", target_status: "active", reason: "synthetic reason",
            actor_user_id: 303, request_id: "synthetic-request", attempts: 0, consecutive_failures: 0, next_attempt_at: new Date(Date.now() - 1000), created_at: new Date(), updated_at: new Date() } as Awaited<ReturnType<typeof repo.findSyncJob>>;
        jest.spyOn(locks, "withSessionAdvisoryLock").mockImplementation(async (_db, _namespace, _id, work) => work());
        jest.spyOn(repo, "findSyncJob").mockResolvedValue(job);
        jest.spyOn(repo, "findPendingSyncJob").mockResolvedValue(job);
        jest.spyOn(repo, "findProfileById").mockResolvedValue(profile(VerificationStatus.Approved, { identitySyncStatus: IdentitySyncStatus.Pending }));
        jest.spyOn(repo, "listDocuments").mockResolvedValue([]);
        const updateJob = jest.spyOn(repo, "updateSyncJob").mockResolvedValue(undefined);
        if (outcome === "transient") jest.mocked(identity.setUserStatus).mockResolvedValue({ outcome, errorCode: "HTTP_503" });
        else jest.mocked(identity.setUserStatus).mockResolvedValue({ outcome });
        const before = Date.now();
        await service.processDueSyncJob(9);
        if (outcome !== "transient") expect(updateJob).toHaveBeenCalledWith(9, expect.objectContaining({ status: jobStatus }), expect.anything());
        if (outcome !== "transient") expect(update).toHaveBeenCalledWith(expect.objectContaining({ identity_sync_status: profileStatus }));
        else {
            expect(updateJob).toHaveBeenCalledWith(9, expect.objectContaining({ next_attempt_at: expect.any(Date) }), expect.anything());
            const scheduled = updateJob.mock.calls[0]?.[1].next_attempt_at;
            expect(scheduled?.getTime()).toBeGreaterThanOrEqual(before + 160);
            expect(scheduled?.getTime()).toBeLessThanOrEqual(Date.now() + 240);
        }
    });

    it("documentIdCannotCrossApplication: should reject a document outside the requested application", async () => {
        jest.spyOn(repo, "findDocument").mockResolvedValue(document(VerificationDocumentType.License));
        jest.spyOn(repo, "findProfileById").mockResolvedValue(profile(VerificationStatus.Draft));
        await expect(service.download(admin, 1, 2)).rejects.toMatchObject({ code: "NotFound" });
        expect(storage.presignDownload).not.toHaveBeenCalled();
    });

    it("downloadFailsClosedOnAuditError: should never sign a URL if its audit transaction fails", async () => {
        jest.spyOn(repo, "findDocument").mockResolvedValue(document(VerificationDocumentType.License));
        jest.spyOn(repo, "findProfileById").mockResolvedValue(profile(VerificationStatus.Draft));
        jest.spyOn(audit, "record").mockRejectedValueOnce(new Error("synthetic audit failure"));
        await expect(service.download(actor, 1)).rejects.toThrow("synthetic audit failure");
        expect(storage.presignDownload).not.toHaveBeenCalled();
    });

    it("hydrationDegradesWithoutPerRowCalls: should request queue identities once", async () => {
        jest.spyOn(repo, "listQueue").mockResolvedValue([{ profile: profile(VerificationStatus.Submitted), cursorTimestamp: "2026-01-01T00:00:00.000000Z" }]);
        jest.spyOn(repo, "listDocumentsBatch").mockResolvedValue(new Map());
        const page = await service.queue({ status: VerificationStatus.Submitted, limit: 20 });
        expect(identity.getUsersBatch).toHaveBeenCalledTimes(1);
        expect(page.items[0]?.doctor).toEqual({ displayName: null, avatarUrl: null, profileHydrated: false });
    });

    it("should encode a queue cursor and reject tampering or a changed filter", async () => {
        const list = jest.spyOn(repo, "listQueue").mockResolvedValueOnce([
            { profile: profile(VerificationStatus.Submitted), cursorTimestamp: "2026-01-01T00:00:00.000000Z" },
            { profile: profile(VerificationStatus.Submitted, { id: 2 }), cursorTimestamp: "2026-01-02T00:00:00.000000Z" },
        ]).mockResolvedValue([]);
        jest.spyOn(repo, "listDocumentsBatch").mockResolvedValue(new Map());
        const first = await service.queue({ status: VerificationStatus.Submitted, limit: 1 });
        expect(first.meta.hasMore).toBe(true);
        expect(first.meta.nextCursor).toEqual(expect.any(String));
        await service.queue({ status: VerificationStatus.Submitted, limit: 1, cursor: first.meta.nextCursor! });
        expect(list).toHaveBeenLastCalledWith(expect.anything(), { status: "submitted", timestamp: "2026-01-01T00:00:00.000000Z", id: 1 }, expect.anything());
        await expect(service.queue({ status: VerificationStatus.Rejected, limit: 1, cursor: first.meta.nextCursor! })).rejects.toMatchObject({ code: "ValidationFailed" });
        await expect(service.queue({ status: VerificationStatus.Submitted, limit: 1, cursor: `${first.meta.nextCursor}x` })).rejects.toMatchObject({ code: "ValidationFailed" });
    });

    it("staleSyncResultCannotMarkNewDecisionSynced: should skip a superseded job", async () => {
        jest.spyOn(repo, "findSyncJob").mockResolvedValue({ id: 1, kind: "verification", status: "superseded" } as Awaited<ReturnType<typeof repo.findSyncJob>>);
        await service.processDueSyncJob(1);
        expect(identity.setUserStatus).not.toHaveBeenCalled();
    });

    const syncJob = (changes: Partial<NonNullable<Awaited<ReturnType<typeof repo.findSyncJob>>>> = {}) => ({ id: 9, doctor_profile_id: 1, doctor_user_id: 202, kind: "verification", status: "pending", target_status: "active", reason: "synthetic reason",
        actor_user_id: 303, request_id: "synthetic-request", attempts: 0, consecutive_failures: 0, next_attempt_at: new Date(Date.now() - 1000), created_at: new Date(), updated_at: new Date(), ...changes }) as NonNullable<Awaited<ReturnType<typeof repo.findSyncJob>>>;
    const lockPassesThrough = () => jest.spyOn(locks, "withSessionAdvisoryLock").mockImplementation(async (_db, _namespace, _id, work) => work());

    it.each(["approve", "reject"] as const)("decisionWaitsForPendingSync: should refuse %s with Conflict and Retry-After while the previous status change has not reached Identity", async (action) => {
        jest.spyOn(repo, "findProfileById").mockResolvedValue(profile(VerificationStatus.Submitted, { identitySyncStatus: IdentitySyncStatus.Pending }));
        const supersede = jest.spyOn(repo, "supersedePendingSyncJob").mockResolvedValue(undefined);
        const insert = jest.spyOn(repo, "insertSyncJob");
        await expect(service.decide(admin, 1, action, "synthetic reason")).rejects.toMatchObject({ code: "Conflict", status: 409, extra: { retryAfter: 5 } });
        expect(supersede).not.toHaveBeenCalled();
        expect(insert).not.toHaveBeenCalled();
        expect(identity.setUserStatus).not.toHaveBeenCalled();
    });

    it.each([IdentitySyncStatus.Synced, IdentitySyncStatus.NotRequired])("decisionWaitsForPendingSync: should accept approve when the account sync is %s", async (syncStatus) => {
        jest.spyOn(repo, "findProfileById").mockResolvedValue(profile(VerificationStatus.Submitted, { identitySyncStatus: syncStatus }));
        jest.spyOn(repo, "listDocuments").mockResolvedValue([document(VerificationDocumentType.License), document(VerificationDocumentType.Id)]);
        jest.spyOn(repo, "supersedePendingSyncJob").mockResolvedValue(undefined);
        jest.spyOn(repo, "applyProfileDecision").mockResolvedValue(undefined);
        const insert = jest.spyOn(repo, "insertSyncJob").mockResolvedValue({ id: 9 } as Awaited<ReturnType<typeof repo.insertSyncJob>>);
        jest.spyOn(repo, "findSyncJob").mockResolvedValue(undefined);
        await expect(service.decide(admin, 1, "approve", undefined)).rejects.toMatchObject({ code: "NotFound" });
        expect(insert).toHaveBeenCalledWith(expect.objectContaining({ target_status: "active" }), expect.anything());
    });

    it("decisionWaitsForPendingSync: should still allow reopening a rejected application whose rejection is unsynced", async () => {
        jest.spyOn(repo, "findProfileById").mockResolvedValue(profile(VerificationStatus.Rejected, { identitySyncStatus: IdentitySyncStatus.Pending }));
        jest.spyOn(repo, "supersedePendingSyncJob").mockResolvedValue(undefined);
        jest.spyOn(repo, "applyProfileDecision").mockResolvedValue(undefined);
        const insert = jest.spyOn(repo, "insertSyncJob").mockResolvedValue({ id: 9 } as Awaited<ReturnType<typeof repo.insertSyncJob>>);
        jest.spyOn(repo, "findSyncJob").mockResolvedValue(undefined);
        await expect(service.decide(admin, 1, "reopen", "synthetic reason")).rejects.toMatchObject({ code: "NotFound" });
        expect(insert).toHaveBeenCalledWith(expect.objectContaining({ target_status: "pending" }), expect.anything());
    });

    it("twoWorkersHonourBackoff: should not call Identity for a job whose next attempt is still in the future", async () => {
        lockPassesThrough();
        const job = syncJob({ next_attempt_at: new Date(Date.now() + 30_000), attempts: 1 });
        jest.spyOn(repo, "findSyncJob").mockResolvedValue(job);
        jest.spyOn(repo, "findPendingSyncJob").mockResolvedValue(job);
        await service.processDueSyncJob(9);
        expect(identity.setUserStatus).not.toHaveBeenCalled();
    });

    it("finishSubmitBuildsNoView: should report the sync outcome without any Identity hydration call", async () => {
        lockPassesThrough();
        const job = syncJob({ target_status: "pending" });
        jest.spyOn(repo, "findSyncJob").mockResolvedValue(job);
        jest.spyOn(repo, "findPendingSyncJob").mockResolvedValue(job);
        jest.spyOn(repo, "findProfileById").mockResolvedValue(profile(VerificationStatus.Submitted, { identitySyncStatus: IdentitySyncStatus.Pending }));
        jest.spyOn(repo, "updateSyncJob").mockResolvedValue(undefined);
        jest.mocked(identity.setUserStatus).mockResolvedValue({ outcome: "transient", errorCode: "HTTP_503" });
        await expect(service.finishSubmit(actor, { jobId: 9 })).resolves.toEqual({ status: 202, identitySync: "pending" });
        expect(identity.getUsersBatch).not.toHaveBeenCalled();
        await expect(service.finishSubmit(actor, { jobId: null })).resolves.toBeNull();
    });

    it("alertLogsCarryIds: should log job and profile ids with the transition-rejected alert", async () => {
        lockPassesThrough();
        const job = syncJob();
        jest.spyOn(repo, "findSyncJob").mockResolvedValue(job);
        jest.spyOn(repo, "findPendingSyncJob").mockResolvedValue(job);
        jest.spyOn(repo, "findProfileById").mockResolvedValue(profile(VerificationStatus.Approved, { identitySyncStatus: IdentitySyncStatus.Pending }));
        jest.spyOn(repo, "updateSyncJob").mockResolvedValue(undefined);
        const error = jest.spyOn(logger, "error").mockImplementation(() => undefined);
        jest.mocked(identity.setUserStatus).mockResolvedValue({ outcome: "rejected-transition" });
        await service.processDueSyncJob(9);
        expect(error).toHaveBeenCalledWith("IdentitySyncTransitionRejected", { code: "InvalidStatusTransition", jobId: 9, profileId: 1 });
    });

    it("alertLogsCarryIds: should log job and profile ids with the unsynced-too-long alert", async () => {
        lockPassesThrough();
        const old = new Date(Date.now() - 3_600_000);
        const job = syncJob({ created_at: old, updated_at: old });
        jest.spyOn(repo, "findSyncJob").mockResolvedValue(job);
        jest.spyOn(repo, "findPendingSyncJob").mockResolvedValue(job);
        jest.spyOn(repo, "findProfileById").mockResolvedValue(profile(VerificationStatus.Approved, { identitySyncStatus: IdentitySyncStatus.Pending }));
        jest.spyOn(repo, "updateSyncJob").mockResolvedValue(undefined);
        const error = jest.spyOn(logger, "error").mockImplementation(() => undefined);
        jest.mocked(identity.setUserStatus).mockResolvedValue({ outcome: "transient", errorCode: "HTTP_503" });
        await service.processDueSyncJob(9);
        expect(error).toHaveBeenCalledWith("IdentityApprovalSyncPending", { jobId: 9, profileId: 1 });
    });

    describe("complete binds promotion to the verified object", () => {
        const openIntent = () => ({ id: 3, kind: "verification_document", owner_user_id: 202, target_id: 1, result_id: null, consumed_at: null, document_type: "license",
            expires_at: new Date(Date.now() + 60_000), quarantine_key: "quarantine/synthetic", max_bytes: 10_485_760 }) as Awaited<ReturnType<typeof repo.findIntent>>;
        beforeEach(() => {
            lockPassesThrough();
            jest.spyOn(repo, "findIntent").mockResolvedValue(openIntent());
            jest.spyOn(repo, "findProfileById").mockResolvedValue(profile(VerificationStatus.Draft));
            jest.mocked(storage.headObject).mockResolvedValue({ sizeBytes: 12, etag: "\"etag-1\"" });
            jest.mocked(storage.readHead).mockResolvedValue(Buffer.from("%PDF-1.7 synthetic"));
        });

        it("should pass the inspected ETag and detected type to promote", async () => {
            jest.mocked(storage.promote).mockResolvedValue(undefined);
            jest.spyOn(repo, "findIntentForUpdate").mockResolvedValue(openIntent());
            jest.spyOn(repo, "insertDocument").mockResolvedValue(document(VerificationDocumentType.License));
            jest.spyOn(repo, "closeIntent").mockResolvedValue(undefined);
            await service.complete(actor, 3);
            expect(storage.promote).toHaveBeenCalledWith("quarantine/synthetic", expect.stringMatching(/^verification-documents\//), { etag: "\"etag-1\"", contentType: "application/pdf" });
            expect(storage.readHead).toHaveBeenCalledTimes(1);
        });

        it("should create no document and keep the intent open when the quarantine object changed before the copy", async () => {
            jest.mocked(storage.promote).mockRejectedValue(new Error("synthetic precondition failure"));
            const insert = jest.spyOn(repo, "insertDocument");
            const close = jest.spyOn(repo, "closeIntent");
            await expect(service.complete(actor, 3)).rejects.toThrow("synthetic precondition failure");
            expect(insert).not.toHaveBeenCalled();
            expect(close).not.toHaveBeenCalled();
        });
    });
});
