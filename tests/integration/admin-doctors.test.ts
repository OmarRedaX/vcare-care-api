import { randomUUID } from "node:crypto";
import type { Express } from "express";
import request from "supertest";
import type { Test } from "supertest";
import { AdminDoctorsController } from "../../src/app/admin-doctors/controller/admin-doctors.controller";
import { AdminDoctorsService } from "../../src/app/admin-doctors/service/admin-doctors.service";
import type { SuspensionImpactContext, SuspensionImpactProvider } from "../../src/app/admin-doctors/types";
import { DoctorsController } from "../../src/app/doctors/controller/doctors.controller";
import { DoctorsService } from "../../src/app/doctors/service/doctors.service";
import { IdentitySyncService } from "../../src/app/identity-sync/service/identity-sync.service";
import { buildIdentitySyncLoop } from "../../src/app/identity-sync/worker/identity-sync.loop";
import { VerificationController } from "../../src/app/verification/controller/verification.controller";
import { VerificationService } from "../../src/app/verification/service/verification.service";
import { backoffMs } from "../../src/lib/async/backoff";
import { getEnv } from "../../src/lib/config/env";
import { container } from "../../src/lib/di/container";
import { TOKENS } from "../../src/lib/di/tokens";
import { IdentityClient } from "../../src/lib/identity-client/identity-client";
import { logger } from "../../src/lib/logger/logger";
import { redis } from "../../src/lib/redis/redis";
import { buildTestApps, withContainerOverrides } from "../helpers/app";
import { contractResponseCodes, expectErrorEnvelope, inlineLists, schemaBlock } from "../helpers/contract";
import { closeDb, ownerDb, truncateAll } from "../helpers/db";
import { FakeClock } from "../helpers/fake-clock";
import { FAKE_IDENTITY_REASON_MAX, FakeIdentityServer } from "../helpers/fake-identity-server";
import { buildFakeJwksWiring, startFakeJwks } from "../helpers/fake-jwks";
import { InMemoryObjectStorage } from "../helpers/fake-storage";
import { captureLogs, expectNoSensitiveStrings } from "../helpers/log-capture";
import { closeRedis, createUnreachableRedis, ensureRedisReady, flushByPrefix } from "../helpers/redis";
import { signExpiredUserToken, signUserToken, tamperToken } from "../helpers/tokens";
import type { FakeJwks, FakeJwksWiring } from "../helpers/types";

jest.setTimeout(60_000);

const DOCTOR = 202;
const OTHER = 204;
const ADMIN = 303;
const MARKER = "SYNTHETIC-REASON-4417";
const REASON = `${MARKER} synthetic suspension review`;
const EMOJI = String.fromCodePoint(0x1f600);
const PENDING_MARKER = "applied-locally, session-revocation-pending";
const CAP_MS = getEnv().IDENTITY_SYNC_RETRY_CAP_SECONDS * 1000;
const suspendUrl = (id: number | string): string => `/api/admin/doctors/${id}/suspend`;
const reinstateUrl = (id: number | string): string => `/api/admin/doctors/${id}/reinstate`;
const codePoints = (value: string): number => [...value].length;

type Actor = "admin" | "admin2" | "adminSuspended" | "adminPending" | "doctor" | "otherDoctor" | "patient" | "expired" | "tampered";
type Verb = "get" | "patch" | "post";
type JobRow = Record<string, unknown>;

/** A real in-process binding of the consultation-flag port: tests choose the ids it reports and make it fail. */
class StubImpactProvider implements SuspensionImpactProvider {
    ids: number[] = [];
    failFlag = false;
    readonly flagCalls: SuspensionImpactContext[] = [];
    reset(): void { this.ids = []; this.failFlag = false; this.flagCalls.length = 0; }
    flagFutureConsultations(ctx: SuspensionImpactContext): Promise<number[]> {
        this.flagCalls.push(ctx);
        if (this.failFlag) return Promise.reject(new Error("synthetic_port_failure"));
        return Promise.resolve([...this.ids]);
    }
    listFlaggedConsultations(): Promise<number[]> { return Promise.resolve([...this.ids]); }
}

describe("admin-doctors (integration: real routes, Postgres, Redis and sync engine; only Identity faked)", () => {
    let fake: FakeJwks;
    let wiring: FakeJwksWiring;
    let app: Express;
    let identityServer: FakeIdentityServer;
    let identity: IdentityClient;
    let identitySync: IdentitySyncService;
    const clock = new FakeClock();
    const impact = new StubImpactProvider();
    const storage = new InMemoryObjectStorage();
    const tokens = {} as Record<Actor, string>;
    const previous: Array<{ token: symbol; value: unknown }> = [];
    const seen = new Map<string, Set<number>>();
    const bodies: unknown[] = [];

    const template = (url: string): string => url.replace(/\/doctors\/\d+\//, "/doctors/{doctorUserId}/");
    function tracked(test: Test, verb: Verb, url: string): Test {
        const original = test.end.bind(test) as (callback?: (error: Error | null, res: request.Response) => void) => Test;
        test.end = ((callback?: (error: Error | null, res: request.Response) => void): Test => original((error, res) => {
            if (res !== undefined && url.startsWith("/api/admin/doctors/")) {
                const key = `${verb} ${template(url)}`; const set = seen.get(key) ?? new Set<number>(); set.add(res.status); seen.set(key, set);
                bodies.push(res.body);
            }
            callback?.(error, res);
        })) as Test["end"];
        return test;
    }
    function call(verb: Verb, url: string, actor?: Actor, payload?: object, headers: Record<string, string> = {}): Test {
        let test = tracked(request(app)[verb](url), verb, url).set(headers);
        if (actor !== undefined) test = test.set("Authorization", `Bearer ${tokens[actor]}`);
        if (payload !== undefined) test = test.send(payload);
        return test;
    }
    const suspend = (id: number = DOCTOR, reason: string = REASON, actor: Actor = "admin", headers: Record<string, string> = {}): Test => call("patch", suspendUrl(id), actor, { reason }, headers);
    const reinstate = (id: number = DOCTOR, reason: string = REASON, actor: Actor = "admin", headers: Record<string, string> = {}): Test => call("patch", reinstateUrl(id), actor, { reason }, headers);

    async function seedDoctor(userId: number = DOCTOR, changes: Record<string, unknown> = {}, withType = true): Promise<number> {
        const rows = await ownerDb("doctor_profiles").insert({
            user_id: userId, headline: "Synthetic headline", years_experience: 5, consultation_fee: 100, currency: "EGP", default_slot_minutes: 30,
            timezone: "Africa/Cairo", is_accepting_patients: true, verification_status: "approved", decided_at: new Date(), identity_sync_status: "synced", ...changes,
        }).returning("id");
        const id = Number((rows[0] as { id: number }).id);
        if (withType) await ownerDb("consultation_types").insert({ doctor_profile_id: id, name: "Synthetic Visit 001", duration_minutes: 30, price: 100, currency: "EGP", is_active: true });
        return id;
    }
    const profileRow = async (userId: number = DOCTOR): Promise<Record<string, unknown>> => (await ownerDb("doctor_profiles").where("user_id", userId).first()) as Record<string, unknown>;
    const jobsOf = (userId: number = DOCTOR): Promise<JobRow[]> => ownerDb("identity_sync_jobs").where("doctor_user_id", userId).orderBy("id");
    const auditOf = (like: string): Promise<JobRow[]> => ownerDb("audit_logs").where("action", "like", like).orderBy("id");
    const patches = (): typeof identityServer.statusBodies => identityServer.statusBodies;
    const identityStatus = (userId: number = DOCTOR): string | undefined => identityServer.users.get(userId)?.status;
    const dateOf = (value: unknown): number => new Date(value as string | Date).getTime();
    const loop = (): ReturnType<typeof buildIdentitySyncLoop> => buildIdentitySyncLoop({ service: identitySync, logger, pollSeconds: 10 });
    const tick = async (advanceMs = CAP_MS + 1): Promise<void> => {
        clock.advance(advanceMs);
        await expect(loop().tick(new AbortController().signal)).resolves.toBe("done");
    };
    const me = async (): Promise<{ isBookable: boolean; isSuspended: boolean }> => {
        const res = await call("get", "/api/doctors/me", "doctor");
        expect(res.status).toBe(200);
        return res.body.data as { isBookable: boolean; isSuspended: boolean };
    };
    const typesStatus = async (): Promise<number> => (await call("get", "/api/doctors/me/consultation-types", "doctor")).status;
    const down = (): void => { identityServer.options.statusFailures = 1_000; identityServer.options.statusFailureCode = 503; };
    const heal = (): void => { identityServer.options.statusFailures = 0; identityServer.options.down = false; identityServer.options.forceConflict = false; };
    const snapshot = async (): Promise<{ profiles: unknown; jobs: number; audits: number; patches: number }> => ({
        profiles: await ownerDb("doctor_profiles").orderBy("id"), jobs: (await ownerDb("identity_sync_jobs")).length, audits: (await ownerDb("audit_logs")).length, patches: patches().length,
    });
    async function expectUntouched(before: Awaited<ReturnType<typeof snapshot>>): Promise<void> {
        const after = await snapshot();
        expect(after.jobs).toBe(before.jobs); expect(after.audits).toBe(before.audits); expect(after.patches).toBe(before.patches);
        expect(after.profiles).toEqual(before.profiles);
    }
    /** Suspension that Identity could not confirm: pending job, three failed attempts. */
    async function suspendWhileDown(): Promise<void> {
        down();
        expect((await suspend()).status).toBe(503);
    }

    beforeAll(async () => {
        await ensureRedisReady();
        fake = await startFakeJwks(["admin-doctors"]); wiring = await buildFakeJwksWiring(fake);
        identityServer = new FakeIdentityServer(); const url = await identityServer.start();
        identity = new IdentityClient({ env: { ...getEnv(), IDENTITY_INTERNAL_URL: url }, redis, sleep: () => Promise.resolve() });
        for (const token of [TOKENS.JwksCache, TOKENS.UserTokenVerifier, TOKENS.IDENTITY_CLIENT, TOKENS.STORAGE, TOKENS.SyncTiming, TOKENS.SuspensionImpactProvider, TOKENS.IdentitySyncService,
            TOKENS.AdminDoctorsService, TOKENS.AdminDoctorsController, TOKENS.VerificationService, TOKENS.VerificationController, TOKENS.DoctorsService, TOKENS.DoctorsController])
            previous.push({ token, value: container.isRegistered(token) ? container.resolve(token) : undefined });
        container.registerInstance(TOKENS.JwksCache, wiring.cache);
        container.registerInstance(TOKENS.UserTokenVerifier, wiring.verifier);
        container.registerInstance(TOKENS.IDENTITY_CLIENT, identity);
        container.registerInstance(TOKENS.STORAGE, storage);
        container.registerInstance(TOKENS.SyncTiming, clock);
        container.registerInstance(TOKENS.SuspensionImpactProvider, impact);
        // Singletons created at boot hold the boot-time client, clock and port: rebuild every consumer of the engine on the test doubles.
        container.registerSingleton(TOKENS.IdentitySyncService, IdentitySyncService);
        identitySync = container.resolve<IdentitySyncService>(TOKENS.IdentitySyncService);
        container.registerSingleton(TOKENS.AdminDoctorsService, AdminDoctorsService);
        container.registerSingleton(TOKENS.AdminDoctorsController, AdminDoctorsController);
        container.registerInstance(TOKENS.VerificationService, container.resolve(VerificationService));
        container.registerSingleton(TOKENS.VerificationController, VerificationController);
        container.registerSingleton(TOKENS.DoctorsService, DoctorsService);
        container.registerSingleton(TOKENS.DoctorsController, DoctorsController);
        app = buildTestApps().publicApp;
        const claims: Array<[Actor, string, "doctor" | "patient" | "admin", "pending" | "active" | "suspended"]> = [
            ["admin", String(ADMIN), "admin", "active"], ["admin2", "304", "admin", "active"], ["adminSuspended", String(ADMIN), "admin", "suspended"], ["adminPending", String(ADMIN), "admin", "pending"],
            ["doctor", String(DOCTOR), "doctor", "active"], ["otherDoctor", String(OTHER), "doctor", "active"], ["patient", "101", "patient", "active"],
        ];
        for (const [name, sub, role, status] of claims) tokens[name] = await signUserToken(fake.key("admin-doctors"), { sub, role, status });
        tokens.expired = await signExpiredUserToken(fake.key("admin-doctors"), { sub: String(ADMIN), role: "admin", status: "active" });
        tokens.tampered = tamperToken(tokens.admin);
    });
    beforeEach(async () => {
        await truncateAll(); await flushByPrefix(["idem:", "rl:", "identity:user:"]);
        impact.reset(); storage.clear(); clock.set(Date.now());
        identityServer.calls.length = 0; identityServer.statusBodies.length = 0;
        Object.assign(identityServer.options, { down: false, forceConflict: false, statusFailures: 0, statusFailureCode: undefined, batchFailures: 0, malformed: false });
        identityServer.users.set(DOCTOR, { id: DOCTOR, fullName: "Synthetic Doctor 202", avatarUrl: null, status: "active" });
        identityServer.users.set(OTHER, { id: OTHER, fullName: "Synthetic Doctor 204", avatarUrl: null, status: "active" });
        await seedDoctor(DOCTOR);
    });
    afterEach(() => { jest.restoreAllMocks(); });
    afterAll(async () => {
        await truncateAll(); await flushByPrefix(["idem:", "rl:", "identity:user:"]);
        for (const entry of previous) if (entry.value !== undefined) container.registerInstance(entry.token, entry.value);
        wiring.cache.stop(); await identity.close(); await identityServer.close(); await fake.close(); await closeRedis(); await closeDb();
    });

    // ------------------------------------------------------------------------------------------ RBAC
    describe.each([["suspend", suspendUrl], ["reinstate", reinstateUrl]] as const)("RBAC on %s", (_name, url) => {
        it("should deny every caller but an active admin and leave no trace", async () => {
            const before = await snapshot();
            const denied: Array<[Actor | undefined, number, string]> = [
                [undefined, 401, "Unauthorized"], ["expired", 401, "TokenExpired"], ["tampered", 401, "Unauthorized"],
                ["patient", 403, "Forbidden"], ["otherDoctor", 403, "Forbidden"], ["doctor", 403, "Forbidden"],
                ["adminSuspended", 403, "Forbidden"], ["adminPending", 403, "Forbidden"],
            ];
            for (const [actor, status, code] of denied) {
                const res = await call("patch", url(DOCTOR), actor, { reason: REASON });
                expect([actor, res.status]).toEqual([actor, status]);
                expectErrorEnvelope(res.body, code, res.headers["x-request-id"]);
            }
            await expectUntouched(before);
        });

        it("should answer 403 to the target doctor acting on themself", async () => {
            const res = await call("patch", url(DOCTOR), "doctor", { reason: REASON });
            expect(res.status).toBe(403); expectErrorEnvelope(res.body, "Forbidden");
            expect((await profileRow()).suspended_at).toBeNull();
        });

        it("should deny before validating: a non-admin with an invalid body gets 403, not 400", async () => {
            const res = await call("patch", url(DOCTOR), "patient", { reason: "x" });
            expect(res.status).toBe(403);
            expect((await call("patch", url(DOCTOR), undefined, {})).status).toBe(401);
        });

        it("should allow an active admin", async () => {
            const res = await call("patch", url(DOCTOR), "admin", { reason: REASON });
            expect(res.status).toBe(200);
        });

        it("should never take the acting admin or the target from the body or headers", async () => {
            const res = await call("patch", url(DOCTOR), "admin", { reason: REASON }, { "X-User-Id": "999", "X-Role": "admin" });
            expect(res.status).toBe(200);
            if (_name === "suspend") expect(patches()[0]?.actorUserId).toBe(ADMIN);
            expect((await call("patch", url(DOCTOR), "admin", { reason: REASON, actorUserId: 999 })).status).toBe(400);
        });
    });

    // ------------------------------------------------------------------------------------------ validation
    describe("validation", () => {
        it.each([["suspend", suspendUrl], ["reinstate", reinstateUrl]] as const)("should answer 400 ValidationFailed on %s for bad ids, bad reasons and unknown members without touching state", async (_name, url) => {
            const before = await snapshot();
            for (const [path, body] of [
                [url("abc"), { reason: REASON }], [url(0), { reason: REASON }], [url(-4), { reason: REASON }], [url("1.5"), { reason: REASON }],
                [url(DOCTOR), {}], [url(DOCTOR), { reason: "ab" }], [url(DOCTOR), { reason: "   " }], [url(DOCTOR), { reason: "\u3000\u3000\u3000" }], [url(DOCTOR), { reason: "r".repeat(2001) }], [url(DOCTOR), { reason: "bad\u0007reason" }],
                [url(DOCTOR), { reason: 12345 }], [url(DOCTOR), { reason: REASON, extra: true }], [url(DOCTOR), undefined],
            ] as const) {
                const res = await call("patch", path, "admin", body);
                expect([path, res.status]).toEqual([path, 400]);
                expectErrorEnvelope(res.body, "ValidationFailed", res.headers["x-request-id"]);
            }
            await expectUntouched(before);
        });

        it("should accept a reason of exactly 3 and exactly 2000 code points", async () => {
            expect((await suspend(DOCTOR, "abc")).status).toBe(200);
            expect((await reinstate(DOCTOR, `${EMOJI.repeat(1999)}x`)).status).toBe(200);
            expect(codePoints((await jobsOf())[1]?.reason as string)).toBe(2000);
        });
    });

    // ------------------------------------------------------------------------------------------ suspend
    describe("suspend", () => {
        it("should suspend, confirm with Identity, audit and block the doctor when Identity answers", async () => {
            const requestId = randomUUID();
            const res = await suspend(DOCTOR, REASON, "admin", { "X-Request-Id": requestId });
            expect(res.status).toBe(200);
            expect(res.headers["cache-control"]).toBe("no-store");
            expect(res.headers["x-request-id"]).toBe(requestId);
            expect(res.body.success).toBe(true);
            expect(Object.keys(res.body.data).sort()).toEqual([...(inlineLists(schemaBlock("SuspensionResult"), "required")[0] ?? [])].sort());
            const profile = await profileRow();
            expect(res.body.data).toEqual({ doctorUserId: DOCTOR, suspendedAt: new Date(profile.suspended_at as Date).toISOString(), identitySyncStatus: "synced", flaggedConsultationIds: [] });
            expect(Number(profile.suspended_by)).toBe(ADMIN); expect(profile.suspension_reason).toBe(REASON);
            expect([profile.verification_status, profile.identity_sync_status]).toEqual(["approved", "synced"]);
            expect(identityStatus()).toBe("suspended");
            expect(patches()).toEqual([{ userId: DOCTOR, status: "suspended", reason: REASON, actorUserId: ADMIN, requestId }]);
            expect(identityServer.calls.filter((c) => c.method === "PATCH").every((c) => c.authorization?.startsWith("Bearer "))).toBe(true);
            const [job, ...rest] = await jobsOf();
            expect(rest).toEqual([]);
            expect(job).toMatchObject({ kind: "suspension", target_status: "suspended", status: "succeeded", consecutive_failures: 0, reason: REASON, request_id: requestId });
            expect(Number(job?.actor_user_id)).toBe(ADMIN);
            expect(await me()).toEqual(expect.objectContaining({ isSuspended: true, isBookable: false }));
            expect(await typesStatus()).toBe(403);
        });

        it("should audit doctor.suspended and identity_sync.synced as the admin with ids and lengths only", async () => {
            const res = await suspend();
            const id = Number((await profileRow()).id);
            const rows = await ownerDb("audit_logs").whereIn("action", ["doctor.suspended", "identity_sync.pending", "identity_sync.synced", "identity_sync.failed"]).orderBy("id");
            expect(rows.map((row) => row.action)).toEqual(["doctor.suspended", "identity_sync.synced"]);
            const job = (await jobsOf())[0];
            expect(rows[0]).toMatchObject({ actor_role: "admin", entity_type: "doctor_profile", request_id: res.headers["x-request-id"] });
            expect([Number(rows[0]?.actor_user_id), Number(rows[0]?.entity_id)]).toEqual([ADMIN, id]);
            expect(rows[0]?.metadata).toEqual({ doctorUserId: DOCTOR, jobId: Number(job?.id), flaggedCount: 0, reasonLength: REASON.length, fromSyncStatus: "synced", toSyncStatus: "pending" });
            expect(rows[1]).toMatchObject({ actor_role: "admin", entity_type: "doctor_profile" });
            expect([Number(rows[1]?.actor_user_id), Number(rows[1]?.entity_id)]).toEqual([ADMIN, id]);
            expect(rows[1]?.metadata).toEqual({ jobId: Number(job?.id) });
        });

        it("should answer 503 IdentityUnavailable with the suspension marker and data, keep three attempts in one job and block the doctor locally when Identity is down", async () => {
            down();
            const requestId = randomUUID();
            const res = await suspend(DOCTOR, REASON, "admin", { "X-Request-Id": requestId });
            expect(res.status).toBe(503);
            expectErrorEnvelope(res.body, "IdentityUnavailable", requestId);
            expect(res.body.suspension).toBe(PENDING_MARKER);
            expect(Object.keys(res.body).sort()).toEqual(["data", "error", "success", "suspension"]);
            const profile = await profileRow();
            expect(res.body.data).toEqual({ doctorUserId: DOCTOR, suspendedAt: new Date(profile.suspended_at as Date).toISOString(), identitySyncStatus: "pending", flaggedConsultationIds: [] });
            expect(patches()).toHaveLength(3);
            expect(patches().every((p) => p.requestId === requestId && p.status === "suspended" && p.actorUserId === ADMIN)).toBe(true);
            expect([profile.identity_sync_status, profile.suspension_reason]).toEqual(["pending", REASON]);
            const jobs = await jobsOf();
            expect(jobs).toHaveLength(1);
            expect(jobs[0]).toMatchObject({ kind: "suspension", status: "pending", attempts: 3, consecutive_failures: 1, last_error_code: "HTTP_503" });
            expect(dateOf(jobs[0]?.next_attempt_at)).toBe(clock.now() + backoffMs(0, () => 0.5, CAP_MS));
            expect((await auditOf("doctor.%")).map((row) => row.action)).toEqual(["doctor.suspended"]);
            expect((await auditOf("identity_sync.%")).map((row) => [row.action, row.actor_role])).toEqual([["identity_sync.pending", "admin"]]);
            expect(identityStatus()).toBe("active");
            expect(await me()).toEqual(expect.objectContaining({ isSuspended: true, isBookable: false }));
            expect(await typesStatus()).toBe(403);
        });

        it("should answer 503 and keep a pending job when the Identity connection itself is down", async () => {
            identityServer.options.down = true;
            const res = await suspend();
            expect(res.status).toBe(503); expectErrorEnvelope(res.body, "IdentityUnavailable");
            expect(res.body.data.identitySyncStatus).toBe("pending");
            expect(patches()).toHaveLength(0);
            expect((await jobsOf())[0]).toMatchObject({ status: "pending", attempts: 3, consecutive_failures: 1 });
            expect((await profileRow()).suspended_at).not.toBeNull();
        });

        it("should converge to synced through the worker once Identity recovers, honouring the backoff first", async () => {
            const requestId = randomUUID();
            down();
            expect((await suspend(DOCTOR, REASON, "admin", { "X-Request-Id": requestId })).status).toBe(503);
            heal();
            await expect(loop().tick(new AbortController().signal)).resolves.toBe("done");
            expect(patches()).toHaveLength(3);
            expect((await jobsOf())[0]?.status).toBe("pending");
            await tick(1000);
            expect(patches()).toHaveLength(4);
            expect(patches()[3]).toEqual({ userId: DOCTOR, status: "suspended", reason: REASON, actorUserId: ADMIN, requestId });
            expect((await jobsOf())[0]).toMatchObject({ status: "succeeded", attempts: 4, consecutive_failures: 0 });
            expect((await profileRow()).identity_sync_status).toBe("synced");
            expect(identityStatus()).toBe("suspended");
            const synced = await auditOf("identity_sync.synced");
            expect(synced).toHaveLength(1);
            expect(synced[0]).toMatchObject({ actor_role: "system", actor_user_id: null });
            const again = await suspend();
            expect(again.status).toBe(200); expect(again.body.data.identitySyncStatus).toBe("synced");
            expect(patches()).toHaveLength(4);
            expect(await jobsOf()).toHaveLength(1);
        });

        it("should retry without a cap, page at the third and again at the thirteenth consecutive failure, and recover", async () => {
            down();
            expect((await suspend()).status).toBe(503);
            const capture = captureLogs();
            try {
                for (let attempt = 1; attempt <= 12; attempt += 1) {
                    const before = (await jobsOf())[0] as JobRow;
                    await tick();
                    const after = (await jobsOf())[0] as JobRow;
                    expect(after).toMatchObject({ status: "pending", consecutive_failures: attempt + 1, attempts: Number(before.attempts) + 1 });
                    expect(dateOf(after.next_attempt_at)).toBe(clock.now() + backoffMs(Number(before.attempts), () => 0.5, CAP_MS));
                }
            } finally { capture.restore(); }
            const pages = capture.lines().filter((line) => line.message === "IdentitySuspensionSyncFailing");
            expect(pages.map((line) => line.consecutiveFailures)).toEqual([3, 13]);
            expect(pages[0]).toMatchObject({ level: "error", kind: "suspension", lastErrorCode: "HTTP_503" });
            expect(capture.lines().filter((line) => line.message === "IdentityApprovalSyncPending" || line.message === "IdentityReinstatementSyncPending")).toHaveLength(0);
            expect(patches()).toHaveLength(3 + 12);
            heal();
            await tick();
            expect((await jobsOf())[0]).toMatchObject({ status: "succeeded", consecutive_failures: 0 });
            expect(identityStatus()).toBe("suspended");
        });

        it("should mark a 409 from Identity failed, page once, keep the local suspension and never retry", async () => {
            identityServer.options.forceConflict = true;
            const capture = captureLogs();
            let res: request.Response;
            try { res = await suspend(); } finally { capture.restore(); }
            expect(res.status).toBe(503); expectErrorEnvelope(res.body, "IdentityUnavailable");
            expect(res.body.suspension).toBe(PENDING_MARKER); expect(res.body.data.identitySyncStatus).toBe("failed");
            const jobId = Number((await jobsOf())[0]?.id);
            expect(capture.lines().filter((line) => line.message === "IdentitySyncTransitionRejected")).toEqual([
                expect.objectContaining({ level: "error", kind: "suspension", jobId, code: "InvalidStatusTransition" })]);
            expect((await jobsOf())[0]).toMatchObject({ status: "failed", last_error_code: "InvalidStatusTransition" });
            expect(patches()).toHaveLength(1);
            const profile = await profileRow();
            expect(profile.identity_sync_status).toBe("failed"); expect(profile.suspended_at).not.toBeNull();
            expect((await auditOf("identity_sync.%")).map((row) => row.action)).toEqual(["identity_sync.failed"]);
            await tick(); await tick();
            expect(patches()).toHaveLength(1);
            const before = await snapshot();
            const retry = await suspend();
            expect(retry.status).toBe(503); expect(retry.body.data.identitySyncStatus).toBe("failed");
            const blocked = await reinstate();
            expect(blocked.status).toBe(409); expectErrorEnvelope(blocked.body, "InvalidTransition");
            await expectUntouched(before);
            expect(await me()).toEqual(expect.objectContaining({ isSuspended: true, isBookable: false }));
        });

        it.each([400, 403, 422])("should treat an Identity %i as permanent: 503 failed, job and profile failed, one page with the code, local suspension kept, no retry", async (code) => {
            identityServer.options.statusFailures = 10;
            identityServer.options.statusFailureCode = code;
            const capture = captureLogs();
            let res: request.Response;
            try { res = await suspend(); } finally { capture.restore(); }
            expect(res.status).toBe(503); expectErrorEnvelope(res.body, "IdentityUnavailable");
            expect(res.body.data.identitySyncStatus).toBe("failed");
            const job = (await jobsOf())[0];
            expect(job).toMatchObject({ status: "failed", last_error_code: `HTTP_${code}`, attempts: 1 });
            expect(capture.lines().filter((line) => line.message === "IdentitySyncTransitionRejected")).toEqual([
                expect.objectContaining({ level: "error", kind: "suspension", jobId: Number(job?.id), code: `HTTP_${code}` })]);
            expect(patches()).toHaveLength(1);
            const profile = await profileRow();
            expect(profile.identity_sync_status).toBe("failed"); expect(profile.suspended_at).not.toBeNull();
            await tick(); await tick();
            expect(patches()).toHaveLength(1);
        });

        it("should keep treating an Identity 404 as transient: the job stays pending and retries", async () => {
            identityServer.options.statusFailures = 1_000;
            identityServer.options.statusFailureCode = 404;
            const res = await suspend();
            expect(res.status).toBe(503); expect(res.body.data.identitySyncStatus).toBe("pending");
            expect((await jobsOf())[0]).toMatchObject({ status: "pending", last_error_code: "HTTP_404" });
        });

        it.each([
            ["draft", { verification_status: "draft", decided_at: null, identity_sync_status: "not_required" }],
            ["submitted", { verification_status: "submitted", decided_at: null, submitted_at: new Date(), identity_sync_status: "not_required" }],
            ["rejected", { verification_status: "rejected", identity_sync_status: "synced" }],
            ["approved with a pending sync", { identity_sync_status: "pending" }],
            ["approved with a failed sync", { identity_sync_status: "failed" }],
        ])("should answer 409 InvalidTransition and write nothing for a %s profile", async (_label, changes) => {
            await ownerDb("doctor_profiles").where("user_id", DOCTOR).update(changes);
            const before = await snapshot();
            const res = await suspend();
            expect(res.status).toBe(409); expectErrorEnvelope(res.body, "InvalidTransition", res.headers["x-request-id"]);
            await expectUntouched(before);
        });

        it("should answer 404 NotFound for a user without a profile, a soft-deleted profile and a patient id, with no side effects", async () => {
            await seedDoctor(OTHER, { deleted_at: new Date() }, false);
            const before = await snapshot();
            for (const id of [999, OTHER, 101]) {
                const res = await suspend(id);
                expect([id, res.status]).toEqual([id, 404]);
                expectErrorEnvelope(res.body, "NotFound", res.headers["x-request-id"]);
            }
            await expectUntouched(before);
        });

        it("should answer 409 and write nothing when a reinstatement is still unsynced (S7)", async () => {
            expect((await suspend()).status).toBe(200);
            down();
            expect((await reinstate()).status).toBe(202);
            const before = await snapshot();
            const res = await suspend();
            expect(res.status).toBe(409); expectErrorEnvelope(res.body, "InvalidTransition");
            await expectUntouched(before);
        });

        describe("already suspended (no-op rules, S6)", () => {
            it("should answer 200 with the stored state and write nothing when the suspension is synced", async () => {
                const first = await suspend();
                const before = await snapshot();
                impact.ids = [11, 12]; impact.flagCalls.length = 0;
                const again = await suspend(DOCTOR, "a different reason for the retry");
                expect(again.status).toBe(200);
                expect(again.body.data).toEqual({ ...first.body.data, flaggedConsultationIds: [11, 12] });
                await expectUntouched(before);
                expect(impact.flagCalls).toHaveLength(0);
            });

            it("should answer the same 503 and write nothing while the sync is pending", async () => {
                await suspendWhileDown();
                const before = await snapshot();
                heal();
                impact.ids = [11, 12];
                for (let index = 0; index < 2; index += 1) {
                    const again = await suspend();
                    expect(again.status).toBe(503); expectErrorEnvelope(again.body, "IdentityUnavailable");
                    expect(again.body.suspension).toBe(PENDING_MARKER);
                    expect(again.body.data).toMatchObject({ identitySyncStatus: "pending", flaggedConsultationIds: [11, 12] });
                }
                await expectUntouched(before);
            });

            it("should answer the same 503 with failed and write nothing while the sync is failed", async () => {
                identityServer.options.forceConflict = true;
                expect((await suspend()).status).toBe(503);
                const before = await snapshot();
                const again = await suspend();
                expect(again.status).toBe(503); expect(again.body.data.identitySyncStatus).toBe("failed");
                await expectUntouched(before);
            });

            it("should keep the original suspended_at and reason on a repeated call", async () => {
                await suspend();
                const original = await profileRow();
                await suspend(DOCTOR, "second reason that must not overwrite");
                const after = await profileRow();
                expect(after.suspended_at).toEqual(original.suspended_at); expect(after.suspension_reason).toBe(REASON);
            });
        });

        it("should hold exactly one job, one doctor.suspended row and one Identity PATCH when two suspends race", async () => {
            const results = await Promise.all([suspend(), suspend()]);
            expect(results.map((res) => res.status).sort()).toEqual(expect.arrayContaining([200]));
            for (const res of results) expect([200, 503]).toContain(res.status);
            expect(await jobsOf()).toHaveLength(1);
            expect(await auditOf("doctor.suspended")).toHaveLength(1);
            expect(patches()).toHaveLength(1);
            expect(identityStatus()).toBe("suspended");
            expect((await profileRow()).identity_sync_status).toBe("synced");
        });

        it("should never open two jobs or end inconsistent when a suspend races a reinstate", async () => {
            const results = await Promise.all([suspend(), reinstate()]);
            for (const res of results) expect([200, 202, 409, 503]).toContain(res.status);
            const open = (await jobsOf()).filter((job) => job.status === "pending");
            expect(open.length).toBeLessThanOrEqual(1);
            expect(await auditOf("doctor.suspended")).toHaveLength(1);
            expect((await auditOf("doctor.reinstated")).length).toBeLessThanOrEqual(1);
            const profile = await profileRow();
            if (profile.identity_sync_status === "synced") expect(identityStatus()).toBe(profile.suspended_at === null ? "active" : "suspended");
        });

        it("should supersede a stray open verification job and never send its target to Identity", async () => {
            const profile = await profileRow();
            await ownerDb("identity_sync_jobs").insert({ doctor_profile_id: Number(profile.id), doctor_user_id: DOCTOR, kind: "verification", target_status: "active", reason: "stray", actor_user_id: ADMIN,
                status: "pending", next_attempt_at: new Date(clock.now() - 1000) });
            const res = await suspend();
            expect(res.status).toBe(200);
            const jobs = await jobsOf();
            expect(jobs.map((job) => [job.kind, job.status])).toEqual([["verification", "superseded"], ["suspension", "succeeded"]]);
            await tick();
            expect(patches().map((p) => p.status)).toEqual(["suspended"]);
        });

        it("should list the ports ids, audit one consultation.flagged_for_followup row per id and flag only when suspending", async () => {
            impact.ids = [11, 12];
            const res = await suspend();
            expect(res.status).toBe(200); expect(res.body.data.flaggedConsultationIds).toEqual([11, 12]);
            const profileId = Number((await profileRow()).id);
            const flagged = await auditOf("consultation.flagged_for_followup");
            expect(flagged.map((row) => [row.entity_type, Number(row.entity_id), row.actor_role])).toEqual([["consultation", 11, "admin"], ["consultation", 12, "admin"]]);
            expect(flagged.map((row) => row.metadata)).toEqual([{ doctorProfileId: profileId, followupReason: "doctor_suspended" }, { doctorProfileId: profileId, followupReason: "doctor_suspended" }]);
            expect((await auditOf("doctor.suspended"))[0]?.metadata).toMatchObject({ flaggedCount: 2 });
            expect(impact.flagCalls).toHaveLength(1);
            expect(impact.flagCalls[0]).toMatchObject({ doctorUserId: DOCTOR, doctorProfileId: profileId, now: new Date(clock.now()) });
            expect((await reinstate()).status).toBe(200);
            expect(impact.flagCalls).toHaveLength(1);
            expect(await auditOf("consultation.flagged_for_followup")).toHaveLength(2);
        });

        it("should roll back profile, job and audit and never call Identity when the consultation port throws", async () => {
            impact.failFlag = true;
            const before = await snapshot();
            const res = await suspend();
            expect(res.status).toBe(500); expectErrorEnvelope(res.body, "InternalError");
            expect(JSON.stringify(res.body)).not.toContain("synthetic_port_failure");
            await expectUntouched(before);
            expect((await profileRow()).suspended_at).toBeNull();
        });

        it("should roll back everything and answer 500 when the doctor.suspended audit row cannot be written", async () => {
            await ownerDb.raw("ALTER TABLE audit_logs ADD CONSTRAINT chk_audit_doctor_suspended_test CHECK (action <> 'doctor.suspended') NOT VALID");
            try {
                const before = await snapshot();
                const res = await suspend();
                expect(res.status).toBe(500); expectErrorEnvelope(res.body, "InternalError");
                await expectUntouched(before);
                expect(await typesStatus()).toBe(200);
            } finally { await ownerDb.raw("ALTER TABLE audit_logs DROP CONSTRAINT IF EXISTS chk_audit_doctor_suspended_test"); }
            expect((await suspend()).status).toBe(200);
        });

        it("should leave the job pending and converge on the next tick when recording the Identity result fails after Identity answered", async () => {
            await ownerDb.raw("ALTER TABLE audit_logs ADD CONSTRAINT chk_audit_sync_synced_test CHECK (action <> 'identity_sync.synced') NOT VALID");
            try {
                const res = await suspend();
                expect(res.status).toBe(500); expectErrorEnvelope(res.body, "InternalError");
                expect(identityStatus()).toBe("suspended");
                expect((await jobsOf())[0]?.status).toBe("pending");
                expect((await profileRow()).identity_sync_status).toBe("pending");
                expect(await typesStatus()).toBe(403);
            } finally { await ownerDb.raw("ALTER TABLE audit_logs DROP CONSTRAINT IF EXISTS chk_audit_sync_synced_test"); }
            await tick();
            expect((await jobsOf())[0]).toMatchObject({ status: "succeeded" });
            expect((await profileRow()).identity_sync_status).toBe("synced");
            expect(patches().map((p) => p.status)).toEqual(["suspended", "suspended"]);
        });
    });

    // ------------------------------------------------------------------------------------------ reinstate
    describe("reinstate", () => {
        beforeEach(async () => { expect((await suspend()).status).toBe(200); identityServer.statusBodies.length = 0; });

        it("should reinstate, confirm with Identity, audit and make the doctor bookable again", async () => {
            const requestId = randomUUID();
            const res = await reinstate(DOCTOR, "Synthetic reinstatement review", "admin", { "X-Request-Id": requestId });
            expect(res.status).toBe(200);
            expect(res.headers["cache-control"]).toBe("no-store");
            expect(Object.keys(res.body).sort()).toEqual(["data", "success"]);
            expect(Object.keys(res.body.data).sort()).toEqual([...(inlineLists(schemaBlock("ReinstatementResult"), "required")[0] ?? [])].sort());
            expect(res.body.data).toMatchObject({ doctorUserId: DOCTOR, identitySyncStatus: "synced" });
            expect(Number.isNaN(Date.parse(res.body.data.reinstatedAt as string))).toBe(false);
            expect(patches()).toEqual([{ userId: DOCTOR, status: "active", reason: "Synthetic reinstatement review", actorUserId: ADMIN, requestId }]);
            expect(identityStatus()).toBe("active");
            const profile = await profileRow();
            expect([profile.suspended_at, profile.suspended_by, profile.suspension_reason, profile.identity_sync_status]).toEqual([null, null, null, "synced"]);
            const jobs = await jobsOf();
            expect(jobs.map((job) => [job.kind, job.target_status, job.status])).toEqual([["suspension", "suspended", "succeeded"], ["reinstatement", "active", "succeeded"]]);
            expect((await auditOf("doctor.reinstated")).map((row) => [row.actor_role, row.entity_type, row.request_id])).toEqual([["admin", "doctor_profile", requestId]]);
            expect((await auditOf("doctor.reinstated"))[0]?.metadata).toEqual({ doctorUserId: DOCTOR, jobId: Number(jobs[1]?.id), reasonLength: "Synthetic reinstatement review".length, fromSyncStatus: "synced", toSyncStatus: "pending" });
            expect(await auditOf("identity_sync.synced")).toHaveLength(2);
            expect(await me()).toEqual(expect.objectContaining({ isSuspended: false, isBookable: true }));
            expect(await typesStatus()).toBe(200);
        });

        it("should answer 202 with a top-level identitySync pending and keep the doctor unbookable while Identity is down", async () => {
            down();
            const res = await reinstate();
            expect(res.status).toBe(202);
            expect(Object.keys(res.body).sort()).toEqual(["data", "identitySync", "success"]);
            expect(res.body).toMatchObject({ success: true, identitySync: "pending", data: { doctorUserId: DOCTOR, identitySyncStatus: "pending" } });
            expect(patches()).toHaveLength(3);
            expect(patches().every((p) => p.status === "active")).toBe(true);
            const profile = await profileRow();
            expect([profile.suspended_at, profile.identity_sync_status]).toEqual([null, "pending"]);
            const job = (await jobsOf())[1];
            expect(job).toMatchObject({ kind: "reinstatement", target_status: "active", status: "pending", attempts: 3, consecutive_failures: 1 });
            expect(identityStatus()).toBe("suspended");
            expect(await me()).toEqual(expect.objectContaining({ isSuspended: false, isBookable: false }));
            expect(await typesStatus()).toBe(200);
            expect((await auditOf("identity_sync.pending")).map((row) => row.actor_role)).toEqual(["admin"]);
        });

        it("should flip isBookable to true only after the worker syncs a pending reinstatement and leave the flags alone", async () => {
            impact.ids = [11]; impact.flagCalls.length = 0;
            down();
            expect((await reinstate()).status).toBe(202);
            expect((await me()).isBookable).toBe(false);
            heal();
            await tick();
            expect(await me()).toEqual(expect.objectContaining({ isSuspended: false, isBookable: true }));
            expect(identityStatus()).toBe("active");
            expect((await auditOf("identity_sync.synced")).map((row) => row.actor_role)).toEqual(["admin", "system"]);
            expect(impact.flagCalls).toHaveLength(0);
        });

        it("should re-report 202 pending to a blind retry without a second job, audit row or Identity call, then 200 once synced", async () => {
            down();
            expect((await reinstate()).status).toBe(202);
            const before = await snapshot();
            for (let index = 0; index < 2; index += 1) {
                const retry = await reinstate();
                expect(retry.status).toBe(202);
                expect(retry.body).toMatchObject({ identitySync: "pending", data: { identitySyncStatus: "pending" } });
            }
            await expectUntouched(before);
            expect((await jobsOf()).filter((job) => job.kind === "reinstatement")).toHaveLength(1);
            expect(await auditOf("doctor.reinstated")).toHaveLength(1);
            heal();
            await tick();
            const done = await reinstate();
            expect(done.status).toBe(200); expect(done.body.data.identitySyncStatus).toBe("synced");
            expect(patches().filter((p) => p.status === "active")).toHaveLength(4);
        });

        it("should replay a stored 202 for the same Idempotency-Key and reject the same key with another body", async () => {
            down();
            const headers = { "Idempotency-Key": randomUUID() };
            const first = await reinstate(DOCTOR, REASON, "admin", headers);
            expect(first.status).toBe(202);
            const before = await snapshot();
            heal();
            const replay = await reinstate(DOCTOR, REASON, "admin", headers);
            expect(replay.status).toBe(202); expect(replay.body).toEqual(first.body);
            await expectUntouched(before);
            const conflict = await reinstate(DOCTOR, "another reason entirely", "admin", headers);
            expect(conflict.status).toBe(422); expectErrorEnvelope(conflict.body, "IdempotencyConflict");
        });

        it("should answer 202 failed when Identity rejects the transition, mark job and profile failed, page and never retry", async () => {
            identityServer.options.forceConflict = true;
            const capture = captureLogs();
            let res: request.Response;
            try { res = await reinstate(); } finally { capture.restore(); }
            expect(res.status).toBe(202);
            expect(res.body).toMatchObject({ identitySync: "failed", data: { identitySyncStatus: "failed" } });
            const job = (await jobsOf())[1];
            expect(job).toMatchObject({ kind: "reinstatement", status: "failed", last_error_code: "InvalidStatusTransition" });
            expect(capture.lines().filter((line) => line.message === "IdentitySyncTransitionRejected")).toEqual([
                expect.objectContaining({ level: "error", kind: "reinstatement", jobId: Number(job?.id) })]);
            const profile = await profileRow();
            expect([profile.suspended_at, profile.identity_sync_status]).toEqual([null, "failed"]);
            expect(patches()).toHaveLength(1);
            await tick(); await tick();
            expect(patches()).toHaveLength(1);
            expect(await me()).toEqual(expect.objectContaining({ isSuspended: false, isBookable: false }));
            const before = await snapshot();
            const retry = await reinstate();
            expect(retry.status).toBe(202); expect(retry.body).toMatchObject({ identitySync: "failed", data: { identitySyncStatus: "failed" } });
            await expectUntouched(before);
        });

        it("should answer 202 failed and page once when Identity refuses the reinstatement itself (403), without retrying", async () => {
            identityServer.options.statusFailures = 10;
            identityServer.options.statusFailureCode = 403;
            const capture = captureLogs();
            let res: request.Response;
            try { res = await reinstate(); } finally { capture.restore(); }
            expect(res.status).toBe(202);
            expect(res.body).toMatchObject({ identitySync: "failed", data: { identitySyncStatus: "failed" } });
            expect((await jobsOf())[1]).toMatchObject({ kind: "reinstatement", status: "failed", last_error_code: "HTTP_403" });
            expect(capture.lines().filter((line) => line.message === "IdentitySyncTransitionRejected")).toHaveLength(1);
            await tick(); await tick();
            expect(patches()).toHaveLength(1);
        });

        it("should log IdentityReinstatementSyncPending once, only after the 15 minute window of unsynced time", async () => {
            down();
            expect((await reinstate()).status).toBe(202);
            const created = dateOf((await jobsOf())[1]?.created_at);
            const capture = captureLogs();
            try {
                clock.set(created + 900_000 - 1);
                await expect(loop().tick(new AbortController().signal)).resolves.toBe("done");
                expect(capture.lines().filter((line) => line.message === "IdentityReinstatementSyncPending")).toHaveLength(0);
                clock.set(created + 960_000);
                await expect(loop().tick(new AbortController().signal)).resolves.toBe("done");
                clock.set(created + 1_100_000);
                await expect(loop().tick(new AbortController().signal)).resolves.toBe("done");
            } finally { capture.restore(); }
            const alerts = capture.lines().filter((line) => line.message === "IdentityReinstatementSyncPending");
            expect(alerts).toEqual([expect.objectContaining({ level: "error", kind: "reinstatement", profileId: Number((await profileRow()).id) })]);
            expect((await jobsOf())[1]?.status).toBe("pending");
        });
    });

    describe("reinstate preconditions", () => {
        it.each(["pending", "failed"])("should answer 409 and change nothing for a suspended profile whose suspension sync is %s", async (sync) => {
            if (sync === "pending") down(); else identityServer.options.forceConflict = true;
            expect((await suspend()).status).toBe(503);
            heal();
            const before = await snapshot();
            const res = await reinstate();
            expect(res.status).toBe(409); expectErrorEnvelope(res.body, "InvalidTransition", res.headers["x-request-id"]);
            await expectUntouched(before);
        });
    });

    describe("reinstate on a doctor who is not suspended", () => {
        it("should answer 200 carrying the current sync status and write nothing when nothing is unsynced", async () => {
            const before = await snapshot();
            const res = await reinstate();
            expect(res.status).toBe(200);
            expect(res.body.data).toMatchObject({ doctorUserId: DOCTOR, identitySyncStatus: "synced" });
            expect(Date.parse(res.body.data.reinstatedAt as string)).toBe(clock.now());
            await expectUntouched(before);
        });

        it("should answer 200 not_required for a profile that never had a decision", async () => {
            await ownerDb("doctor_profiles").where("user_id", DOCTOR).update({ verification_status: "draft", decided_at: null, identity_sync_status: "not_required" });
            const before = await snapshot();
            const res = await reinstate();
            expect(res.status).toBe(200); expect(res.body.data.identitySyncStatus).toBe("not_required");
            await expectUntouched(before);
        });

        it("should answer 200 when the unsynced job is not a reinstatement (only a reinstatement is re-reported)", async () => {
            await ownerDb("doctor_profiles").where("user_id", DOCTOR).update({ identity_sync_status: "pending" });
            const profile = await profileRow();
            await ownerDb("identity_sync_jobs").insert({ doctor_profile_id: Number(profile.id), doctor_user_id: DOCTOR, kind: "verification", target_status: "active", reason: "approve", actor_user_id: ADMIN,
                status: "pending", next_attempt_at: new Date(clock.now() + 60_000) });
            const before = await snapshot();
            const res = await reinstate();
            expect(res.status).toBe(200); expect(res.body.data.identitySyncStatus).toBe("pending");
            await expectUntouched(before);
        });

        it("should answer 404 NotFound for an unknown, soft-deleted or non-doctor id", async () => {
            await seedDoctor(OTHER, { deleted_at: new Date() }, false);
            for (const id of [999, OTHER, 101]) {
                const res = await reinstate(id);
                expect([id, res.status]).toEqual([id, 404]);
                expectErrorEnvelope(res.body, "NotFound");
            }
        });

        it("should reinstate exactly once when two reinstates race", async () => {
            expect((await suspend()).status).toBe(200);
            identityServer.statusBodies.length = 0;
            const results = await Promise.all([reinstate(), reinstate()]);
            expect(results.map((res) => res.status)).toContain(200);
            for (const res of results) expect([200, 202]).toContain(res.status);
            expect((await jobsOf()).filter((job) => job.kind === "reinstatement")).toHaveLength(1);
            expect(await auditOf("doctor.reinstated")).toHaveLength(1);
            expect(patches().filter((p) => p.status === "active")).toHaveLength(1);
            expect(identityStatus()).toBe("active");
        });
    });

    // ------------------------------------------------------------------------------------------ reason handling
    describe("reason handling", () => {
        const LONG = `${MARKER} ${EMOJI.repeat(1978)}`;

        it("should store a 2000 code point reason in full, send Identity exactly 500 code points and still confirm", async () => {
            expect(codePoints(LONG)).toBe(2000);
            const res = await suspend(DOCTOR, LONG);
            expect(res.status).toBe(200);
            expect(patches()).toHaveLength(1);
            const sent = patches()[0]?.reason as string;
            expect(codePoints(sent)).toBe(FAKE_IDENTITY_REASON_MAX);
            expect(LONG.startsWith(sent)).toBe(true);
            expect((await profileRow()).suspension_reason).toBe(LONG);
            expect((await jobsOf())[0]?.reason).toBe(LONG);
            expect((await jobsOf())[0]?.status).toBe("succeeded");
            const back = await reinstate(DOCTOR, LONG);
            expect(back.status).toBe(200);
            expect(codePoints(patches()[1]?.reason as string)).toBe(500);
            expect(identityStatus()).toBe("active");
        });

        it("should send exactly the original text when the reason is within 500 code points", async () => {
            const exact = `${MARKER} ${"r".repeat(478)}`;
            expect(codePoints(exact)).toBe(500);
            await suspend(DOCTOR, exact);
            expect(patches()[0]?.reason).toBe(exact);
        });

        it("should clamp the reason of a verification rejection of 600 characters and reach synced", async () => {
            await ownerDb("doctor_profiles").where("user_id", DOCTOR).update({ verification_status: "submitted", decided_at: null, submitted_at: new Date(), identity_sync_status: "not_required" });
            identityServer.users.get(DOCTOR)!.status = "pending";
            const id = Number((await profileRow()).id);
            const reason = `${MARKER} ${"v".repeat(578)}`;
            expect(reason.length).toBe(600);
            const res = await call("patch", `/api/admin/applications/${id}/reject`, "admin", { reason });
            expect(res.status).toBe(200);
            expect(patches()).toHaveLength(1);
            expect(codePoints(patches()[0]?.reason as string)).toBe(500);
            expect(identityStatus()).toBe("rejected");
            expect((await jobsOf())[0]).toMatchObject({ kind: "verification", status: "succeeded", reason });
            expect((await profileRow()).identity_sync_status).toBe("synced");
        });

        it("should keep the reason out of audit metadata and every captured log line", async () => {
            jest.replaceProperty(logger as unknown as { level: string }, "level", "debug");
            const capture = captureLogs();
            try {
                down();
                expect((await suspend(DOCTOR, LONG)).status).toBe(503);
                heal();
                await tick();
                expect((await reinstate(DOCTOR, LONG)).status).toBe(200);
                identityServer.options.forceConflict = true;
                expect((await suspend(DOCTOR, LONG)).status).toBe(503);
            } finally { capture.restore(); }
            expect(capture.lines().some((line) => line.message === "doctor_suspension_applied" && typeof line.jobId === "number" && typeof line.doctorProfileId === "number")).toBe(true);
            expectNoSensitiveStrings(capture, [MARKER, ...Object.values(tokens), "Bearer ", "Authorization"]);
            const audits = await ownerDb("audit_logs");
            expect(audits.length).toBeGreaterThan(0);
            for (const row of audits) {
                expect(JSON.stringify(row.metadata)).not.toContain(MARKER);
                expect(Object.keys(row.metadata as object).some((key) => /reason$/i.test(key) && key !== "reasonLength")).toBe(false);
            }
        });
    });

    // ------------------------------------------------------------------------------------------ idempotency, redis and limits
    describe("idempotency", () => {
        it("should replay the stored 200 for the same key and body, calling Identity once", async () => {
            const headers = { "Idempotency-Key": randomUUID() };
            const first = await suspend(DOCTOR, REASON, "admin", headers);
            const replay = await suspend(DOCTOR, REASON, "admin", headers);
            expect([first.status, replay.status]).toEqual([200, 200]);
            expect(replay.body).toEqual(first.body);
            expect(patches()).toHaveLength(1); expect(await jobsOf()).toHaveLength(1); expect(await auditOf("doctor.suspended")).toHaveLength(1);
        });

        it("should answer 422 IdempotencyConflict for the same key with another body", async () => {
            const headers = { "Idempotency-Key": randomUUID() };
            expect((await suspend(DOCTOR, REASON, "admin", headers)).status).toBe(200);
            const conflict = await suspend(DOCTOR, "a different synthetic reason", "admin", headers);
            expect(conflict.status).toBe(422); expectErrorEnvelope(conflict.body, "IdempotencyConflict");
        });

        it("should answer 400 for an Idempotency-Key that is not a UUID", async () => {
            const res = await suspend(DOCTOR, REASON, "admin", { "Idempotency-Key": "not-a-uuid" });
            expect(res.status).toBe(400); expectErrorEnvelope(res.body, "ValidationFailed");
        });

        it("should not store a 503 so that the retry executes again as the no-op re-report", async () => {
            down();
            const headers = { "Idempotency-Key": randomUUID() };
            const first = await suspend(DOCTOR, REASON, "admin", headers);
            expect(first.status).toBe(503);
            expect(await redis.keys("idem:*")).toEqual([]);
            const before = await snapshot();
            const retry = await suspend(DOCTOR, REASON, "admin", headers);
            expect(retry.status).toBe(503); expect(retry.body.suspension).toBe(PENDING_MARKER);
            await expectUntouched(before);
        });

        it("should keep both routes working and create no duplicate when Redis is unreachable", async () => {
            const unreachable = createUnreachableRedis();
            try {
                await withContainerOverrides([{ token: TOKENS.Redis, value: unreachable }], async () => {
                    const key = { "Idempotency-Key": randomUUID() };
                    expect((await suspend(DOCTOR, REASON, "admin", key)).status).toBe(200);
                    const again = await suspend(DOCTOR, REASON, "admin", key);
                    expect(again.status).toBe(200);
                    expect((await reinstate(DOCTOR, REASON, "admin", key)).status).toBe(200);
                });
            } finally { unreachable.disconnect(); }
            expect(patches().map((p) => p.status)).toEqual(["suspended", "active"]);
            expect(await jobsOf()).toHaveLength(2);
        });
    });

    describe("rate limit", () => {
        it("should answer the 31st write in a minute by one admin with 429 across both routes, and give another admin their own bucket", async () => {
            for (let index = 0; index < 30; index += 1) expect((await (index % 2 === 0 ? suspend(999) : reinstate(999))).status).toBe(404);
            const limited = await suspend(999);
            expect(limited.status).toBe(429); expectErrorEnvelope(limited.body, "RateLimited");
            expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
            expect((await reinstate(999)).status).toBe(429);
            expect((await suspend(999, REASON, "admin2")).status).toBe(404);
            expect((await suspend(DOCTOR, REASON, "admin")).status).toBe(429);
            expect(await jobsOf()).toHaveLength(0);
        });
    });

    // ------------------------------------------------------------------------------------------ worker
    describe("worker", () => {
        it("should list suspension jobs before older verification jobs and process all kinds in one tick", async () => {
            const stamp = clock.now();
            const mk = async (userId: number, kind: "verification" | "suspension" | "reinstatement", target: string, from: string, minutesAgo: number, profileChanges: Record<string, unknown>): Promise<number> => {
                const profileId = await seedDoctor(userId, { identity_sync_status: "pending", ...profileChanges }, false);
                identityServer.users.set(userId, { id: userId, fullName: `Synthetic ${userId}`, avatarUrl: null, status: from as "active" });
                const rows = await ownerDb("identity_sync_jobs").insert({ doctor_profile_id: profileId, doctor_user_id: userId, kind, target_status: target, reason: `synthetic ${kind}`, actor_user_id: ADMIN,
                    status: "pending", next_attempt_at: new Date(stamp - minutesAgo * 60_000) }).returning("id");
                return Number((rows[0] as { id: number }).id);
            };
            const v1 = await mk(401, "verification", "active", "pending", 30, {});
            const v2 = await mk(402, "verification", "active", "pending", 20, {});
            const v3 = await mk(403, "verification", "active", "pending", 10, {});
            const r1 = await mk(405, "reinstatement", "active", "suspended", 5, {});
            const s1 = await mk(404, "suspension", "suspended", "active", 1, { suspended_at: new Date(), suspension_reason: "synthetic", suspended_by: ADMIN });
            expect(await identitySync.listDueJobIds(50)).toEqual([s1, v1, v2, v3, r1]);
            await expect(loop().tick(new AbortController().signal)).resolves.toBe("done");
            expect(patches().map((p) => p.userId)).toEqual([404, 401, 402, 403, 405]);
            expect((await ownerDb("identity_sync_jobs").orderBy("id")).map((job) => job.status)).toEqual(["succeeded", "succeeded", "succeeded", "succeeded", "succeeded"]);
            expect((await ownerDb("doctor_profiles").whereIn("user_id", [401, 402, 403, 404, 405])).every((row) => row.identity_sync_status === "synced")).toBe(true);
            expect(await identitySync.listDueJobIds(50)).toEqual([]);
        });

        it("should not send a job whose next attempt is still in the future even if the tick lists nothing else", async () => {
            down();
            expect((await suspend()).status).toBe(503);
            heal();
            expect(await identitySync.listDueJobIds(50)).toEqual([]);
            clock.advance(CAP_MS + 1);
            expect(await identitySync.listDueJobIds(50)).toHaveLength(1);
        });
    });

    // ------------------------------------------------------------------------------------------ contract and boot
    describe("contract conformance", () => {
        it("should render 200, 503, 202 and error bodies in the shapes the contract declares", async () => {
            const ok = await suspend();
            expect(ok.body.success).toBe(true);
            expect(Object.keys(ok.body.data).sort()).toEqual([...(inlineLists(schemaBlock("SuspensionResult"), "required")[0] ?? [])].sort());
            expect(typeof ok.body.data.doctorUserId).toBe("number");
            expect(Array.isArray(ok.body.data.flaggedConsultationIds)).toBe(true);
            expect(["not_required", "pending", "synced", "failed"]).toContain(ok.body.data.identitySyncStatus);
            await reinstate();
            await ownerDb("doctor_profiles").where("user_id", DOCTOR).update({ suspended_at: null, suspension_reason: null, suspended_by: null, identity_sync_status: "synced" });
            down();
            const pending = await suspend();
            expect(pending.status).toBe(503);
            const [required = []] = inlineLists(schemaBlock("SuspensionPending"), "required");
            for (const key of required) expect(Object.keys(pending.body)).toContain(key);
            expect(Object.keys(pending.body.data).sort()).toEqual([...(inlineLists(schemaBlock("SuspensionResult"), "required")[0] ?? [])].sort());
            heal(); await tick();
            down();
            const accepted = await reinstate();
            expect(accepted.status).toBe(202);
            for (const key of ["success", "data", "identitySync"]) expect(Object.keys(accepted.body)).toContain(key);
            expect(["pending", "failed"]).toContain(accepted.body.identitySync);
            expect(Object.keys(accepted.body.data).sort()).toEqual([...(inlineLists(schemaBlock("ReinstatementResult"), "required")[0] ?? [])].sort());
            expect((await call("patch", suspendUrl("abc"), "admin", { reason: REASON })).status).toBe(400);
        });

        it("should expose only declared statuses and no secret, token, URL or clinical field in any admin-doctors body", () => {
            const suspendCodes = contractResponseCodes("/api/admin/doctors/{doctorUserId}/suspend", "patch");
            const reinstateCodes = contractResponseCodes("/api/admin/doctors/{doctorUserId}/reinstate", "patch");
            const observed = (verb: string, route: string): number[] => [...(seen.get(`${verb} /api/admin/doctors/{doctorUserId}/${route}`) ?? [])];
            // 422 IdempotencyConflict is returned by the routes (spec 3.1) but not yet declared by the operations: see the test.failing in tests/unit/contract/admin-doctors-contract.test.ts.
            for (const status of observed("patch", "suspend").filter((code) => code !== 422)) expect(suspendCodes).toContain(String(status));
            for (const status of observed("patch", "reinstate").filter((code) => code !== 422)) expect(reinstateCodes).toContain(String(status));
            expect(observed("patch", "suspend")).toEqual(expect.arrayContaining([200, 400, 401, 403, 404, 409, 429, 500, 503]));
            expect(observed("patch", "reinstate")).toEqual(expect.arrayContaining([200, 202, 400, 401, 403, 404, 409, 429]));
            expect(bodies.length).toBeGreaterThan(20);
            const text = JSON.stringify(bodies);
            expect(text).not.toMatch(/https?:\/\/|Bearer |password|secret|eyJ|allerg|diagnos|medicalRecord|"stack"/i);
            expect(text).not.toContain(MARKER);
            for (const value of Object.values(tokens)) expect(text).not.toContain(value);
        });
    });

    describe("boot", () => {
        it("should resolve the engine and the admin-doctors graph from the container", () => {
            expect(container.resolve(TOKENS.IdentitySyncService)).toBeInstanceOf(IdentitySyncService);
            expect(container.resolve(TOKENS.AdminDoctorsService)).toBeInstanceOf(AdminDoctorsService);
            expect(container.resolve(TOKENS.AdminDoctorsController)).toBeInstanceOf(AdminDoctorsController);
        });
    });
});
