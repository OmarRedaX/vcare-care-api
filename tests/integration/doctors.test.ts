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
import { hashBody } from "../../src/lib/idempotency/idempotency";
import { inProgressRecord } from "../../src/lib/idempotency/idempotency-store";
import { contractResponseCodes, expectErrorEnvelope, idempotentOperations, inlineLists, schemaBlock } from "../helpers/contract";
import { closeDb, ownerDb, truncateAll } from "../helpers/db";
import { buildFakeJwksWiring, startFakeJwks } from "../helpers/fake-jwks";
import { captureLogs, expectNoSensitiveStrings } from "../helpers/log-capture";
import { closeRedis, ensureRedisReady, flushByPrefix } from "../helpers/redis";
import { signExpiredUserToken, signUserToken } from "../helpers/tokens";
import type { FakeJwks, FakeJwksWiring } from "../helpers/types";

jest.setTimeout(30_000);

const APPLY = "/api/doctors/apply";
const ME = "/api/doctors/me";
const APPLICATION = "/api/doctors/me/application";
const HEADLINE = "SYNTHETIC-HEADLINE-7731";
const BIO = "SYNTHETIC-BIO-7731";
const body = (changes: Record<string, unknown> = {}): Record<string, unknown> => ({ headline: HEADLINE, bio: BIO,
    yearsExperience: 5, languages: ["en", "ar"], specialtyIds: [1, 2], primarySpecialtyId: 1,
    consultationFee: { amount: 100, currency: "EGP" }, defaultSlotMinutes: 30, timezone: "Africa/Cairo", submit: false, ...changes });

type Actor = "doctor" | "pending" | "rejected" | "otherDoctor" | "patient" | "admin" | "suspended" | "expired";
type Verb = "get" | "post" | "patch";

describe("doctors (integration: real routes, Postgres and Redis)", () => {
    let fake: FakeJwks;
    let wiring: FakeJwksWiring;
    let app: Express;
    const tokens = {} as Record<Actor, string>;
    const previous: Array<{ token: symbol; value: unknown }> = [];
    const seen = new Map<string, Set<number>>();

    const routeKey = (verb: Verb, path: string): string => `${verb} ${path}`;
    function tracked(test: Test, verb: Verb, path: string): Test {
        const original = test.end.bind(test) as (callback?: (error: Error | null, res: request.Response) => void) => Test;
        test.end = ((callback?: (error: Error | null, res: request.Response) => void): Test => original((error, res) => {
            if (res !== undefined) { const key = routeKey(verb, path); const statuses = seen.get(key) ?? new Set<number>(); statuses.add(res.status); seen.set(key, statuses); }
            callback?.(error, res);
        })) as Test["end"];
        return test;
    }
    function call(verb: Verb, path: string, actor?: Actor, payload?: object, headers: Record<string, string> = {}): Test {
        let test = tracked(request(app)[verb](path), verb, path).set(headers);
        if (actor !== undefined) test = test.set("Authorization", `Bearer ${tokens[actor]}`);
        if (payload !== undefined) test = test.send(payload);
        return test;
    }
    const apply = (actor: Actor = "doctor", payload = body(), headers: Record<string, string> = {}): Test => call("post", APPLY, actor, payload, headers);
    const get = (actor: Actor = "doctor", path = ME): Test => call("get", path, actor);
    const patch = (payload: object, actor: Actor = "doctor"): Test => call("patch", ME, actor, payload);
    const profiles = () => ownerDb("doctor_profiles").select("*").orderBy("id");
    const audits = () => ownerDb("audit_logs").select("actor_user_id", "actor_role", "action", "entity_type", "entity_id", "request_id", "metadata").where("entity_type", "doctor_profile").orderBy("id");
    const expectOwnKeys = (value: Record<string, unknown>): void => {
        const [required = []] = inlineLists(schemaBlock("DoctorProfileOwn"), "required");
        expect(Object.keys(value).sort()).toEqual([...required, "reviewNote"].sort());
    };

    beforeAll(async () => {
        await ensureRedisReady();
        fake = await startFakeJwks(["doctors"]);
        wiring = await buildFakeJwksWiring(fake);
        for (const token of [TOKENS.JwksCache, TOKENS.UserTokenVerifier]) previous.push({ token, value: container.isRegistered(token) ? container.resolve(token) : undefined });
        container.registerInstance(TOKENS.JwksCache, wiring.cache);
        container.registerInstance(TOKENS.UserTokenVerifier, wiring.verifier);
        app = buildTestApps().publicApp;
        const claims: Array<[Actor, string, "doctor" | "patient" | "admin", "pending" | "active" | "rejected" | "suspended"]> = [
            ["doctor", "202", "doctor", "active"], ["pending", "202", "doctor", "pending"],
            ["rejected", "202", "doctor", "rejected"], ["otherDoctor", "204", "doctor", "active"],
            ["patient", "101", "patient", "active"], ["admin", "303", "admin", "active"],
            ["suspended", "202", "doctor", "suspended"],
        ];
        for (const [name, sub, role, status] of claims) tokens[name] = await signUserToken(fake.key("doctors"), { sub, role, status });
        tokens.expired = await signExpiredUserToken(fake.key("doctors"), { sub: "202", role: "doctor", status: "active" });
    });
    beforeEach(async () => {
        await truncateAll(); await flushByPrefix(["idem:", "rl:"]);
        await ownerDb("specialties").insert([
            { id: 1, name: "Synthetic One", slug: "synthetic-one", is_active: true },
            { id: 2, name: "Synthetic Two", slug: "synthetic-two", is_active: true },
        ]);
    });
    afterAll(async () => {
        await truncateAll(); await flushByPrefix(["idem:", "rl:"]);
        for (const entry of previous) if (entry.value !== undefined) container.registerInstance(entry.token, entry.value);
        wiring.cache.stop(); await fake.close(); await closeRedis(); await closeDb();
    });

    it.each([[
        "POST apply", "post", APPLY, body()], ["GET me", "get", ME, undefined],
        ["PATCH me", "patch", ME, { headline: "Synthetic new headline" }], ["GET application", "get", APPLICATION, undefined],
    ] as const)("should enforce RBAC on %s when unauthenticated or wrong role", async (_label, verb, path, payload) => {
        for (const actor of [undefined, "patient", "admin", "suspended"] as const) {
            const res = await call(verb, path, actor, payload);
            expect(res.status).toBe(actor === undefined ? 401 : 403);
            expectErrorEnvelope(res.body, actor === undefined ? "Unauthorized" : "Forbidden", res.headers["x-request-id"]);
        }
    });

    it.each(["pending", "doctor", "rejected"] as const)("should allow onboarding routes when doctor token is %s", async (actor) => {
        expect((await apply(actor)).status).toBe(201);
        expect((await get(actor)).status).toBe(200);
        expect((await patch({ headline: "Synthetic changed headline" }, actor)).status).toBe(200);
        expect((await get(actor, APPLICATION)).status).toBe(200);
    });

    it("should reject expired tokens and ignore spoofed identity headers", async () => {
        const expired = await get("expired");
        expect(expired.status).toBe(401); expectErrorEnvelope(expired.body, "TokenExpired");
        const spoofed = await call("post", APPLY, "patient", body(), { "X-Role": "doctor", "X-User-Id": "202" });
        expect(spoofed.status).toBe(403); expectErrorEnvelope(spoofed.body, "Forbidden");
    });

    it("should isolate another doctor and reject a body userId", async () => {
        expect((await apply()).status).toBe(201);
        expect((await get("otherDoctor")).status).toBe(404);
        expect((await get("otherDoctor", APPLICATION)).status).toBe(404);
        const claimed = await apply("otherDoctor", body({ userId: 202 }));
        expect(claimed.status).toBe(400); expectErrorEnvelope(claimed.body, "ValidationFailed");
        expect((await profiles())).toHaveLength(1);
    });

    it("should create a draft profile, sorted children and one private audit row", async () => {
        const requestId = randomUUID();
        const res = await apply("doctor", body(), { "X-Request-Id": requestId });
        expect(res.status).toBe(201); expect(res.headers["x-request-id"]).toBe(requestId);
        expectOwnKeys(res.body.data);
        expect(res.body.data).toMatchObject({ userId: 202, verificationStatus: "draft", identitySyncStatus: "not_required",
            isSuspended: false, isBookable: false, languages: ["ar", "en"], timezone: "Africa/Cairo" });
        expect(res.body.data.specialties[0].isPrimary).toBe(true);
        const rows = await profiles(); expect(rows).toHaveLength(1);
        expect(await ownerDb("doctor_languages").where("doctor_profile_id", rows[0].id)).toHaveLength(2);
        expect(await ownerDb("doctor_specialties").where("doctor_profile_id", rows[0].id)).toHaveLength(2);
        expect(await audits()).toMatchObject([{ actor_user_id: 202, actor_role: "doctor", action: "doctor.profile_created",
            entity_type: "doctor_profile", entity_id: rows[0].id, request_id: requestId, metadata: {} }]);
    });

    it("should replace a draft on real change and audit sorted field names only", async () => {
        await apply();
        const changed = await apply("doctor", body({ headline: "Synthetic replacement", yearsExperience: 8 }));
        expect(changed.status).toBe(200);
        const rows = await audits(); expect(rows).toHaveLength(2);
        expect(rows[1]?.metadata).toEqual({ changedFields: "headline,yearsExperience" });
        expect(JSON.stringify(rows)).not.toContain("Synthetic replacement");
        expect((await apply("doctor", body({ headline: "Synthetic replacement", yearsExperience: 8 }))).status).toBe(200);
        expect(await audits()).toHaveLength(2);
    });

    it("should keep a rejected profile rejected when replacing it", async () => {
        await apply();
        await ownerDb("doctor_profiles").where("user_id", 202).update({ verification_status: "rejected", decided_at: new Date() });
        const res = await apply("rejected", body({ headline: "Synthetic corrected headline" }));
        expect(res.status).toBe(200); expect(res.body.data.verificationStatus).toBe("rejected");
    });

    it.each(["submitted", "approved"])("should return 409 when application is %s", async (status) => {
        await apply();
        await ownerDb("doctor_profiles").where("user_id", 202).update({ verification_status: status, decided_at: new Date() });
        const res = await apply(); expect(res.status).toBe(409); expectErrorEnvelope(res.body, "Conflict");
        expect(await audits()).toHaveLength(1);
    });

    it("should reject submission without documents before creating a profile", async () => {
        const res = await apply("doctor", body({ submit: true }));
        expect(res.status).toBe(400); expect(res.body.error.details.map((d: { field: string }) => d.field)).toContain("documents");
        expect(await profiles()).toHaveLength(0);
    });

    it.each([
        ["missing fee", { consultationFee: undefined }, "consultationFee"],
        ["overflow fee", { consultationFee: { amount: 2147483648, currency: "EGP" } }, "consultationFee.amount"],
        ["negative fee", { consultationFee: { amount: -1, currency: "EGP" } }, "consultationFee.amount"],
        ["forbidden currency", { consultationFee: { amount: 1, currency: "USD" } }, "consultationFee.currency"],
        ["bad timezone", { timezone: "Not/AZone" }, "timezone"],
        ["duplicate specialties", { specialtyIds: [1, 1] }, "specialtyIds"],
        ["unknown specialty", { specialtyIds: [999], primarySpecialtyId: 999 }, "specialtyIds"],
        ["primary outside set", { primarySpecialtyId: 3 }, "primarySpecialtyId"],
        ["headline control", { headline: "Synthetic\u0001bad" }, "headline"],
        ["bio NUL", { bio: "Synthetic\u0000bad" }, "bio"],
    ] as const)("should return 400 for %s without persisting a profile", async (_label, change, field) => {
        const res = await apply("doctor", body(change));
        expect(res.status).toBe(400); expectErrorEnvelope(res.body, "ValidationFailed");
        expect(res.body.error.details.map((d: { field: string }) => d.field)).toContain(field);
        expect(await profiles()).toHaveLength(0);
    });

    it.each([
        ["short headline", { headline: "abcd" }, "headline"],
        ["long headline", { headline: "x".repeat(161) }, "headline"],
        ["long bio", { bio: "x".repeat(4001) }, "bio"],
        ["null bio", { bio: null }, "bio"],
        ["negative experience", { yearsExperience: -1 }, "yearsExperience"],
        ["excess experience", { yearsExperience: 71 }, "yearsExperience"],
        ["fractional experience", { yearsExperience: 1.5 }, "yearsExperience"],
        ["string experience", { yearsExperience: "5" }, "yearsExperience"],
        ["empty languages", { languages: [] }, "languages"],
        ["many languages", { languages: Array.from({ length: 11 }, (_, i) => `a${i}`) }, "languages"],
        ["duplicate languages", { languages: ["en", "en"] }, "languages"],
        ["uppercase language", { languages: ["AR"] }, "languages"],
        ["three-letter language", { languages: ["ara"] }, "languages"],
        ["empty specialties", { specialtyIds: [] }, "specialtyIds"],
        ["many specialties", { specialtyIds: [1, 2, 3, 4, 5, 6] }, "specialtyIds"],
        ["zero specialty", { specialtyIds: [0] }, "specialtyIds"],
        ["string specialty", { specialtyIds: ["1"] }, "specialtyIds"],
        ["missing primary", { primarySpecialtyId: undefined }, "primarySpecialtyId"],
        ["fractional fee", { consultationFee: { amount: 1.5, currency: "EGP" } }, "consultationFee.amount"],
        ["lowercase currency", { consultationFee: { amount: 1, currency: "egp" } }, "consultationFee.currency"],
        ["short currency", { consultationFee: { amount: 1, currency: "EG" } }, "consultationFee.currency"],
        ["extra fee member", { consultationFee: { amount: 1, currency: "EGP", extra: true } }, "consultationFee.extra"],
        ["short slot", { defaultSlotMinutes: 4 }, "defaultSlotMinutes"],
        ["long slot", { defaultSlotMinutes: 241 }, "defaultSlotMinutes"],
        ["long timezone", { timezone: "x".repeat(65) }, "timezone"],
        ["missing submit", { submit: undefined }, "submit"],
        ["string submit", { submit: "true" }, "submit"],
        ["body accepting state", { isAcceptingPatients: true }, "isAcceptingPatients"],
    ] as const)("should never return 500 for %s when apply body is invalid", async (_label, change, field) => {
        const res = await apply("doctor", body(change));
        expect(res.status).toBe(400); expectErrorEnvelope(res.body, "ValidationFailed");
        expect(res.body.error.details.map((d: { field: string }) => d.field)).toContain(field);
        expect(await profiles()).toHaveLength(0);
    });

    it("should reject a wrong role before validating the apply body", async () => {
        const res = await apply("patient", body({ consultationFee: undefined }));
        expect(res.status).toBe(403); expectErrorEnvelope(res.body, "Forbidden");
    });

    it("should accept the maximum int fee and canonicalize case variants of Cairo", async () => {
        const created = await apply("doctor", body({ consultationFee: { amount: 2147483647, currency: "EGP" }, timezone: "africa/cairo" }));
        expect(created.status).toBe(201); expect(created.body.data.consultationFee.amount).toBe(2147483647);
        expect(created.body.data.timezone).toBe("Africa/Cairo");
        const updated = await patch({ timezone: "AFRICA/CAIRO" });
        expect(updated.status).toBe(200); expect(updated.body.data.timezone).toBe("Africa/Cairo");
    });

    it("should reject a newly linked inactive specialty but retain an existing deactivated link", async () => {
        await ownerDb("specialties").where("id", 2).update({ is_active: false });
        const denied = await apply(); expect(denied.status).toBe(400);
        await ownerDb("specialties").where("id", 2).update({ is_active: true });
        expect((await apply()).status).toBe(201);
        await ownerDb("specialties").where("id", 2).update({ is_active: false });
        expect((await apply()).status).toBe(200);
        expect((await ownerDb("doctor_specialties")).map((row) => row.specialty_id)).toContain(2);
    });

    it("should handle two concurrent first applies with one 201 and one 200", async () => {
        const responses = await Promise.all([apply(), apply()]);
        expect(responses.map((res) => res.status).sort()).toEqual([200, 201]);
        expect(await profiles()).toHaveLength(1);
    });

    it("should replay identical idempotent apply and reject a changed body", async () => {
        const key = randomUUID(); const headers = { "Idempotency-Key": key };
        const first = await apply("doctor", body(), headers); const replay = await apply("doctor", body(), headers);
        expect(replay.status).toBe(first.status); expect(replay.body).toEqual(first.body);
        expect(await profiles()).toHaveLength(1); expect(await audits()).toHaveLength(1);
        const changed = await apply("doctor", body({ headline: "Synthetic changed" }), headers);
        expect(changed.status).toBe(422); expectErrorEnvelope(changed.body, "IdempotencyConflict");
        const bad = await apply("doctor", body(), { "Idempotency-Key": "not-a-uuid" });
        expect(bad.status).toBe(400); expectErrorEnvelope(bad.body, "ValidationFailed");
    });

    it("should return 409 with Retry-After when the same idempotency key is in flight", async () => {
        const key = randomUUID();
        await redis.set(`idem:POST ${APPLY}:user:202:${key}`, inProgressRecord(hashBody(body())), "PX", 5000);
        const res = await apply("doctor", body(), { "Idempotency-Key": key });
        expect(res.status).toBe(409); expectErrorEnvelope(res.body, "Conflict");
        expect(res.headers["retry-after"]).toBe("1"); expect(await profiles()).toHaveLength(0);
    });

    it("should roll back profile and child writes when the audit insert fails", async () => {
        await ownerDb.raw("ALTER TABLE audit_logs ADD CONSTRAINT chk_audit_doctor_profile_created_test CHECK (action <> 'doctor.profile_created')");
        try {
            const res = await apply(); expect(res.status).toBe(500); expectErrorEnvelope(res.body, "InternalError");
            expect(await profiles()).toHaveLength(0);
            expect(await ownerDb("doctor_languages")).toHaveLength(0);
            expect(await ownerDb("doctor_specialties")).toHaveLength(0);
            expect(await audits()).toHaveLength(0);
        } finally {
            await ownerDb.raw("ALTER TABLE audit_logs DROP CONSTRAINT IF EXISTS chk_audit_doctor_profile_created_test");
        }
    });

    it("should return 404 before applying and a degraded application view afterward", async () => {
        expect((await get()).status).toBe(404); expect((await get("doctor", APPLICATION)).status).toBe(404);
        await apply();
        const res = await get("doctor", APPLICATION);
        expect(res.status).toBe(200);
        const [required = []] = inlineLists(schemaBlock("VerificationApplication"), "required");
        for (const field of required) expect(res.body.data).toHaveProperty(field);
        expect(res.body.data).toMatchObject({ documents: [], missingRequirements: ["license_document", "id_document"],
            doctor: { displayName: null, avatarUrl: null, profileHydrated: false } });
    });

    it("should update fields, sets and primary while preserving retained link timestamps", async () => {
        await apply();
        const before = await ownerDb("doctor_specialties").where("specialty_id", 2).first();
        const res = await patch({ languages: ["fr"], specialtyIds: [2], primarySpecialtyId: 2, bio: null });
        expect(res.status).toBe(200); expect(res.body.data).toMatchObject({ languages: ["fr"], bio: null });
        expect(res.body.data.specialties).toHaveLength(1); expect(res.body.data.specialties[0].isPrimary).toBe(true);
        expect((await ownerDb("doctor_languages")).map((row) => row.language_code)).toEqual(["fr"]);
        const after = await ownerDb("doctor_specialties").where("specialty_id", 2).first();
        expect(after.created_at).toEqual(before.created_at);
    });

    it("should bump updated_at and audit exactly the changed field when PATCH changes one field", async () => {
        await apply();
        await ownerDb("doctor_profiles").where("user_id", 202).update({ updated_at: new Date("2020-01-01T00:00:00Z") });
        const res = await patch({ headline: "Synthetic changed headline" });
        expect(res.status).toBe(200);
        expect((await profiles())[0].updated_at.getTime()).toBeGreaterThan(new Date("2020-01-01T00:00:00Z").getTime());
        expect((await audits())[1]?.metadata).toEqual({ changedFields: "headline" });
    });

    it("should move the primary with a primary-only PATCH while keeping both links", async () => {
        await apply();
        const res = await patch({ primarySpecialtyId: 2 });
        expect(res.status).toBe(200); expect(res.body.data.specialties[0].id).toBe(2);
        expect((await ownerDb("doctor_specialties")).filter((row) => row.is_primary)).toHaveLength(1);
    });

    it("should reject a specialty replacement that omits its new primary", async () => {
        await apply();
        const res = await patch({ specialtyIds: [2] });
        expect(res.status).toBe(400); expect(res.body.error.details.map((d: { field: string }) => d.field)).toContain("primarySpecialtyId");
    });

    it("should turn accepting patients off without changing profile status", async () => {
        await apply();
        const res = await patch({ isAcceptingPatients: false });
        expect(res.status).toBe(200); expect(res.body.data).toMatchObject({ isAcceptingPatients: false, verificationStatus: "draft" });
    });

    it.each([
        ["empty body", {}, "body"], ["null headline", { headline: null }, "headline"],
        ["string accepting", { isAcceptingPatients: "false" }, "isAcceptingPatients"],
        ["verification status", { verificationStatus: "approved" }, "verificationStatus"],
    ] as const)("should reject %s when patching", async (_label, payload, field) => {
        await apply(); const res = await patch(payload);
        expect(res.status).toBe(400); expect(res.body.error.details.map((d: { field: string }) => d.field)).toContain(field);
        expect(await audits()).toHaveLength(1);
    });

    it("should leave updated_at and audit rows unchanged for a no-op PATCH", async () => {
        await apply(); const before = (await profiles())[0].updated_at;
        const res = await patch({ headline: HEADLINE, languages: ["ar", "en"] });
        expect(res.status).toBe(200); expect((await profiles())[0].updated_at).toEqual(before);
        expect(await audits()).toHaveLength(1);
    });

    it.each(["submitted", "approved"])("should allow PATCH when application status is %s", async (status) => {
        await apply(); await ownerDb("doctor_profiles").where("user_id", 202).update({ verification_status: status, decided_at: new Date() });
        expect((await patch({ headline: "Synthetic revised headline" })).status).toBe(200);
    });

    it("should deny PATCH but allow reads when locally suspended", async () => {
        await apply(); await ownerDb("doctor_profiles").where("user_id", 202).update({ verification_status: "approved", decided_at: new Date(), suspended_at: new Date(), suspension_reason: "synthetic reason" });
        expect((await patch({ headline: "Synthetic changed headline" })).status).toBe(403);
        expect((await get()).status).toBe(200); expect((await get("doctor", APPLICATION)).status).toBe(200);
        expect((await apply()).status).toBe(409);
    });

    it("should rate limit the 21st write and record user limiter keys", async () => {
        for (let index = 0; index < 20; index += 1) expect((await apply()).status).toBe(index === 0 ? 201 : 200);
        const limited = await apply(); expect(limited.status).toBe(429); expectErrorEnvelope(limited.body, "RateLimited");
        expect(Number(limited.headers["retry-after"])).toBeGreaterThanOrEqual(1);
        expect(await redis.exists("rl:doctors-write-user:202")).toBe(1);
        await get(); expect(await redis.exists("rl:doctors-read-user:202")).toBe(1);
    });

    it("should enforce app grants and use the live-user index", async () => {
        await apply();
        await expect(db.raw("DELETE FROM doctor_profiles")).rejects.toMatchObject({ code: "42501" });
        await expect(db.raw("TRUNCATE doctor_profiles")).rejects.toMatchObject({ code: "42501" });
        await db.transaction(async (trx) => {
            await trx.raw("SET LOCAL enable_seqscan = off");
            const result = await trx.raw<{ rows: Array<{ "QUERY PLAN": string }> }>("EXPLAIN SELECT id FROM doctor_profiles WHERE user_id = ? AND deleted_at IS NULL LIMIT 1", [202]);
            expect(result.rows.map((row) => row["QUERY PLAN"]).join(" ")).toContain("uq_doctor_profiles_user_id");
        });
    });

    it("should grant child row deletion while enforcing named profile and link constraints", async () => {
        await apply();
        const row = (await profiles())[0];
        const invalid: Array<[string, object, string]> = [
            ["experience", { years_experience: 71 }, "chk_doctor_profiles_years_experience"],
            ["fee", { consultation_fee: -1 }, "chk_doctor_profiles_fee"],
            ["currency", { currency: "egp" }, "chk_doctor_profiles_currency"],
            ["slot", { default_slot_minutes: 4 }, "chk_doctor_profiles_default_slot"],
            ["headline", { headline: "tiny" }, "chk_doctor_profiles_headline_length"],
            ["bio", { bio: "x".repeat(4001) }, "chk_doctor_profiles_bio_length"],
            ["verification", { verification_status: "unknown" }, "chk_doctor_profiles_verification_status"],
            ["identity sync", { identity_sync_status: "unknown" }, "chk_doctor_profiles_identity_sync_status"],
            ["suspension", { suspended_at: new Date(), suspension_reason: null }, "chk_doctor_profiles_suspension"],
            ["decision", { verification_status: "approved", decided_at: null }, "chk_doctor_profiles_decision"],
        ];
        for (const [_label, value, constraint] of invalid) {
            await expect(ownerDb("doctor_profiles").where("id", row.id).update(value)).rejects.toMatchObject({ code: "23514", constraint });
        }
        await expect(ownerDb("doctor_languages").insert({ doctor_profile_id: row.id, language_code: "EN" })).rejects.toMatchObject({ code: "23514", constraint: "chk_doctor_languages_code" });
        await expect(ownerDb("doctor_specialties").insert({ doctor_profile_id: row.id, specialty_id: 2, is_primary: false })).rejects.toMatchObject({ code: "23505", constraint: "uq_doctor_specialties_doctor_profile_id_specialty_id" });
        await ownerDb("specialties").insert({ id: 3, name: "Synthetic Three", slug: "synthetic-three", is_active: true });
        await expect(ownerDb("doctor_specialties").insert({ doctor_profile_id: row.id, specialty_id: 3, is_primary: true })).rejects.toMatchObject({ code: "23505", constraint: "uq_doctor_specialties_primary" });
        await expect(db("doctor_languages").where("doctor_profile_id", row.id).del()).resolves.toBe(2);
        await expect(db("doctor_specialties").where("doctor_profile_id", row.id).del()).resolves.toBe(2);
    });

    it("should hide a soft-deleted profile and allow a fresh apply", async () => {
        await apply(); await ownerDb("doctor_profiles").where("user_id", 202).update({ deleted_at: new Date() });
        expect((await get()).status).toBe(404);
        expect((await apply()).status).toBe(201);
        expect(await profiles()).toHaveLength(2);
    });

    it("should keep tokens and profile text out of request logs and use doctor route labels", async () => {
        // .env.test runs at LOG_LEVEL=warn, which hides request_completed; raise it so the assertion is not vacuous.
        jest.replaceProperty(logger as unknown as { level: string }, "level", "debug");
        const capture = captureLogs();
        try { await apply(); await get(); await patch({ bio: BIO }); await get("doctor", APPLICATION); }
        finally { capture.restore(); jest.restoreAllMocks(); }
        expectNoSensitiveStrings(capture, [HEADLINE, BIO, ...Object.values(tokens), "Authorization", "Bearer "]);
        const completed = capture.lines().filter((line) => line.message === "request_completed");
        expect(completed).toHaveLength(4);
        for (const line of completed) expect([APPLY, ME, APPLICATION]).toContain(line.route);
    });

    it("should declare every observed response status and apply idempotency in the contract", () => {
        for (const [key, statuses] of seen) {
            const [method = "", path = ""] = key.split(" ");
            const declared = contractResponseCodes(path, method as Verb).map(Number);
            for (const status of statuses) expect(declared).toContain(status);
        }
        expect(idempotentOperations()).toEqual(expect.arrayContaining([expect.objectContaining({ method: "POST", path: APPLY })]));
    });
});
