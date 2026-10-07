import { randomUUID } from "node:crypto";
import type { Express } from "express";
import request from "supertest";
import type { Test } from "supertest";
import { db } from "../../src/lib/knex/knex";
import { redis } from "../../src/lib/redis/redis";
import { getEnv } from "../../src/lib/config/env";
import { container } from "../../src/lib/di/container";
import { TOKENS } from "../../src/lib/di/tokens";
import { logger } from "../../src/lib/logger/logger";
import { IdentityClient } from "../../src/lib/identity-client/identity-client";
import { VerificationService } from "../../src/app/verification/service/verification.service";
import { VerificationController } from "../../src/app/verification/controller/verification.controller";
import { DoctorsService } from "../../src/app/doctors/service/doctors.service";
import { DoctorsController } from "../../src/app/doctors/controller/doctors.controller";
import { buildIdentitySyncLoop } from "../../src/app/verification/worker/identity-sync.loop";
import { buildUploadIntentPurgeLoop } from "../../src/app/verification/worker/upload-intent-purge.loop";
import { buildTestApps } from "../helpers/app";
import { closeDb, ownerDb, truncateAll } from "../helpers/db";
import { startFakeJwks, buildFakeJwksWiring } from "../helpers/fake-jwks";
import { FakeIdentityServer } from "../helpers/fake-identity-server";
import { InMemoryObjectStorage } from "../helpers/fake-storage";
import { closeRedis, ensureRedisReady, flushByPrefix } from "../helpers/redis";
import { signUserToken } from "../helpers/tokens";
import { captureLogs, expectNoSensitiveStrings } from "../helpers/log-capture";
import { contractResponseCodes, expectErrorEnvelope } from "../helpers/contract";
import type { FakeJwks, FakeJwksWiring } from "../helpers/types";

jest.setTimeout(30_000);
const DOCTOR = 202;
const OTHER = 204;
const PDF = Buffer.from("%PDF-1.7 synthetic verification file");
const path = (suffix: string) => `/api/doctors/me/documents/${suffix}`;
const admin = (suffix: string) => `/api/admin/applications${suffix}`;
const applyBody = (submit = false) => ({ headline: "Synthetic verification doctor", bio: "Synthetic only", yearsExperience: 5, languages: ["en"], specialtyIds: [1], primarySpecialtyId: 1,
    consultationFee: { amount: 100, currency: "EGP" }, defaultSlotMinutes: 30, timezone: "Africa/Cairo", submit });

describe("verification routes (real Postgres, Redis and app)", () => {
    let app: Express;
    let jwks: FakeJwks;
    let wiring: FakeJwksWiring;
    let identityServer: FakeIdentityServer;
    let identity: IdentityClient;
    let service: VerificationService;
    const storage = new InMemoryObjectStorage();
    const tokens: Record<string, string> = {};
    const previous: Array<{ token: symbol; value: unknown }> = [];

    function call(method: "get" | "post" | "patch" | "delete", url: string, actor?: string, payload?: object, headers: Record<string, string> = {}): Test {
        let test = request(app)[method](url).set(headers);
        if (actor) test = test.set("Authorization", `Bearer ${tokens[actor]}`);
        if (payload) test = test.send(payload);
        return test;
    }
    async function profile(actor = "doctor"): Promise<number> {
        const response = await call("post", "/api/doctors/apply", actor, applyBody());
        expect([200, 201]).toContain(response.status);
        const row = await ownerDb("doctor_profiles").where("user_id", actor === "other" ? OTHER : DOCTOR).first();
        return Number(row.id);
    }
    async function intent(type: "license" | "id" = "license", actor = "doctor"): Promise<{ id: number; key: string }> {
        const response = await call("post", path("uploads"), actor, { type });
        expect(response.status).toBe(201);
        const row = await ownerDb("upload_intents").where("id", response.body.data.uploadId).first();
        return { id: Number(row.id), key: String(row.quarantine_key) };
    }
    async function document(type: "license" | "id" = "license", actor = "doctor"): Promise<number> {
        const upload = await intent(type, actor); storage.seed(upload.key, PDF);
        const response = await call("post", path(`uploads/${upload.id}/complete`), actor, {});
        expect(response.status).toBe(201);
        return Number(response.body.data.id);
    }
    async function submitted(): Promise<number> {
        const id = await profile(); await document("license"); await document("id");
        const response = await call("post", "/api/doctors/apply", "doctor", applyBody(true));
        expect(response.status).toBe(200);
        return id;
    }

    beforeAll(async () => {
        await ensureRedisReady();
        jwks = await startFakeJwks(["verification"]); wiring = await buildFakeJwksWiring(jwks);
        identityServer = new FakeIdentityServer(); const url = await identityServer.start();
        identity = new IdentityClient({ env: { ...getEnv(), IDENTITY_INTERNAL_URL: url }, redis, sleep: () => Promise.resolve() });
        identityServer.users.set(DOCTOR, { id: DOCTOR, fullName: "Synthetic Doctor 202", avatarUrl: null, status: "pending" });
        identityServer.users.set(OTHER, { id: OTHER, fullName: "Synthetic Doctor 204", avatarUrl: null, status: "pending" });
        for (const token of [TOKENS.JwksCache, TOKENS.UserTokenVerifier, TOKENS.IDENTITY_CLIENT, TOKENS.STORAGE, TOKENS.VerificationService, TOKENS.VerificationController, TOKENS.DoctorsService, TOKENS.DoctorsController])
            previous.push({ token, value: container.isRegistered(token) ? container.resolve(token) : undefined });
        container.registerInstance(TOKENS.JwksCache, wiring.cache);
        container.registerInstance(TOKENS.UserTokenVerifier, wiring.verifier);
        container.registerInstance(TOKENS.IDENTITY_CLIENT, identity);
        container.registerInstance(TOKENS.STORAGE, storage);
        service = container.resolve(VerificationService);
        container.registerInstance(TOKENS.VerificationService, service);
        container.registerSingleton(TOKENS.VerificationController, VerificationController);
        container.registerSingleton(TOKENS.DoctorsService, DoctorsService);
        container.registerSingleton(TOKENS.DoctorsController, DoctorsController);
        app = buildTestApps().publicApp;
        for (const [name, sub, role, status] of [["doctor", "202", "doctor", "active"], ["pending", "202", "doctor", "pending"], ["rejected", "202", "doctor", "rejected"], ["other", "204", "doctor", "active"], ["patient", "101", "patient", "active"], ["admin", "303", "admin", "active"]] as const)
            tokens[name] = await signUserToken(jwks.key("verification"), { sub, role, status });
    });
    beforeEach(async () => {
        await truncateAll(); await flushByPrefix(["idem:", "rl:", "identity:user:"]); storage.clear();
        identityServer.calls.length = 0; Object.assign(identityServer.options, { down: false, forceConflict: false, statusFailures: 0, batchFailures: 0, malformed: false });
        identityServer.users.get(DOCTOR)!.status = "pending"; identityServer.users.get(OTHER)!.status = "pending";
        await ownerDb("specialties").insert({ id: 1, name: "Synthetic", slug: "synthetic", is_active: true });
    });
    afterAll(async () => {
        await truncateAll(); await flushByPrefix(["idem:", "rl:", "identity:user:"]);
        for (const entry of previous) if (entry.value !== undefined) container.registerInstance(entry.token, entry.value);
        wiring.cache.stop(); await identity.close(); await identityServer.close(); await jwks.close(); await closeRedis(); await closeDb();
    });

    it.each([
        ["post", path("uploads"), { type: "license" }], ["post", path("uploads/1/complete"), {}],
        ["post", path("1/download-url"), {}], ["delete", path("1"), undefined],
        ["get", admin(""), undefined], ["get", admin("/1"), undefined],
        ["post", admin("/1/documents/1/download-url"), {}], ["patch", admin("/1/approve"), {}],
        ["patch", admin("/1/reject"), { reason: "synthetic rejection" }], ["patch", admin("/1/reopen"), { reason: "synthetic reopen" }],
    ] as const)("should enforce RBAC on %s %s", async (method, url, payload) => {
        const isAdminRoute = url.includes("/admin/");
        for (const [actor, expected] of [[undefined, 401], [isAdminRoute ? "doctor" : "patient", 403], [isAdminRoute ? "patient" : "admin", 403]] as const) {
            const response = await call(method, url, actor, payload);
            expect(response.status).toBe(expected);
            expectErrorEnvelope(response.body, expected === 401 ? "Unauthorized" : "Forbidden");
        }
    });

    it.each(["pending", "doctor", "rejected"])("should allow document intents for %s doctor account state", async (actor) => {
        await profile(); expect((await call("post", path("uploads"), actor, { type: "license" })).status).toBe(201);
    });

    it("intentOwnerReplayAndExpiry: should hide a foreign intent and return one document on replay", async () => {
        await profile(); await profile("other"); const upload = await intent(); storage.seed(upload.key, PDF);
        expect((await call("post", path(`uploads/${upload.id}/complete`), "other", {})).status).toBe(404);
        const first = await call("post", path(`uploads/${upload.id}/complete`), "doctor", {});
        const replay = await call("post", path(`uploads/${upload.id}/complete`), "doctor", {});
        expect([first.status, replay.status]).toEqual([201, 200]); expect(replay.body.data).toEqual(first.body.data);
        expect(await ownerDb("verification_documents")).toHaveLength(1);
        expect(await ownerDb("audit_logs").where("action", "verification.document_uploaded")).toHaveLength(1);
    });

    it("should replay an optional idempotency key and reject the same key with a different intent type", async () => {
        await profile(); const headers = { "Idempotency-Key": randomUUID() };
        const first = await call("post", path("uploads"), "doctor", { type: "license" }, headers);
        const replay = await call("post", path("uploads"), "doctor", { type: "license" }, headers);
        expect(first.status).toBe(201); expect(replay.status).toBe(201); expect(replay.body).toEqual(first.body);
        expect(await ownerDb("upload_intents")).toHaveLength(1);
        const changed = await call("post", path("uploads"), "doctor", { type: "id" }, headers);
        expect(changed.status).toBe(422); expectErrorEnvelope(changed.body, "IdempotencyConflict");
    });

    it("should return 410 and close an expired intent", async () => {
        await profile(); const upload = await intent(); storage.seed(upload.key, PDF);
        await ownerDb("upload_intents").where("id", upload.id).update({ expires_at: new Date(Date.now() - 1000) });
        const response = await call("post", path(`uploads/${upload.id}/complete`), "doctor", {});
        expect(response.status).toBe(410); expectErrorEnvelope(response.body, "UploadIntentExpired");
        expect(await ownerDb("verification_documents")).toHaveLength(0);
    });

    it.each([Buffer.from("fake PDF bytes"), Buffer.from("%PDF"), Buffer.alloc(0)])("completeRejectsFalsePdfAndWritesNoRow: should reject invalid stored bytes", async (bytes) => {
        await profile(); const upload = await intent(); storage.seed(upload.key, bytes);
        const response = await call("post", path(`uploads/${upload.id}/complete`), "doctor", {});
        expect(response.status).toBe(400); expectErrorEnvelope(response.body, "ValidationFailed");
        expect(await ownerDb("verification_documents")).toHaveLength(0);
    });

    it("should reject an oversized object and leave no document", async () => {
        await profile(); const upload = await intent(); storage.seed(upload.key, PDF); storage.setHeadSize(upload.key, 10_485_761);
        expect((await call("post", path(`uploads/${upload.id}/complete`), "doctor", {})).status).toBe(400);
        expect(await ownerDb("verification_documents")).toHaveLength(0);
    });

    it("should leave an intent open for retry when storage promotion fails", async () => {
        await profile(); const upload = await intent(); storage.seed(upload.key, PDF); storage.failNextCopy();
        const failed = await call("post", path(`uploads/${upload.id}/complete`), "doctor", {});
        expect(failed.status).toBe(500); expectErrorEnvelope(failed.body, "InternalError");
        expect((await ownerDb("upload_intents").where("id", upload.id).first()).consumed_at).toBeNull();
        expect(await ownerDb("verification_documents")).toHaveLength(0);
        expect((await call("post", path(`uploads/${upload.id}/complete`), "doctor", {})).status).toBe(201);
    });

    it("auditFailureRollsBackVerificationWrite: should roll back completion and delete its promoted object", async () => {
        await profile(); const upload = await intent(); storage.seed(upload.key, PDF);
        await ownerDb.raw("ALTER TABLE audit_logs ADD CONSTRAINT chk_audit_verification_upload_test CHECK (action <> 'verification.document_uploaded')");
        try {
            const response = await call("post", path(`uploads/${upload.id}/complete`), "doctor", {});
            expect(response.status).toBe(500); expectErrorEnvelope(response.body, "InternalError");
            expect(await ownerDb("verification_documents")).toHaveLength(0);
            expect((await ownerDb("upload_intents").where("id", upload.id).first()).consumed_at).toBeNull();
            expect(storage.calls.filter((c) => c.operation === "promote")).toHaveLength(1);
            expect(storage.calls.filter((c) => c.operation === "delete")).toHaveLength(2);
        } finally { await ownerDb.raw("ALTER TABLE audit_logs DROP CONSTRAINT IF EXISTS chk_audit_verification_upload_test"); }
    });

    it("should make one concurrent complete win and the other replay or report a conflict", async () => {
        await profile(); const upload = await intent(); storage.seed(upload.key, PDF);
        const results = await Promise.all([call("post", path(`uploads/${upload.id}/complete`), "doctor", {}), call("post", path(`uploads/${upload.id}/complete`), "doctor", {})]);
        expect(results.filter((r) => r.status === 201)).toHaveLength(1);
        expect([200, 409]).toContain(results.find((r) => r.status !== 201)?.status);
        expect(await ownerDb("verification_documents")).toHaveLength(1);
    });

    it("submitRequiresLicenseAndId: should submit locally with two live documents and no status call", async () => {
        await profile(); expect((await call("post", "/api/doctors/apply", "doctor", applyBody(true))).status).toBe(400);
        await document("license"); await document("id"); identityServer.calls.length = 0;
        const response = await call("post", "/api/doctors/apply", "doctor", applyBody(true));
        expect(response.status).toBe(200); expect(response.body.data.verificationStatus).toBe("submitted");
        expect(identityServer.calls.filter((c) => c.method === "PATCH")).toHaveLength(0);
        expect(await ownerDb("identity_sync_jobs")).toHaveLength(0);
    });

    it("submittedProfileAndDocumentsAreImmutable: should reject profile and document writes", async () => {
        const id = await submitted();
        for (const response of [await call("patch", "/api/doctors/me", "doctor", { headline: "Synthetic changed" }), await call("post", path("uploads"), "doctor", { type: "license" })]) {
            expect(response.status).toBe(409); expectErrorEnvelope(response.body, "ApplicationNotEditable");
        }
        expect((await ownerDb("doctor_profiles").where("id", id).first()).verification_status).toBe("submitted");
    });

    it("should approve once under concurrency, sync Identity and audit the decision", async () => {
        const id = await submitted();
        const results = await Promise.all([call("patch", admin(`/${id}/approve`), "admin", {}), call("patch", admin(`/${id}/approve`), "admin", {})]);
        expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
        expect(identityServer.users.get(DOCTOR)?.status).toBe("active");
        expect(await ownerDb("identity_sync_jobs").where("status", "succeeded")).toHaveLength(1);
        expect(await ownerDb("audit_logs").where("action", "verification.approved")).toHaveLength(1);
    });

    it("identityFailurePolicyDistinguishes409: should keep approval pending and retry after Identity recovers", async () => {
        const id = await submitted(); identityServer.options.down = true;
        const response = await call("patch", admin(`/${id}/approve`), "admin", {});
        expect(response.status).toBe(202); expect(response.body.data.identitySync).toBe("pending");
        expect((await ownerDb("identity_sync_jobs").first()).status).toBe("pending");
        expect((await ownerDb("doctor_profiles").where("id", id).first()).identity_sync_status).toBe("pending");
        identityServer.options.down = false;
        await ownerDb("identity_sync_jobs").update({ next_attempt_at: new Date(Date.now() - 1000) });
        const loop = buildIdentitySyncLoop({ service, logger, pollSeconds: 10 });
        await expect(loop.tick(new AbortController().signal)).resolves.toBe("done");
        expect((await ownerDb("identity_sync_jobs").first()).status).toBe("succeeded");
        expect((await ownerDb("doctor_profiles").where("id", id).first()).identity_sync_status).toBe("synced");
    });

    it("should mark a provider 409 failed without retrying", async () => {
        const id = await submitted(); identityServer.options.forceConflict = true;
        const response = await call("patch", admin(`/${id}/approve`), "admin", {});
        expect(response.status).toBe(202); expect(response.body.data.identitySync).toBe("failed");
        expect((await ownerDb("identity_sync_jobs").first()).status).toBe("failed");
        expect((await ownerDb("doctor_profiles").where("id", id).first()).identity_sync_status).toBe("failed");
    });

    it("should return 202 and persist a rejection job when Identity is down", async () => {
        const id = await submitted(); identityServer.options.down = true;
        const response = await call("patch", admin(`/${id}/reject`), "admin", { reason: "Synthetic credentials need revision" });
        expect(response.status).toBe(202); expect(response.body.data.identitySync).toBe("pending");
        expect((await ownerDb("identity_sync_jobs").first()).target_status).toBe("rejected");
        expect((await ownerDb("doctor_profiles").where("id", id).first()).verification_status).toBe("rejected");
    });

    it("should return 202 and persist a reopen job when Identity is down", async () => {
        const id = await submitted();
        expect((await call("patch", admin(`/${id}/reject`), "admin", { reason: "Synthetic credentials need revision" })).status).toBe(200);
        identityServer.options.down = true;
        const response = await call("patch", admin(`/${id}/reopen`), "admin", { reason: "Synthetic reconsideration" });
        expect(response.status).toBe(202); expect(response.body.data.identitySync).toBe("pending");
        expect((await ownerDb("identity_sync_jobs").where("status", "pending").first()).target_status).toBe("pending");
        expect((await ownerDb("doctor_profiles").where("id", id).first()).verification_status).toBe("submitted");
    });

    it("should return 202 on rejected doctor resubmission while Identity is down", async () => {
        const id = await submitted();
        expect((await call("patch", admin(`/${id}/reject`), "admin", { reason: "Synthetic credentials need revision" })).status).toBe(200);
        identityServer.options.down = true;
        const response = await call("post", "/api/doctors/apply", "rejected", applyBody(true));
        expect(response.status).toBe(202); expect(response.body.data.identitySync).toBe("pending");
        expect((await ownerDb("identity_sync_jobs").where("status", "pending").first()).target_status).toBe("pending");
    });

    it("should reject, reopen and resubmit with a pending Identity status", async () => {
        const id = await submitted();
        expect((await call("patch", admin(`/${id}/reject`), "admin", { reason: "Synthetic credentials need revision" })).status).toBe(200);
        expect((await call("patch", admin(`/${id}/reopen`), "admin", { reason: "Synthetic reconsideration" })).status).toBe(200);
        expect((await ownerDb("doctor_profiles").where("id", id).first()).verification_status).toBe("submitted");
        expect(identityServer.users.get(DOCTOR)?.status).toBe("pending");
    });

    it("documentIdCannotCrossApplication: should return 404 for a foreign doctor and mismatched admin application", async () => {
        const id = await profile(); await profile("other"); const docId = await document();
        expect((await call("post", path(`${docId}/download-url`), "other", {})).status).toBe(404);
        const foreign = await ownerDb("doctor_profiles").where("user_id", OTHER).first();
        expect((await call("post", admin(`/${foreign.id}/documents/${docId}/download-url`), "admin", {})).status).toBe(404);
        expect((await call("post", admin(`/${id}/documents/${docId}/download-url`), "admin", {})).status).toBe(200);
    });

    it("downloadFailsClosedOnAuditError: should issue URLs only after committed audit", async () => {
        await profile(); const docId = await document();
        const response = await call("post", path(`${docId}/download-url`), "doctor", {});
        expect(response.status).toBe(200); expect(response.body.data.url).toMatch(/^https:/);
        expect(await ownerDb("audit_logs").where("action", "verification.document_url_issued")).toHaveLength(1);
        await ownerDb.raw("ALTER TABLE audit_logs ADD CONSTRAINT chk_audit_verification_url_test CHECK (action <> 'verification.document_url_issued') NOT VALID");
        try {
            const failed = await call("post", path(`${docId}/download-url`), "doctor", {});
            expect(failed.status).toBe(500); expectErrorEnvelope(failed.body, "InternalError");
            expect(storage.calls.filter((c) => c.operation === "presignDownload")).toHaveLength(1);
        } finally { await ownerDb.raw("ALTER TABLE audit_logs DROP CONSTRAINT IF EXISTS chk_audit_verification_url_test"); }
    });

    it("should paginate the admin queue and degrade hydration without a 5xx", async () => {
        await profile(); await profile("other");
        await ownerDb("doctor_profiles").update({ verification_status: "submitted", submitted_at: new Date("2026-01-01T00:00:00Z") });
        identityServer.options.down = true;
        const first = await call("get", admin("?limit=1"), "admin"); expect(first.status).toBe(200);
        expect(first.body.data[0].doctor.profileHydrated).toBe(false);
        const second = await call("get", admin(`?limit=1&cursor=${encodeURIComponent(first.body.meta.nextCursor)}`), "admin");
        expect(second.status).toBe(200); expect(second.body.data).toHaveLength(1);
        expect(second.body.data[0].id).not.toBe(first.body.data[0].id);
        expect((await call("get", admin("?cursor=tampered"), "admin")).status).toBe(400);
    });

    it("should purge expired quarantine objects and close intents with the real service", async () => {
        await profile(); const upload = await intent(); storage.seed(upload.key, PDF);
        await ownerDb("upload_intents").where("id", upload.id).update({ expires_at: new Date(Date.now() - 1000) });
        const loop = buildUploadIntentPurgeLoop({ service, db, logger });
        await expect(loop.tick(new AbortController().signal)).resolves.toBe("done");
        expect(storage.has(upload.key)).toBe(false);
        expect((await ownerDb("upload_intents").where("id", upload.id).first()).consumed_at).not.toBeNull();
    });

    it("should keep synthetic reviewer prose, object keys and tokens out of logs and reads", async () => {
        await profile(); const docId = await document();
        const capture = captureLogs();
        try { await call("get", "/api/doctors/me/application", "doctor"); await call("post", path(`${docId}/download-url`), "doctor", {}); }
        finally { capture.restore(); }
        expectNoSensitiveStrings(capture, ["Synthetic verification doctor", "Synthetic only", ...Object.values(tokens), "verification-documents/"]);
        const read = await call("get", "/api/doctors/me/application", "doctor");
        expect(JSON.stringify(read.body)).not.toMatch(/objectKey|downloadUrl|quarantine\/|verification-documents\//);
    });

    it("should declare verification success and error statuses in the contract", () => {
        expect(contractResponseCodes("/api/doctors/me/documents/uploads", "post")).toEqual(expect.arrayContaining(["201", "403", "409"]));
        expect(contractResponseCodes("/api/doctors/me/documents/uploads/{uploadId}/complete", "post")).toEqual(expect.arrayContaining(["200", "201", "400", "404", "410"]));
        expect(contractResponseCodes("/api/admin/applications/{id}/approve", "patch")).toEqual(expect.arrayContaining(["200", "202", "409"]));
    });
});
