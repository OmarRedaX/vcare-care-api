import { randomUUID } from "node:crypto";
import type { Express } from "express";
import request from "supertest";
import type { Test } from "supertest";
import { db } from "../../src/lib/knex/knex";
import { redis } from "../../src/lib/redis/redis";
import { container } from "../../src/lib/di/container";
import { logger } from "../../src/lib/logger/logger";
import { TOKENS } from "../../src/lib/di/tokens";
import { buildTestApps } from "../helpers/app";
import { contractNoStoreValue, contractResponseCodes, expectErrorEnvelope, inlineLists, schemaBlock } from "../helpers/contract";
import { closeDb, ownerDb, truncateAll } from "../helpers/db";
import { buildFakeJwksWiring, startFakeJwks } from "../helpers/fake-jwks";
import { captureLogs, expectNoSensitiveStrings } from "../helpers/log-capture";
import { closeRedis, ensureRedisReady, flushByPrefix } from "../helpers/redis";
import { signExpiredUserToken, signUserToken } from "../helpers/tokens";
import type { FakeJwks, FakeJwksWiring } from "../helpers/types";

jest.setTimeout(60_000);

const ME = "/api/patients/me";
const ALLERGEN = "TEST-ALLERGEN-7731";
const CONDITION = "TEST-CONDITION-7731";
const DOB = "1987-03-09";
const full = (changes: Record<string, unknown> = {}): Record<string, unknown> => ({ dateOfBirth: DOB, gender: "female", bloodType: "AB-",
    allergies: [ALLERGEN, "TEST-ALLERGEN-B"], chronicConditions: [CONDITION], timezone: "Africa/Cairo", ...changes });

type Actor = "patient" | "other" | "pending" | "rejected" | "suspended" | "doctor" | "pendingDoctor" | "admin" | "expired";
type Verb = "get" | "patch";

describe("patients (integration: real routes, Postgres and Redis)", () => {
    let fake: FakeJwks;
    let wiring: FakeJwksWiring;
    let app: Express;
    const tokens = {} as Record<Actor, string>;
    const previous: Array<{ token: symbol; value: unknown }> = [];
    const seen = new Map<string, Set<number>>();

    function call(verb: Verb, actor?: Actor, payload?: object, headers: Record<string, string> = {}): Test {
        const test = request(app)[verb](ME).set(headers);
        const original = test.end.bind(test) as (callback?: (error: Error | null, res: request.Response) => void) => Test;
        test.end = ((callback?: (error: Error | null, res: request.Response) => void): Test => original((error, res) => {
            if (res !== undefined) { const key = `${verb} ${ME}`; const set = seen.get(key) ?? new Set<number>(); set.add(res.status); seen.set(key, set); }
            callback?.(error, res);
        })) as Test["end"];
        if (actor !== undefined) test.set("Authorization", `Bearer ${tokens[actor]}`);
        if (payload !== undefined) test.send(payload);
        return test;
    }
    const get = (actor: Actor = "patient"): Test => call("get", actor);
    const patch = (payload: object, actor: Actor = "patient", headers: Record<string, string> = {}): Test => call("patch", actor, payload, headers);
    const rows = () => ownerDb("patient_profiles").select("*").orderBy("id");
    const audits = () => ownerDb("audit_logs").select("actor_user_id", "actor_role", "action", "entity_type", "entity_id", "request_id", "metadata")
        .where("entity_type", "patient_profile").orderBy("id");
    const fields = (res: request.Response): string[] => (res.body.error.details as Array<{ field: string }>).map((detail) => detail.field);
    const expectNoStore = (res: request.Response): void => {
        expect(res.headers["cache-control"]).toBe(contractNoStoreValue());
        expect(res.headers["x-request-id"]).toBeDefined();
    };

    beforeAll(async () => {
        await ensureRedisReady();
        fake = await startFakeJwks(["patients"]);
        wiring = await buildFakeJwksWiring(fake);
        for (const token of [TOKENS.JwksCache, TOKENS.UserTokenVerifier]) previous.push({ token, value: container.isRegistered(token) ? container.resolve(token) : undefined });
        container.registerInstance(TOKENS.JwksCache, wiring.cache);
        container.registerInstance(TOKENS.UserTokenVerifier, wiring.verifier);
        app = buildTestApps().publicApp;
        const claims: Array<[Actor, string, "doctor" | "patient" | "admin", "pending" | "active" | "rejected" | "suspended"]> = [
            ["patient", "101", "patient", "active"], ["other", "102", "patient", "active"], ["pending", "103", "patient", "pending"],
            ["rejected", "104", "patient", "rejected"], ["suspended", "105", "patient", "suspended"],
            ["doctor", "202", "doctor", "active"], ["pendingDoctor", "203", "doctor", "pending"], ["admin", "303", "admin", "active"],
        ];
        for (const [name, sub, role, status] of claims) tokens[name] = await signUserToken(fake.key("patients"), { sub, role, status });
        tokens.expired = await signExpiredUserToken(fake.key("patients"), { sub: "101", role: "patient", status: "active" });
    });
    beforeEach(async () => { await truncateAll(); await flushByPrefix(["idem:", "rl:"]); });
    afterAll(async () => {
        await truncateAll(); await flushByPrefix(["idem:", "rl:"]);
        for (const entry of previous) if (entry.value !== undefined) container.registerInstance(entry.token, entry.value);
        wiring.cache.stop(); await fake.close(); await closeRedis(); await closeDb();
    });

    // ───────────────────────────────────────────── RBAC
    it.each([["get", undefined], ["patch", full()]] as const)("should return 401 on %s when unauthenticated", async (verb, payload) => {
        const res = await call(verb, undefined, payload);
        expect(res.status).toBe(401); expectErrorEnvelope(res.body, "Unauthorized", res.headers["x-request-id"]);
        expect(await rows()).toHaveLength(0);
    });

    it.each([["get", undefined], ["patch", full()]] as const)("should return 401 TokenExpired on %s when the token is expired", async (verb, payload) => {
        const res = await call(verb, "expired", payload);
        expect(res.status).toBe(401); expectErrorEnvelope(res.body, "TokenExpired");
    });

    it.each([["get", undefined], ["patch", full()]] as const)("should return 403 on %s for doctor and admin of any status", async (verb, payload) => {
        for (const actor of ["doctor", "pendingDoctor", "admin"] as const) {
            const res = await call(verb, actor, payload);
            expect(res.status).toBe(403); expectErrorEnvelope(res.body, "Forbidden", res.headers["x-request-id"]); expectNoStore(res);
        }
        expect(await rows()).toHaveLength(0); expect(await audits()).toHaveLength(0);
    });

    it.each([["get", undefined], ["patch", full()]] as const)("should return 403 on %s when the patient token status is not active", async (verb, payload) => {
        for (const actor of ["pending", "rejected", "suspended"] as const) {
            const res = await call(verb, actor, payload);
            expect(res.status).toBe(403); expectErrorEnvelope(res.body, "Forbidden");
        }
        expect(await rows()).toHaveLength(0);
    });

    it("should deny an admin even when a profile with clinical data exists, and never leak clinical fields", async () => {
        expect((await patch(full())).status).toBe(200);
        for (const verb of ["get", "patch"] as const) {
            const res = await call(verb, "admin", verb === "patch" ? { gender: "male" } : undefined);
            expect(res.status).toBe(403);
            expect(JSON.stringify(res.body)).not.toContain(ALLERGEN);
        }
        expect((await rows())[0].gender).toBe("female");
    });

    it("should allow a patient whose email is not verified because only booking needs it", async () => {
        const token = await signUserToken(fake.key("patients"), { sub: "106", role: "patient", status: "active", ev: false });
        const res = await request(app).patch(ME).set("Authorization", `Bearer ${token}`).send({ timezone: "UTC" });
        expect(res.status).toBe(200);
    });

    it("should ignore spoofed identity headers and use the verified token only", async () => {
        const res = await call("patch", "patient", full(), { "X-User-Id": "102", "X-Role": "admin", "X-Forwarded-User": "102" });
        expect(res.status).toBe(200); expect(res.body.data.userId).toBe(101);
        const denied = await call("get", "doctor", undefined, { "X-User-Id": "101", "X-Role": "patient" });
        expect(denied.status).toBe(403);
        expect((await rows()).map((row) => Number(row.user_id))).toEqual([101]);
    });

    // ───────────────────────────────────────────── ownership
    it("should isolate two patients and give each only their own profile", async () => {
        expect((await patch(full())).status).toBe(200);
        expect((await get("other")).status).toBe(404);
        expect((await patch({ timezone: "Europe/Berlin", allergies: ["TEST-OTHER-ALLERGEN"] }, "other")).status).toBe(200);
        const mine = await get("patient"); const theirs = await get("other");
        expect(mine.body.data).toMatchObject({ userId: 101, timezone: "Africa/Cairo", allergies: [ALLERGEN, "TEST-ALLERGEN-B"] });
        expect(theirs.body.data).toMatchObject({ userId: 102, timezone: "Europe/Berlin", allergies: ["TEST-OTHER-ALLERGEN"] });
        expect(mine.body.data.id).not.toBe(theirs.body.data.id);
    });

    it.each(["userId", "id", "user_id"])("should reject body member %s with 400 and never redirect the write", async (member) => {
        expect((await patch(full())).status).toBe(200);
        const res = await patch({ gender: "male", [member]: 102 }, "other");
        expect(res.status).toBe(400); expectErrorEnvelope(res.body, "ValidationFailed"); expect(fields(res)).toContain(member);
        expect(await rows()).toHaveLength(1); expect((await rows())[0].gender).toBe("female");
    });

    // ───────────────────────────────────────────── flow
    it("should return 404 before the profile exists and write no audit row", async () => {
        const res = await get();
        expect(res.status).toBe(404); expectErrorEnvelope(res.body, "NotFound"); expectNoStore(res);
        expect(await audits()).toHaveLength(0);
    });

    it("should return 400 and write nothing when the first PATCH has no timezone", async () => {
        const res = await patch({ allergies: [ALLERGEN] });
        expect(res.status).toBe(400); expectErrorEnvelope(res.body, "ValidationFailed"); expect(fields(res)).toEqual(["timezone"]);
        expect(JSON.stringify(res.body)).not.toContain(ALLERGEN);
        expect(await rows()).toHaveLength(0); expect(await audits()).toHaveLength(0);
    });

    it("should create with 200, empty lists and null scalars when only timezone is sent, canonicalizing the zone", async () => {
        const res = await patch({ timezone: "africa/cairo" });
        expect(res.status).toBe(200); expectNoStore(res);
        expect(res.body.data).toMatchObject({ userId: 101, dateOfBirth: null, gender: null, bloodType: null, allergies: [], chronicConditions: [], timezone: "Africa/Cairo" });
        const read = await get();
        expect(read.status).toBe(200); expect(read.body.data).toEqual(res.body.data);
    });

    it("should create from a full body and round-trip every member with list order preserved", async () => {
        const res = await patch(full({ allergies: ["TEST-Z", "TEST-A", "TEST-M"] }));
        expect(res.status).toBe(200);
        expect(res.body.data).toMatchObject(full({ allergies: ["TEST-Z", "TEST-A", "TEST-M"] }));
        expect((await get()).body.data.allergies).toEqual(["TEST-Z", "TEST-A", "TEST-M"]);
    });

    it("should keep untouched members on a partial PATCH, clear with null, and replace arrays whole", async () => {
        await patch(full());
        const partial = await patch({ gender: "male" });
        expect(partial.body.data).toMatchObject({ gender: "male", dateOfBirth: DOB, bloodType: "AB-", allergies: [ALLERGEN, "TEST-ALLERGEN-B"], timezone: "Africa/Cairo" });
        const cleared = await patch({ dateOfBirth: null, gender: null, bloodType: null });
        expect(cleared.body.data).toMatchObject({ dateOfBirth: null, gender: null, bloodType: null, chronicConditions: [CONDITION] });
        const replaced = await patch({ allergies: ["TEST-ONLY-ONE"], chronicConditions: [] });
        expect(replaced.body.data).toMatchObject({ allergies: ["TEST-ONLY-ONE"], chronicConditions: [] });
        expect((await rows())).toHaveLength(1);
    });

    it("should return the stored calendar date unchanged regardless of the server zone", async () => {
        await patch(full({ dateOfBirth: "2000-01-01" }));
        expect((await get()).body.data.dateOfBirth).toBe("2000-01-01");
    });

    it("should bump updated_at and keep created_at on a real change", async () => {
        await patch(full());
        await ownerDb("patient_profiles").where("user_id", 101).update({ updated_at: new Date("2020-01-01T00:00:00Z") });
        const before = (await rows())[0];
        const res = await patch({ bloodType: "O+" });
        expect(res.status).toBe(200);
        const after = (await rows())[0];
        expect(after.updated_at.getTime()).toBeGreaterThan(new Date("2020-01-01T00:00:00Z").getTime());
        expect(after.created_at).toEqual(before.created_at);
        expect(res.body.data.updatedAt).toBe(after.updated_at.toISOString());
    });

    it("should leave updated_at and audit rows unchanged for a no-op PATCH", async () => {
        await patch(full());
        const before = (await rows())[0];
        const res = await patch(full({ timezone: "AFRICA/CAIRO" }));
        expect(res.status).toBe(200);
        expect((await rows())[0].updated_at).toEqual(before.updated_at);
        expect(await audits()).toHaveLength(1);
    });

    it("should treat a re-ordered list as a real change", async () => {
        await patch(full());
        await patch({ allergies: ["TEST-ALLERGEN-B", ALLERGEN] });
        expect((await get()).body.data.allergies).toEqual(["TEST-ALLERGEN-B", ALLERGEN]);
        expect((await audits())[1]?.metadata).toEqual({ created: false, changedFields: "allergies" });
    });

    it("should ignore a sent Idempotency-Key because the route declares none", async () => {
        const headers = { "Idempotency-Key": randomUUID() };
        expect((await patch(full(), "patient", headers)).status).toBe(200);
        expect((await patch(full({ gender: "male" }), "patient", headers)).status).toBe(200);
        expect((await get()).body.data.gender).toBe("male");
    });

    // ───────────────────────────────────────────── validation
    it.each([
        ["empty body", {}, "body"],
        ["null timezone", { timezone: null }, "timezone"],
        ["null allergies", { allergies: null }, "allergies"],
        ["null conditions", { chronicConditions: null }, "chronicConditions"],
        ["invalid zone", { timezone: "Not/AZone" }, "timezone"],
        ["long zone", { timezone: "x".repeat(65) }, "timezone"],
        ["bad gender", { gender: "robot" }, "gender"],
        ["bad blood type", { bloodType: "Z+" }, "bloodType"],
        ["non-calendar date", { dateOfBirth: "2027-02-30" }, "dateOfBirth"],
        ["datetime date", { dateOfBirth: "1990-01-01T00:00:00Z" }, "dateOfBirth"],
        ["future date", { dateOfBirth: "2999-01-01" }, "dateOfBirth"],
        ["51 allergies", { allergies: Array.from({ length: 51 }, (_, i) => `TEST-A-${i}`) }, "allergies"],
        ["201 char item", { chronicConditions: ["x".repeat(201)] }, "chronicConditions"],
        ["blank item", { allergies: ["  "] }, "allergies"],
        ["control char item", { allergies: ["TEST-\u0001-X"] }, "allergies"],
        ["duplicate item", { chronicConditions: ["TEST-DUP", "TEST-DUP"] }, "chronicConditions"],
        ["non-string item", { allergies: [5] }, "allergies"],
        ["unknown member", { diagnosis: "TEST-DIAGNOSIS" }, "diagnosis"],
    ] as const)("should return 400 for %s without persisting or echoing the value", async (_label, change, field) => {
        await patch(full());
        const res = await patch(change);
        expect(res.status).toBe(400); expectErrorEnvelope(res.body, "ValidationFailed", res.headers["x-request-id"]); expectNoStore(res);
        expect(fields(res)).toContain(field);
        expect(JSON.stringify(res.body)).not.toMatch(/TEST-(DUP|DIAGNOSIS|A-)/);
        expect((await rows())[0]).toMatchObject({ gender: "female", timezone: "Africa/Cairo" });
        expect(await audits()).toHaveLength(1);
    });

    it("should return 400 for a non-object body", async () => {
        const res = await request(app).patch(ME).set("Authorization", `Bearer ${tokens.patient}`).set("Content-Type", "application/json").send("[1,2]");
        expect(res.status).toBe(400); expectErrorEnvelope(res.body, "ValidationFailed"); expectNoStore(res);
        const scalar = await request(app).patch(ME).set("Authorization", `Bearer ${tokens.patient}`).set("Content-Type", "application/json").send("5");
        expect(scalar.status).toBe(400); expectNoStore(scalar);
    });

    it("should never return 500 for malformed JSON", async () => {
        const res = await request(app).patch(ME).set("Authorization", `Bearer ${tokens.patient}`).set("Content-Type", "application/json").send("{bad");
        expect(res.status).toBe(400); expectNoStore(res);
    });

    it("should reject a future date of birth using the patient's own timezone and accept boundary today", async () => {
        const today = new Date().toISOString().slice(0, 10);
        const tomorrow = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
        expect((await patch({ timezone: "UTC", dateOfBirth: tomorrow })).status).toBe(400);
        expect(await rows()).toHaveLength(0);
        expect((await patch({ timezone: "Pacific/Kiritimati", dateOfBirth: today })).status).toBe(200);
    });

    // ───────────────────────────────────────────── concurrency
    it("should answer 200 to every one of several concurrent first-time PATCHes and keep exactly one live row", async () => {
        const responses = await Promise.all(Array.from({ length: 8 }, () => patch(full())));
        expect(responses.map((res) => res.status)).toEqual(Array(8).fill(200));
        for (const res of responses) expect(res.body.data).toMatchObject({ userId: 101, timezone: "Africa/Cairo", allergies: [ALLERGEN, "TEST-ALLERGEN-B"] });
        expect(await rows()).toHaveLength(1);
        const trail = await audits();
        expect(trail).toHaveLength(1);
        expect(trail[0]?.metadata).toMatchObject({ created: true });
    });

    it("should converge on one row and a consistent audit trail when concurrent first PATCHes differ", async () => {
        const responses = await Promise.all([patch(full({ gender: "male" })), patch(full({ gender: "other" })), patch(full({ gender: "female" }))]);
        expect(responses.map((res) => res.status)).toEqual([200, 200, 200]);
        expect(await rows()).toHaveLength(1);
        const trail = await audits();
        expect(trail.filter((row) => (row.metadata as { created: boolean }).created)).toHaveLength(1);
        const finalGender = (await get()).body.data.gender;
        expect((await rows())[0].gender).toBe(finalGender);
    });

    // ───────────────────────────────────────────── audit
    it("should write one patient_profile.read row per successful GET with actor, entity and request id", async () => {
        await patch(full());
        const profileId = Number((await rows())[0].id);
        const first = randomUUID(); const second = randomUUID();
        expect((await call("get", "patient", undefined, { "X-Request-Id": first })).status).toBe(200);
        expect((await call("get", "patient", undefined, { "X-Request-Id": second })).status).toBe(200);
        const reads = (await audits()).filter((row) => row.action === "patient_profile.read");
        expect(reads).toHaveLength(2);
        expect(reads.map((row) => row.request_id)).toEqual([first, second]);
        for (const row of reads) expect(row).toMatchObject({ actor_user_id: 101, actor_role: "patient", entity_type: "patient_profile", metadata: { patientUserId: 101 } });
        expect(reads.every((row) => Number(row.entity_id) === profileId)).toBe(true);
    });

    it("should audit a create with created=true and a real change with created=false, names only and sorted", async () => {
        const requestId = randomUUID();
        await patch(full(), "patient", { "X-Request-Id": requestId });
        await patch({ gender: "male", allergies: ["TEST-SOMETHING-NEW"], bloodType: "O+" });
        const trail = await audits();
        expect(trail).toHaveLength(2);
        expect(trail[0]).toMatchObject({ actor_user_id: 101, actor_role: "patient", action: "patient_profile.updated", entity_type: "patient_profile",
            request_id: requestId, metadata: { created: true, changedFields: "allergies,bloodType,chronicConditions,dateOfBirth,gender,timezone" } });
        expect(trail[1]?.metadata).toEqual({ created: false, changedFields: "allergies,bloodType,gender" });
        const dump = JSON.stringify(trail);
        for (const value of [ALLERGEN, CONDITION, DOB, "TEST-SOMETHING-NEW", "AB-", "Africa/Cairo"]) expect(dump).not.toContain(value);
    });

    it("should keep profile writes and audit rows in lockstep across a mixed sequence", async () => {
        await patch({ timezone: "UTC" }); await patch({ timezone: "UTC" }); await patch({ gender: "male" });
        await patch({ gender: "male" }); await patch({ gender: null }); await patch({ gender: null }); await patch({ allergies: [] });
        const updates = (await audits()).filter((row) => row.action === "patient_profile.updated");
        expect(updates.map((row) => (row.metadata as { changedFields: string }).changedFields)).toEqual(["timezone", "gender", "gender"]);
    });

    it("should write no audit row for 400 and 403 outcomes", async () => {
        await patch({ bogus: 1 }); await patch({}); await patch(full(), "doctor"); await get("admin");
        expect(await audits()).toHaveLength(0);
    });

    it("should roll back the create and return 500 when the audit insert fails", async () => {
        await ownerDb.raw("ALTER TABLE audit_logs ADD CONSTRAINT chk_audit_patient_updated_test CHECK (action <> 'patient_profile.updated')");
        try {
            const res = await patch(full());
            expect(res.status).toBe(500); expectErrorEnvelope(res.body, "InternalError");
            expect(JSON.stringify(res.body)).not.toContain(ALLERGEN);
            expect(await rows()).toHaveLength(0); expect(await audits()).toHaveLength(0);
        } finally {
            await ownerDb.raw("ALTER TABLE audit_logs DROP CONSTRAINT IF EXISTS chk_audit_patient_updated_test");
        }
    });

    it("should roll back the update and keep the old values when the audit insert fails", async () => {
        await patch({ timezone: "UTC", gender: "female" });
        await ownerDb.raw("ALTER TABLE audit_logs ADD CONSTRAINT chk_audit_patient_updated_test CHECK (action <> 'patient_profile.updated' OR metadata->>'changedFields' <> 'gender')");
        try {
            const res = await patch({ gender: "male" });
            expect(res.status).toBe(500);
            expect((await rows())[0].gender).toBe("female");
            expect(await audits()).toHaveLength(1);
        } finally {
            await ownerDb.raw("ALTER TABLE audit_logs DROP CONSTRAINT IF EXISTS chk_audit_patient_updated_test");
        }
    });

    it("should return 500 with no clinical data when the read audit insert fails", async () => {
        await patch(full());
        await ownerDb.raw("ALTER TABLE audit_logs ADD CONSTRAINT chk_audit_patient_read_test CHECK (action <> 'patient_profile.read')");
        try {
            const res = await get();
            expect(res.status).toBe(500); expectErrorEnvelope(res.body, "InternalError");
            expect(JSON.stringify(res.body)).not.toContain(ALLERGEN);
        } finally {
            await ownerDb.raw("ALTER TABLE audit_logs DROP CONSTRAINT IF EXISTS chk_audit_patient_read_test");
        }
    });

    // ───────────────────────────────────────────── headers / contract
    it("should send Cache-Control no-store and an echoed X-Request-Id on 200, 400, 403 and 404", async () => {
        const id = randomUUID();
        const notFound = await call("get", "patient", undefined, { "X-Request-Id": id });
        expect(notFound.status).toBe(404); expectNoStore(notFound); expect(notFound.headers["x-request-id"]).toBe(id);
        const bad = await patch({}); expect(bad.status).toBe(400); expectNoStore(bad);
        const denied = await get("doctor"); expect(denied.status).toBe(403); expectNoStore(denied);
        const created = await patch(full()); expect(created.status).toBe(200); expectNoStore(created);
        const read = await get(); expect(read.status).toBe(200); expectNoStore(read);
    });

    it("should return the success envelope and a body that matches the PatientProfile schema", async () => {
        const res = await patch(full());
        expect(res.body.success).toBe(true);
        const block = schemaBlock("PatientProfile");
        const [required = []] = inlineLists(block, "required");
        expect(Object.keys(res.body.data).sort()).toEqual([...required].sort());
        const data = res.body.data as Record<string, unknown>;
        expect(Number.isInteger(data.id)).toBe(true); expect(Number.isInteger(data.userId)).toBe(true);
        expect(data.dateOfBirth).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(inlineLists(block, "enum").flat()).toEqual(expect.arrayContaining([data.gender, data.bloodType]));
        expect(Array.isArray(data.allergies)).toBe(true); expect(Array.isArray(data.chronicConditions)).toBe(true);
        for (const stamp of [data.createdAt, data.updatedAt]) expect(stamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
        expect(data).not.toHaveProperty("deletedAt"); expect(data).not.toHaveProperty("deleted_at");
        for (const forbidden of ["fullName", "displayName", "email", "phone", "avatarUrl", "passwordHash"]) expect(data).not.toHaveProperty(forbidden);
    });

    it("should declare every observed response status for both operations in the contract", () => {
        expect([...seen.keys()].sort()).toEqual([`get ${ME}`, `patch ${ME}`]);
        for (const [key, statuses] of seen) {
            const [method = ""] = key.split(" ");
            const declared = contractResponseCodes(ME, method as Verb).map(Number);
            for (const status of statuses) expect(declared).toContain(status);
        }
    });

    // ───────────────────────────────────────────── logs
    it("should keep clinical fixture strings, tokens and the date of birth out of captured logs", async () => {
        jest.replaceProperty(logger as unknown as { level: string }, "level", "debug");
        const capture = captureLogs();
        try {
            await patch(full()); await get(); await patch({ allergies: ["TEST-ALLERGEN-LOGCHECK"], chronicConditions: ["TEST-CONDITION-LOGCHECK"] });
            await patch({ allergies: [ALLERGEN, ALLERGEN] }); await patch({ dateOfBirth: "2027-02-30" }); await patch({ diagnosis: CONDITION });
            await get("doctor"); await get("admin");
        } finally { capture.restore(); jest.restoreAllMocks(); }
        expectNoSensitiveStrings(capture, [ALLERGEN, "TEST-ALLERGEN-B", CONDITION, "TEST-ALLERGEN-LOGCHECK", "TEST-CONDITION-LOGCHECK", DOB, "2027-02-30",
            ...Object.values(tokens), "Authorization", "Bearer "]);
        const completed = capture.lines().filter((line) => line.message === "request_completed");
        expect(completed.length).toBeGreaterThanOrEqual(8);
        for (const line of completed) expect(line.route).toBe(ME);
    });

    it("should keep clinical strings out of logs when the audit insert fails with a 500", async () => {
        await ownerDb.raw("ALTER TABLE audit_logs ADD CONSTRAINT chk_audit_patient_updated_test CHECK (action <> 'patient_profile.updated')");
        jest.replaceProperty(logger as unknown as { level: string }, "level", "debug");
        const capture = captureLogs();
        try { await patch(full()); } finally {
            capture.restore(); jest.restoreAllMocks();
            await ownerDb.raw("ALTER TABLE audit_logs DROP CONSTRAINT IF EXISTS chk_audit_patient_updated_test");
        }
        expectNoSensitiveStrings(capture, [ALLERGEN, CONDITION, DOB]);
    });

    // ───────────────────────────────────────────── rate limits
    it("should rate limit the 21st PATCH with 429 and Retry-After and record the user limiter key", async () => {
        for (let index = 0; index < 20; index += 1) expect((await patch({ timezone: "UTC" })).status).toBe(200);
        const limited = await patch({ timezone: "UTC" });
        expect(limited.status).toBe(429); expectErrorEnvelope(limited.body, "RateLimited");
        expect(Number(limited.headers["retry-after"])).toBeGreaterThanOrEqual(1);
        expect(await redis.exists("rl:patients-write-user:101")).toBe(1);
        expect((await patch({ timezone: "UTC" }, "other")).status).toBe(200);
    });

    it("should rate limit the 121st GET with 429 while writes keep their own budget", async () => {
        await patch({ timezone: "UTC" });
        for (let index = 0; index < 120; index += 1) expect((await get()).status).toBe(200);
        const limited = await get();
        expect(limited.status).toBe(429); expectErrorEnvelope(limited.body, "RateLimited");
        expect(await redis.exists("rl:patients-read-user:101")).toBe(1);
        expect((await patch({ gender: "male" })).status).toBe(200);
    });

    // ───────────────────────────────────────────── schema
    it("should enforce app grants: no DELETE or TRUNCATE for the app role", async () => {
        await patch(full());
        await expect(db.raw("DELETE FROM patient_profiles")).rejects.toMatchObject({ code: "42501" });
        await expect(db.raw("TRUNCATE patient_profiles")).rejects.toMatchObject({ code: "42501" });
        await expect(db("patient_profiles").where("user_id", 101).update({ deleted_at: new Date() })).resolves.toBe(1);
    });

    it("should reject invalid values at the database through named check constraints", async () => {
        await patch(full());
        const base = { user_id: 900, timezone: "UTC" };
        await expect(db("patient_profiles").insert({ ...base, gender: "robot" })).rejects.toMatchObject({ code: "23514", constraint: "chk_patient_profiles_gender" });
        await expect(db("patient_profiles").insert({ ...base, blood_type: "Z+" })).rejects.toMatchObject({ code: "23514", constraint: "chk_patient_profiles_blood_type" });
        await expect(db("patient_profiles").insert({ ...base, allergies: Array.from({ length: 51 }, (_, i) => `TEST-${i}`) })).rejects.toMatchObject({ code: "23514", constraint: "chk_patient_profiles_allergies_len" });
        await expect(db("patient_profiles").insert({ ...base, chronic_conditions: Array.from({ length: 51 }, (_, i) => `TEST-${i}`) })).rejects.toMatchObject({ code: "23514", constraint: "chk_patient_profiles_conditions_len" });
        await expect(db("patient_profiles").insert({ user_id: 101, timezone: "UTC" })).rejects.toMatchObject({ code: "23505", constraint: "uq_patient_profiles_user_id" });
        await expect(db("patient_profiles").insert({ user_id: 901 })).rejects.toMatchObject({ code: "23502" });
    });

    it("should hide a soft-deleted profile and let a fresh PATCH create a new live row for the same user", async () => {
        await patch(full());
        await ownerDb("patient_profiles").where("user_id", 101).update({ deleted_at: new Date() });
        expect((await get()).status).toBe(404);
        const recreated = await patch({ timezone: "UTC" });
        expect(recreated.status).toBe(200); expect(recreated.body.data.allergies).toEqual([]);
        const all = await rows();
        expect(all).toHaveLength(2); expect(all.filter((row) => row.deleted_at === null)).toHaveLength(1);
    });

    it("should use the live-user unique index for the profile lookup", async () => {
        await patch(full());
        const plan = await ownerDb.transaction(async (trx) => {
            await trx.raw("SET LOCAL enable_seqscan = off");
            const result = await trx.raw<{ rows: Array<Record<string, string>> }>("EXPLAIN SELECT id FROM patient_profiles WHERE user_id = 101 AND deleted_at IS NULL");
            return result.rows.map((row) => Object.values(row)[0]).join("\n");
        });
        expect(plan).toContain("uq_patient_profiles_user_id");
        const index = await db.raw<{ rows: Array<{ indexdef: string }> }>("SELECT indexdef FROM pg_indexes WHERE tablename = 'patient_profiles' AND indexname = 'uq_patient_profiles_user_id'");
        expect(index.rows[0]?.indexdef).toMatch(/UNIQUE INDEX.*\(user_id\).*WHERE \(deleted_at IS NULL\)/);
    });

    it("should store timestamps as timestamptz and the date as DATE", async () => {
        const result = await ownerDb.raw<{ rows: Array<{ column_name: string; data_type: string }> }>(
            "SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'patient_profiles'");
        const types = Object.fromEntries(result.rows.map((row) => [row.column_name, row.data_type]));
        expect(types).toMatchObject({ created_at: "timestamp with time zone", updated_at: "timestamp with time zone", deleted_at: "timestamp with time zone",
            date_of_birth: "date", allergies: "ARRAY", chronic_conditions: "ARRAY" });
    });
});
