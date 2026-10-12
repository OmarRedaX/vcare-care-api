import { randomUUID } from "node:crypto";
import type { Express } from "express";
import { DateTime } from "luxon";
import request from "supertest";
import type { Test } from "supertest";
import { ConsultationsController } from "../../src/app/consultations/controller/consultations.controller";
import { ConsultationQueriesService } from "../../src/app/consultations/service/consultation-queries.service";
import { ConsultationScope } from "../../src/app/consultations/enums";
import { hasRelationshipQuery, listPageQuery } from "../../src/app/consultations/repository/consultations.repo";
import type { ConsultationListFilter } from "../../src/app/consultations/types";
import { ConsultationSuspensionImpactProvider } from "../../src/app/consultations/service/suspension-impact.provider";
import { container } from "../../src/lib/di/container";
import { TOKENS } from "../../src/lib/di/tokens";
import { getEnv } from "../../src/lib/config/env";
import { IdentityClient } from "../../src/lib/identity-client/identity-client";
import { db } from "../../src/lib/knex/knex";
import { redis } from "../../src/lib/redis/redis";
import { buildTestApps } from "../helpers/app";
import { contractNoStoreValue, expectErrorEnvelope } from "../helpers/contract";
import { closeDb, ownerDb, truncateAll } from "../helpers/db";
import { buildFakeJwksWiring, startFakeJwks } from "../helpers/fake-jwks";
import { FakeIdentityServer } from "../helpers/fake-identity-server";
import { captureLogs, expectNoSensitiveStrings } from "../helpers/log-capture";
import { closeRedis, ensureRedisReady, flushByPrefix } from "../helpers/redis";
import { signUserToken } from "../helpers/tokens";
import type { FakeJwks, FakeJwksWiring } from "../helpers/types";

jest.setTimeout(60_000);

const COMPLAINT = "SYNTHETIC-COMPLAINT-7731";
const REASON = "SYNTHETIC-REASON-4417";
const DOCTOR = 202;
const OTHER_DOCTOR = 204;
const PATIENT = 101;
const OTHER_PATIENT = 102;
const ADMIN = 303;

type Actor = "patient" | "otherPatient" | "unverified" | "doctor" | "otherDoctor" | "suspendedToken" | "admin";

/** Doctor-local (Africa/Cairo) wall time `days` from today at `HH:mm`, as ISO-8601 with offset. */
function localStart(days: number, time: string): string {
    const [hour = 0, minute = 0] = time.split(":").map(Number);
    return DateTime.now().setZone("Africa/Cairo").plus({ days }).set({ hour, minute, second: 0, millisecond: 0 }).toISO({ suppressMilliseconds: true }) ?? "";
}
const body = (changes: Record<string, unknown> = {}): Record<string, unknown> => ({
    doctorId: DOCTOR, typeId: 1, startsAt: localStart(3, "10:00"), complaintText: COMPLAINT, patientTimezone: "America/New_York", ...changes,
});

describe("consultations (integration: real routes, Postgres, Redis and a fake Identity)", () => {
    let fake: FakeJwks;
    let wiring: FakeJwksWiring;
    let identityServer: FakeIdentityServer;
    let app: Express;
    const tokens = {} as Record<Actor, string>;
    const previous: Array<{ token: symbol; value: unknown }> = [];

    function call(verb: "get" | "post" | "patch" | "put", path: string, actor?: Actor, payload?: object, headers: Record<string, string> = {}): Test {
        let test = request(app)[verb](path).set(headers);
        if (actor !== undefined) test = test.set("Authorization", `Bearer ${tokens[actor]}`);
        if (payload !== undefined) test = test.send(payload);
        return test;
    }
    const write = (verb: "post" | "patch", path: string, actor: Actor, payload: object, key: string = randomUUID()): Test =>
        call(verb, path, actor, payload, { "Idempotency-Key": key });
    const book = (actor: Actor = "patient", payload: object = body(), key?: string): Test => write("post", "/api/consultations", actor, payload, key);
    const reschedule = (id: number, actor: Actor, payload: object, key?: string): Test => write("patch", `/api/consultations/${id}/reschedule`, actor, payload, key);
    const cancel = (id: number, actor: Actor, payload: object = {}, key?: string): Test => write("patch", `/api/consultations/${id}/cancel`, actor, payload, key);

    async function seedDoctor(userId: number, changes: Record<string, unknown> = {}): Promise<number> {
        const rows = await ownerDb("doctor_profiles").insert({
            user_id: userId, headline: "Synthetic headline", years_experience: 5, consultation_fee: 15000, currency: "EGP", default_slot_minutes: 30,
            timezone: "Africa/Cairo", is_accepting_patients: true, verification_status: "approved", identity_sync_status: "synced", decided_at: new Date(), ...changes,
        }).returning("id");
        const profileId = (rows[0] as { id: number }).id;
        await ownerDb("working_hours").insert([1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ doctor_profile_id: profileId, weekday, start_time: "09:00", end_time: "17:00" })));
        await ownerDb("consultation_types").insert({ doctor_profile_id: profileId, name: "Synthetic Visit", duration_minutes: 30, price: 15000, currency: "EGP", is_active: true });
        return profileId;
    }
    async function seedConsultation(changes: Record<string, unknown> = {}): Promise<number> {
        const rows = await ownerDb("consultations").insert({
            doctor_user_id: DOCTOR, patient_user_id: PATIENT, consultation_type_id: 1, starts_at: new Date(Date.now() + 3 * 86_400_000),
            ends_at: new Date(Date.now() + 3 * 86_400_000 + 1_800_000), status: "booked", complaint_text: COMPLAINT, patient_timezone: "UTC", price: 15000,
            currency: "EGP", idempotency_key: randomUUID(), request_hash: "a".repeat(64), ...changes,
        }).returning("id");
        return (rows[0] as { id: number }).id;
    }
    const consultationRows = () => ownerDb("consultations").select("*").orderBy("id");
    const outbox = () => ownerDb("notification_outbox").select("*").orderBy("id");
    const audits = (...actions: string[]) => ownerDb("audit_logs").select("actor_user_id", "actor_role", "action", "entity_type", "entity_id", "metadata")
        .whereIn("action", actions).orderBy("id");

    beforeAll(async () => {
        await ensureRedisReady();
        fake = await startFakeJwks(["consultations"]);
        wiring = await buildFakeJwksWiring(fake);
        identityServer = new FakeIdentityServer();
        const url = await identityServer.start();
        const identity = new IdentityClient({ env: { ...getEnv(), IDENTITY_INTERNAL_URL: url }, redis, sleep: () => Promise.resolve() });
        for (const token of [TOKENS.JwksCache, TOKENS.UserTokenVerifier, TOKENS.IDENTITY_CLIENT, TOKENS.ConsultationQueriesService, TOKENS.ConsultationsController])
            previous.push({ token, value: container.isRegistered(token) ? container.resolve(token) : undefined });
        container.registerInstance(TOKENS.JwksCache, wiring.cache);
        container.registerInstance(TOKENS.UserTokenVerifier, wiring.verifier);
        container.registerInstance(TOKENS.IDENTITY_CLIENT, identity);
        // The boot-time singletons hold the boot-time Identity client: rebuild the read side and the controller on the fake.
        container.registerSingleton(TOKENS.ConsultationQueriesService, ConsultationQueriesService);
        container.registerSingleton(TOKENS.ConsultationsController, ConsultationsController);
        app = buildTestApps().publicApp;
        const claims: Array<[Actor, string, "doctor" | "patient" | "admin", "active" | "suspended", boolean]> = [
            ["patient", String(PATIENT), "patient", "active", true], ["otherPatient", String(OTHER_PATIENT), "patient", "active", true],
            ["unverified", "103", "patient", "active", false], ["doctor", String(DOCTOR), "doctor", "active", true],
            ["otherDoctor", String(OTHER_DOCTOR), "doctor", "active", true], ["suspendedToken", String(DOCTOR), "doctor", "suspended", true],
            ["admin", String(ADMIN), "admin", "active", true],
        ];
        for (const [name, sub, role, status, ev] of claims) tokens[name] = await signUserToken(fake.key("consultations"), { sub, role, status, ev });
    });
    beforeEach(async () => {
        await truncateAll(); await flushByPrefix(["idem:", "rl:", "identity:"]);
        identityServer.users.clear(); identityServer.calls.length = 0; Object.assign(identityServer.options, { down: false });
        identityServer.users.set(DOCTOR, { id: DOCTOR, fullName: "Dr Synthetic", avatarUrl: null, status: "active" });
        identityServer.users.set(PATIENT, { id: PATIENT, fullName: "Pat Synthetic", avatarUrl: "https://example.test/a.png", status: "active" });
        await seedDoctor(DOCTOR);
    });
    afterAll(async () => {
        await truncateAll(); await flushByPrefix(["idem:", "rl:", "identity:"]);
        for (const entry of previous) if (entry.value !== undefined) container.registerInstance(entry.token, entry.value);
        wiring.cache.stop(); await fake.close(); await identityServer.close(); await closeRedis(); await closeDb();
    });

    // ───────────────────────────────────────────── booking
    describe("POST /api/consultations", () => {
        it("should book a slot, snapshot price and zone, queue two outbox rows and audit without clinical text", async () => {
            const res = await book();
            expect(res.status).toBe(201);
            expect(res.headers["cache-control"]).toBe(contractNoStoreValue());
            const data = res.body.data as Record<string, unknown>;
            expect(data).toMatchObject({ status: "booked", complaintText: COMPLAINT, patientTimezone: "America/New_York", timezone: "America/New_York",
                price: { amount: 15000, currency: "EGP" }, consultationType: { id: 1, name: "Synthetic Visit", durationMinutes: 30 }, hasRecord: false,
                needsAdminFollowup: false, doctor: { userId: DOCTOR, displayName: null, avatarUrl: null, profileHydrated: false },
                patient: { userId: PATIENT, displayName: null, avatarUrl: null, profileHydrated: false } });
            const rows = await consultationRows();
            expect(rows).toHaveLength(1);
            expect(new Date(rows[0].ends_at).getTime() - new Date(rows[0].starts_at).getTime()).toBe(30 * 60_000);
            expect(rows[0]).toMatchObject({ doctor_user_id: DOCTOR, patient_user_id: PATIENT, status: "booked", price: 15000, patient_timezone: "America/New_York" });
            const queued = await outbox();
            expect(queued.map((row) => [row.kind, Number(row.recipient_user_id), row.status])).toEqual([["booking_confirmed", PATIENT, "pending"], ["booking_confirmed", DOCTOR, "pending"]]);
            expect(JSON.stringify(queued.map((row) => row.payload))).not.toContain(COMPLAINT);
            const [audit] = await audits("consultation.booked");
            expect(audit).toMatchObject({ actor_user_id: PATIENT, actor_role: "patient", entity_type: "consultation", entity_id: rows[0].id });
            expect(JSON.stringify(audit?.metadata)).not.toContain(COMPLAINT);
            expect(identityServer.calls.filter((entry) => entry.path.startsWith("/internal/users"))).toHaveLength(0);
        });

        it("should answer 400 without an Idempotency-Key and for followUpOfRecordId, and 403 for non-patients and unverified email", async () => {
            const missing = await call("post", "/api/consultations", "patient", body());
            expect(missing.status).toBe(400); expectErrorEnvelope(missing.body, "ValidationFailed");
            const followUp = await book("patient", body({ followUpOfRecordId: 5 }));
            expect(followUp.status).toBe(400);
            expect(followUp.body.error.details).toEqual([{ field: "followUpOfRecordId", issue: "is not supported yet" }]);
            for (const actor of ["doctor", "admin"] as const) expect((await book(actor)).status).toBe(403);
            const unverified = await book("unverified");
            expect(unverified.status).toBe(403); expectErrorEnvelope(unverified.body, "EmailNotVerified");
            expect(await consultationRows()).toHaveLength(0);
        });

        it("should replay the same consultation for the same key and body, from Redis and from the database, and reject another body with 422", async () => {
            const key = randomUUID();
            const first = await book("patient", body(), key);
            const again = await book("patient", body(), key);
            expect(first.status).toBe(201); expect(again.status).toBe(201);
            expect(again.body.data.id).toBe(first.body.data.id);
            await flushByPrefix(["idem:"]);
            const fromDatabase = await book("patient", body(), key);
            expect(fromDatabase.status).toBe(201); expect(fromDatabase.body.data.id).toBe(first.body.data.id);
            const conflicting = await book("patient", body({ complaintText: "SYNTHETIC-OTHER-TEXT" }), key);
            expect(conflicting.status).toBe(422); expectErrorEnvelope(conflicting.body, "IdempotencyConflict");
            await flushByPrefix(["idem:"]);
            const conflictingFromDatabase = await book("patient", body({ complaintText: "SYNTHETIC-OTHER-TEXT" }), key);
            expect(conflictingFromDatabase.status).toBe(422); expectErrorEnvelope(conflictingFromDatabase.body, "IdempotencyConflict");
            expect(await consultationRows()).toHaveLength(1);
            expect(await outbox()).toHaveLength(2);
        });

        it("should let exactly one of two concurrent bookings of one slot win and answer the other 409 SlotUnavailable", async () => {
            const [a, b] = await Promise.all([book("patient"), book("otherPatient")]);
            expect([a.status, b.status].sort()).toEqual([201, 409]);
            const loser = a.status === 409 ? a : b;
            expectErrorEnvelope(loser.body, "SlotUnavailable");
            expect(await consultationRows()).toHaveLength(1);
            expect(await outbox()).toHaveLength(2);
        });

        it("should allow back-to-back slots", async () => {
            expect((await book("patient", body({ startsAt: localStart(3, "10:00") }))).status).toBe(201);
            expect((await book("otherPatient", body({ startsAt: localStart(3, "10:30") }))).status).toBe(201);
        });

        it.each([
            ["an off-grid minute", () => body({ startsAt: localStart(3, "10:15") }), 422, "OutsideWorkingHours"],
            ["before the working hours", () => body({ startsAt: localStart(3, "08:00") }), 422, "OutsideWorkingHours"],
            ["a slot ending after the working hours", () => body({ startsAt: localStart(3, "16:45") }), 422, "OutsideWorkingHours"],
            ["a start in the past", () => body({ startsAt: localStart(-1, "10:00") }), 422, "BookingInPast"],
            ["a start beyond the 60 day horizon", () => body({ startsAt: localStart(61, "10:00") }), 422, "BeyondBookingHorizon"],
            ["an unknown doctor", () => body({ doctorId: 999 }), 404, "NotFound"],
            ["an unknown type", () => body({ typeId: 999 }), 404, "NotFound"],
            ["a timezone that is not IANA", () => body({ patientTimezone: "Mars/Olympus" }), 400, "ValidationFailed"],
            ["a start without an offset", () => body({ startsAt: "2030-01-01T10:00:00" }), 400, "ValidationFailed"],
            ["a too short complaint", () => body({ complaintText: "ab" }), 400, "ValidationFailed"],
            ["an unknown member", () => ({ ...body(), endsAt: localStart(3, "11:00") }), 400, "ValidationFailed"],
        ])("should reject %s", async (_label, payload, status, code) => {
            const res = await book("patient", payload());
            expect(res.status).toBe(status); expectErrorEnvelope(res.body, code);
            expect(await consultationRows()).toHaveLength(0);
        });

        it("should answer 409 DoctorNotBookable for a suspended, unsynced, unapproved or not accepting doctor", async () => {
            for (const change of [{ suspended_at: new Date(), suspension_reason: "synthetic" }, { identity_sync_status: "pending" }, { verification_status: "submitted", decided_at: null }, { is_accepting_patients: false }]) {
                await ownerDb("doctor_profiles").where("user_id", DOCTOR).update({ suspended_at: null, suspension_reason: null, identity_sync_status: "synced", verification_status: "approved", decided_at: new Date(), is_accepting_patients: true, ...change });
                const res = await book();
                expect(res.status).toBe(409); expectErrorEnvelope(res.body, "DoctorNotBookable");
            }
            await ownerDb("doctor_profiles").where("user_id", DOCTOR).update({ suspended_at: null, suspension_reason: null, identity_sync_status: "synced", verification_status: "approved", decided_at: new Date(), is_accepting_patients: true });
            await ownerDb("consultation_types").update({ is_active: false });
            expect((await book()).status).toBe(409);
            expect(await consultationRows()).toHaveLength(0);
        });

        it("should honour a day-off exception and custom hours when checking the slot", async () => {
            const date = DateTime.now().setZone("Africa/Cairo").plus({ days: 3 }).toISODate() ?? "";
            await ownerDb("schedule_exceptions").insert({ doctor_profile_id: 1, date, type: "day_off" });
            expect((await book()).status).toBe(422);
            await ownerDb("schedule_exceptions").where("date", date).delete();
            await ownerDb("schedule_exceptions").insert({ doctor_profile_id: 1, date, type: "custom_hours", start_time: "12:00", end_time: "13:00" });
            expect((await book("patient", body({ startsAt: localStart(3, "10:00") }))).status).toBe(422);
            expect((await book("patient", body({ startsAt: localStart(3, "12:30") }))).status).toBe(201);
        });

        it("should keep complaint text out of the logs", async () => {
            const logs = captureLogs();
            try {
                await book();
                await call("get", "/api/consultations", "patient");
            } finally {
                logs.restore();
            }
            expectNoSensitiveStrings(logs, [COMPLAINT]);
        });
    });

    // ───────────────────────────────────────────── reschedule
    describe("PATCH /api/consultations/{id}/reschedule", () => {
        it("should move a booked consultation, reset the reminders and flag, and queue rescheduled notifications", async () => {
            const id = (await book()).body.data.id as number;
            await ownerDb("consultations").where("id", id).update({ needs_admin_followup: true, followup_reason: "schedule_blocked", reminder_24h_sent_at: new Date() });
            const res = await reschedule(id, "patient", { startsAt: localStart(4, "11:00"), reason: REASON });
            expect(res.status).toBe(200);
            const [row] = await consultationRows();
            expect(new Date(row.starts_at).toISOString()).toBe(new Date(localStart(4, "11:00")).toISOString());
            expect(new Date(row.ends_at).getTime() - new Date(row.starts_at).getTime()).toBe(30 * 60_000);
            expect(row).toMatchObject({ status: "booked", needs_admin_followup: false, followup_reason: null, reminder_24h_sent_at: null });
            expect((await outbox()).filter((entry) => entry.kind === "rescheduled")).toHaveLength(2);
            const [audit] = await audits("consultation.rescheduled");
            expect(audit?.metadata).toMatchObject({ byRole: "patient", reasonLength: REASON.length });
            expect(JSON.stringify(audit?.metadata)).not.toContain(REASON);
        });

        it("should keep the stored interval length after the type is edited", async () => {
            const id = (await book()).body.data.id as number;
            await ownerDb("consultation_types").update({ duration_minutes: 60 });
            expect((await reschedule(id, "patient", { startsAt: localStart(4, "11:00") })).status).toBe(200);
            const [row] = await consultationRows();
            expect(new Date(row.ends_at).getTime() - new Date(row.starts_at).getTime()).toBe(30 * 60_000);
        });

        it("should answer a same-start reschedule with 200 and write nothing", async () => {
            const id = (await book()).body.data.id as number;
            const before = (await audits("consultation.rescheduled")).length;
            expect((await reschedule(id, "patient", { startsAt: body().startsAt as string })).status).toBe(200);
            expect(await audits("consultation.rescheduled")).toHaveLength(before);
            expect((await outbox()).filter((entry) => entry.kind === "rescheduled")).toHaveLength(0);
        });

        it("should allow exactly 120 minutes before the start and refuse closer, for patients only", async () => {
            const near = new Date(Date.now() + 119 * 60_000).toISOString();
            const nearId = await seedConsultation({ starts_at: near, ends_at: new Date(Date.now() + 149 * 60_000) });
            const refused = await reschedule(nearId, "patient", { startsAt: localStart(4, "11:00") });
            expect(refused.status).toBe(409); expectErrorEnvelope(refused.body, "PolicyWindowViolation");
            const byAdmin = await reschedule(nearId, "admin", { startsAt: localStart(4, "11:00"), reason: REASON });
            expect(byAdmin.status).toBe(200);
        });

        it("should require a reason from an admin and refuse a doctor, a non-owner and a missing consultation", async () => {
            const id = (await book()).body.data.id as number;
            const noReason = await reschedule(id, "admin", { startsAt: localStart(4, "11:00") });
            expect(noReason.status).toBe(400); expect(noReason.body.error.details).toEqual([{ field: "reason", issue: "is required when an admin reschedules" }]);
            expect((await reschedule(id, "doctor", { startsAt: localStart(4, "11:00") })).status).toBe(403);
            const other = await reschedule(id, "otherPatient", { startsAt: localStart(4, "11:00") });
            expect(other.status).toBe(404); expectErrorEnvelope(other.body, "NotFound");
            expect((await reschedule(9999, "patient", { startsAt: localStart(4, "11:00") })).status).toBe(404);
            expect((await reschedule(9999, "admin", { startsAt: localStart(4, "11:00"), reason: REASON })).status).toBe(404);
        });

        it("should answer 409 SlotUnavailable when the new slot is taken and release the old one when it moves", async () => {
            const first = (await book("patient", body({ startsAt: localStart(3, "10:00") }))).body.data.id as number;
            await book("otherPatient", body({ startsAt: localStart(3, "11:00") }));
            const taken = await reschedule(first, "patient", { startsAt: localStart(3, "11:00") });
            expect(taken.status).toBe(409); expectErrorEnvelope(taken.body, "SlotUnavailable");
            expect((await reschedule(first, "patient", { startsAt: localStart(3, "12:00") })).status).toBe(200);
            expect((await book("otherPatient", body({ startsAt: localStart(3, "10:00") }))).status).toBe(201);
        });

        it("should refuse a non-booked consultation with InvalidTransition and an off-grid start with OutsideWorkingHours", async () => {
            const id = (await book()).body.data.id as number;
            const off = await reschedule(id, "patient", { startsAt: localStart(4, "11:10") });
            expect(off.status).toBe(422); expectErrorEnvelope(off.body, "OutsideWorkingHours");
            await ownerDb("consultations").where("id", id).update({ status: "waiting" });
            const res = await reschedule(id, "patient", { startsAt: localStart(4, "11:00") });
            expect(res.status).toBe(409); expectErrorEnvelope(res.body, "InvalidTransition");
        });
    });

    // ───────────────────────────────────────────── cancel
    describe("PATCH /api/consultations/{id}/cancel", () => {
        it("should cancel as the patient outside the window, release the slot and queue cancelled notifications", async () => {
            const id = (await book()).body.data.id as number;
            const res = await cancel(id, "patient");
            expect(res.status).toBe(200);
            expect(res.body.data).toMatchObject({ status: "cancelled", cancelledBy: "patient" });
            const [row] = await consultationRows();
            expect(row).toMatchObject({ status: "cancelled", cancelled_by: "patient", cancelled_by_user_id: PATIENT, cancel_reason: null });
            expect((await outbox()).filter((entry) => entry.kind === "cancelled")).toHaveLength(2);
            expect((await book("otherPatient")).status).toBe(201);
        });

        it("should require a reason from the doctor and the admin and store it without auditing its text", async () => {
            const id = (await book()).body.data.id as number;
            for (const actor of ["doctor", "admin"] as const) {
                const res = await cancel(id, actor, {});
                expect(res.status).toBe(400); expect(res.body.error.details).toEqual([{ field: "reason", issue: "is required when a doctor or admin cancels" }]);
            }
            const byDoctor = await cancel(id, "doctor", { reason: REASON });
            expect(byDoctor.status).toBe(200); expect(byDoctor.body.data).toMatchObject({ cancelledBy: "doctor", cancelReason: REASON });
            const [audit] = await audits("consultation.cancelled");
            expect(audit?.metadata).toMatchObject({ byRole: "doctor", fromStatus: "booked", reasonLength: REASON.length });
            expect(JSON.stringify(audit?.metadata)).not.toContain(REASON);
        });

        it("should refuse a patient inside the window, a terminal consultation, a stranger and a suspended doctor", async () => {
            const near = await seedConsultation({ starts_at: new Date(Date.now() + 60 * 60_000), ends_at: new Date(Date.now() + 90 * 60_000) });
            const inside = await cancel(near, "patient");
            expect(inside.status).toBe(409); expectErrorEnvelope(inside.body, "PolicyWindowViolation");
            expect((await cancel(near, "admin", { reason: REASON })).status).toBe(200);
            const terminal = await cancel(near, "admin", { reason: REASON });
            expect(terminal.status).toBe(409); expectErrorEnvelope(terminal.body, "InvalidTransition");
            const id = (await book()).body.data.id as number;
            expect((await cancel(id, "otherPatient")).status).toBe(404);
            expect((await cancel(id, "otherDoctor", { reason: REASON })).status).toBe(404);
            await ownerDb("doctor_profiles").where("user_id", DOCTOR).update({ suspended_at: new Date(), suspension_reason: "synthetic" });
            const suspended = await cancel(id, "doctor", { reason: REASON });
            expect(suspended.status).toBe(403); expectErrorEnvelope(suspended.body, "Forbidden");
        });

        it("should answer 400 when the body is absent", async () => {
            const id = (await book()).body.data.id as number;
            const res = await call("patch", `/api/consultations/${id}/cancel`, "patient", undefined, { "Idempotency-Key": randomUUID() });
            expect(res.status).toBe(400);
        });
    });

    // ───────────────────────────────────────────── read side
    describe("GET /api/consultations and /api/consultations/{id}", () => {
        it("should list for a patient with the doctor hydrated by one batched call and no complaint text", async () => {
            await book();
            const res = await call("get", "/api/consultations", "patient");
            expect(res.status).toBe(200); expect(res.headers["cache-control"]).toBe(contractNoStoreValue());
            const [item] = res.body.data as Array<Record<string, unknown>>;
            expect(item).toMatchObject({ status: "booked", doctor: { userId: DOCTOR, displayName: "Dr Synthetic", profileHydrated: true },
                patient: { userId: PATIENT, displayName: null, profileHydrated: false } });
            expect(item).not.toHaveProperty("complaintText");
            expect(res.body.meta).toEqual({ nextCursor: null, hasMore: false, count: 1 });
            expect(identityServer.calls.filter((entry) => entry.path.startsWith("/internal/users?ids="))).toHaveLength(1);
        });

        it("should still answer 200 with unhydrated participants when Identity is down", async () => {
            await book();
            identityServer.options.down = true;
            const res = await call("get", "/api/consultations", "patient");
            expect(res.status).toBe(200);
            expect(res.body.data[0].doctor).toMatchObject({ userId: DOCTOR, displayName: null, avatarUrl: null, profileHydrated: false });
        });

        it("should scope by role, order and filter, and page with a cursor", async () => {
            const ids: number[] = [];
            for (const time of ["10:00", "10:30", "11:00"]) ids.push((await book("patient", body({ startsAt: localStart(3, time) }))).body.data.id as number);
            await book("otherPatient", body({ startsAt: localStart(3, "12:00") }));
            const first = await call("get", "/api/consultations?limit=2", "patient");
            expect(first.body.data.map((item: { id: number }) => item.id)).toEqual(ids.slice(0, 2));
            expect(first.body.meta).toMatchObject({ hasMore: true, count: 2 });
            const second = await call("get", `/api/consultations?limit=2&cursor=${encodeURIComponent(first.body.meta.nextCursor as string)}`, "patient");
            expect(second.body.data.map((item: { id: number }) => item.id)).toEqual(ids.slice(2));
            expect(second.body.meta).toMatchObject({ hasMore: false, nextCursor: null });
            expect((await call("get", "/api/consultations", "doctor")).body.data).toHaveLength(4);
            expect((await call("get", "/api/consultations", "otherDoctor")).body.data).toHaveLength(0);
            expect((await call("get", "/api/consultations?scope=past", "patient")).body.data).toHaveLength(0);
            expect((await call("get", "/api/consultations?status=cancelled,no_show", "patient")).body.data).toHaveLength(0);
            expect((await call("get", "/api/consultations?status=booked", "admin")).body.data).toHaveLength(4);
            expect((await call("get", `/api/consultations?patientUserId=${OTHER_PATIENT}`, "admin")).body.data).toHaveLength(1);
        });

        it("should reject admin-only filters from non-admins, bad queries, and repeated status parameters", async () => {
            for (const query of [`doctorUserId=${DOCTOR}`, `patientUserId=${PATIENT}`, "needsAdminFollowup=true"]) {
                const res = await call("get", `/api/consultations?${query}`, "patient");
                expect(res.status).toBe(403); expectErrorEnvelope(res.body, "Forbidden");
            }
            for (const query of ["scope=soon", "status=booked&status=waiting", "status=bogus", "timezone=Mars/Olympus", "from=2030-01-02T00:00:00Z&to=2030-01-01T00:00:00Z", "limit=0", "cursor=nope", "x=1"]) {
                const res = await call("get", `/api/consultations?${query}`, "patient");
                expect(res.status).toBe(400); expectErrorEnvelope(res.body, "ValidationFailed");
            }
        });

        it("should return get-one with complaint text to participants and audit the read, and hide it from the admin without an audit row", async () => {
            const id = (await book()).body.data.id as number;
            const patient = await call("get", `/api/consultations/${id}`, "patient");
            expect(patient.status).toBe(200); expect(patient.body.data.complaintText).toBe(COMPLAINT);
            expect(patient.body.data.doctor).toMatchObject({ displayName: "Dr Synthetic", profileHydrated: true });
            const doctor = await call("get", `/api/consultations/${id}?timezone=Asia/Tokyo`, "doctor");
            expect(doctor.status).toBe(200); expect(doctor.body.data).toMatchObject({ complaintText: COMPLAINT, timezone: "Asia/Tokyo" });
            expect(doctor.body.data.startsAtLocal).toMatch(/\+09:00$/);
            expect(await audits("consultation.read")).toHaveLength(2);
            const admin = await call("get", `/api/consultations/${id}`, "admin");
            expect(admin.status).toBe(200); expect(admin.body.data).not.toHaveProperty("complaintText");
            expect(admin.body.data).toMatchObject({ timezone: "UTC", doctor: { profileHydrated: true }, patient: { displayName: "Pat Synthetic", profileHydrated: true } });
            expect(await audits("consultation.read")).toHaveLength(2);
            expect(JSON.stringify(admin.body)).not.toContain(COMPLAINT);
        });

        it("should answer 404 for a stranger, an unknown id and a non-numeric id, without an audit row", async () => {
            const id = (await book()).body.data.id as number;
            for (const [path, actor] of [[`/api/consultations/${id}`, "otherPatient"], [`/api/consultations/${id}`, "otherDoctor"], ["/api/consultations/99999", "patient"],
                ["/api/consultations/abc", "patient"], ["/api/consultations/99999", "admin"]] as const) {
                const res = await call("get", path, actor);
                expect(res.status).toBe(404); expectErrorEnvelope(res.body, "NotFound");
            }
            expect(await audits("consultation.read")).toHaveLength(0);
        });
    });

    // ───────────────────────────────────────────── patients relationship
    describe("GET /api/patients/{patientUserId}", () => {
        const profile = async (): Promise<void> => { await ownerDb("patient_profiles").insert({ user_id: PATIENT, timezone: "UTC", allergies: ["SYNTHETIC-ALLERGEN"] }); };

        it("should serve the patient themself and a doctor with a consultation, auditing each read", async () => {
            await profile(); await book();
            const self = await call("get", `/api/patients/${PATIENT}`, "patient");
            expect(self.status).toBe(200); expect(self.body.data.allergies).toEqual(["SYNTHETIC-ALLERGEN"]);
            const doctor = await call("get", `/api/patients/${PATIENT}`, "doctor");
            expect(doctor.status).toBe(200); expect(doctor.headers["cache-control"]).toBe(contractNoStoreValue());
            const rows = await audits("patient_profile.read");
            expect(rows.map((row) => [row.actor_role, row.metadata])).toEqual([["patient", { patientUserId: PATIENT, viewerRole: "patient" }], ["doctor", { patientUserId: PATIENT, viewerRole: "doctor" }]]);
        });

        it("should answer 403 for an admin and for a suspended doctor, and 404 for an unrelated doctor, another patient, a cancelled-only relationship and no profile", async () => {
            await profile(); const id = (await book()).body.data.id as number;
            expect((await call("get", `/api/patients/${PATIENT}`, "admin")).status).toBe(403);
            for (const [path, actor] of [[`/api/patients/${PATIENT}`, "otherDoctor"], [`/api/patients/${PATIENT}`, "otherPatient"], ["/api/patients/abc", "doctor"]] as const) {
                expect((await call("get", path, actor)).status).toBe(404);
            }
            await cancel(id, "patient");
            expect((await call("get", `/api/patients/${PATIENT}`, "doctor")).status).toBe(404);
            await ownerDb("consultations").where("id", id).update({ status: "completed", cancelled_at: null, cancelled_by: null });
            expect((await call("get", `/api/patients/${PATIENT}`, "doctor")).status).toBe(200);
            await ownerDb("patient_profiles").delete();
            expect((await call("get", `/api/patients/${PATIENT}`, "doctor")).status).toBe(404);
            await ownerDb("doctor_profiles").where("user_id", DOCTOR).update({ suspended_at: new Date(), suspension_reason: "synthetic" });
            expect((await call("get", `/api/patients/${PATIENT}`, "doctor")).status).toBe(403);
            expect((await call("get", "/api/patients/me", "patient")).status).toBe(404);
        });
    });

    // ───────────────────────────────────────────── ports
    describe("impact ports", () => {
        const HOURS = "/api/doctors/me/working-hours";

        it("should answer 409 with the real consultation ids when new hours strand a booking, then flag and queue on confirmConflicts", async () => {
            const id = (await book()).body.data.id as number;
            const weekday = DateTime.fromISO(body().startsAt as string, { setZone: true }).setZone("Africa/Cairo").weekday;
            const other = weekday === 1 ? 2 : 1;
            const days = [{ weekday: other, intervals: [{ startTime: "09:00", endTime: "17:00" }] }];
            const refused = await call("put", HOURS, "doctor", { days });
            expect(refused.status).toBe(409); expectErrorEnvelope(refused.body, "ScheduleConflictsUnconfirmed");
            expect(refused.body.conflicts).toEqual({ consultationIds: [id], count: 1 });
            const confirmed = await call("put", HOURS, "doctor", { days, confirmConflicts: true });
            expect(confirmed.status).toBe(200);
            const [row] = await consultationRows();
            expect(row).toMatchObject({ needs_admin_followup: true, followup_reason: "schedule_blocked", status: "booked" });
            expect((await outbox()).filter((entry) => entry.kind === "schedule_blocked").map((entry) => Number(entry.recipient_user_id))).toEqual([PATIENT]);
            expect(await audits("schedule.conflicts_confirmed")).toHaveLength(1);
            const queue = await call("get", "/api/consultations?needsAdminFollowup=true", "admin");
            expect(queue.body.data.map((item: { id: number }) => item.id)).toEqual([id]);
            expect(queue.body.data[0]).toMatchObject({ needsAdminFollowup: true, followupReason: "schedule_blocked" });
        });

        it("should queue exactly one schedule_blocked row when two successive confirmed changes leave the same booking uncovered", async () => {
            const id = (await book()).body.data.id as number;
            const weekday = DateTime.fromISO(body().startsAt as string, { setZone: true }).setZone("Africa/Cairo").weekday;
            const other = weekday === 1 ? 2 : 1;
            const first = [{ weekday: other, intervals: [{ startTime: "09:00", endTime: "17:00" }] }];
            const second = [{ weekday: other, intervals: [{ startTime: "10:00", endTime: "16:00" }] }];
            expect((await call("put", HOURS, "doctor", { days: first, confirmConflicts: true })).status).toBe(200);
            const refused = await call("put", HOURS, "doctor", { days: second });
            expect(refused.status).toBe(409);
            expect(refused.body.conflicts).toEqual({ consultationIds: [id], count: 1 });
            expect((await call("put", HOURS, "doctor", { days: second, confirmConflicts: true })).status).toBe(200);
            const blocked = (await outbox()).filter((entry) => entry.kind === "schedule_blocked");
            expect(blocked.map((entry) => Number(entry.recipient_user_id))).toEqual([PATIENT]);
            expect(await audits("schedule.conflicts_confirmed")).toHaveLength(2);
        });

        it("should not flag a booking that stays inside the new hours", async () => {
            await book();
            const all = [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, intervals: [{ startTime: "08:00", endTime: "18:00" }] }));
            expect((await call("put", HOURS, "doctor", { days: all })).status).toBe(200);
            expect((await consultationRows())[0]).toMatchObject({ needs_admin_followup: false });
        });

        it("should flag future non-terminal consultations for a suspension and list them again", async () => {
            const id = (await book()).body.data.id as number;
            const done = await seedConsultation({ status: "completed", starts_at: new Date(Date.now() - 86_400_000), ends_at: new Date(Date.now() - 86_400_000 + 1_800_000) });
            const provider = new ConsultationSuspensionImpactProvider();
            const ctx = { doctorProfileId: 1, doctorUserId: DOCTOR, now: new Date() };
            const flagged = await db.transaction((trx) => provider.flagFutureConsultations(ctx, trx));
            expect(flagged).toEqual([id]);
            expect(await provider.listFlaggedConsultations(ctx, db)).toEqual([id]);
            expect((await consultationRows()).find((row) => row.id === done)).toMatchObject({ needs_admin_followup: false });
            expect((await consultationRows()).find((row) => row.id === id)).toMatchObject({ needs_admin_followup: true, followup_reason: "doctor_suspended", status: "booked" });
        });
    });

    // ───────────────────────────────────────────── query plans
    describe("query plans", () => {
        const filter = (changes: Partial<ConsultationListFilter> = {}): ConsultationListFilter => ({
            doctorUserId: null, patientUserId: null, scope: ConsultationScope.Upcoming, statuses: null, from: null, to: null,
            needsAdminFollowup: null, now: new Date(), after: null, fetch: 21, ...changes,
        });
        /** 3000 synthetic rows (50 doctors x 60 hourly slots, 30 patients, a few flagged) and fresh statistics, so the planner has a real choice. */
        async function seedMany(): Promise<void> {
            await ownerDb.raw(`INSERT INTO consultations (doctor_user_id, patient_user_id, consultation_type_id, starts_at, ends_at, status, complaint_text, patient_timezone,
                    price, currency, idempotency_key, request_hash, needs_admin_followup, followup_reason)
                SELECT 1000 + (i % 50), 100 + (i % 30), 1, now() + (i / 50) * interval '1 hour' - interval '30 hours', now() + (i / 50) * interval '1 hour' - interval '30 hours' + interval '30 minutes',
                    'booked', 'SYNTHETIC', 'UTC', 100, 'EGP', gen_random_uuid(), repeat('a', 64), (i % 97 = 0), CASE WHEN i % 97 = 0 THEN 'schedule_blocked' END
                FROM generate_series(1, 3000) AS i`);
            await ownerDb.raw("ANALYZE consultations");
        }
        async function plan(sql: string): Promise<string> {
            await seedMany();
            return db.transaction(async (trx) => {
                await trx.raw("SET LOCAL enable_seqscan = off");
                const result = await trx.raw<{ rows: Array<{ "QUERY PLAN": string }> }>(`EXPLAIN ${sql}`);
                return result.rows.map((row) => row["QUERY PLAN"]).join("\n");
            });
        }

        it.each([
            ["the patient list, ascending", filter({ patientUserId: PATIENT }), "idx_consultations_patient_user_id_starts_at_id"],
            ["the patient list, descending (past)", filter({ patientUserId: PATIENT, scope: ConsultationScope.Past }), "idx_consultations_patient_user_id_starts_at_id"],
            ["the doctor list", filter({ doctorUserId: DOCTOR }), "idx_consultations_doctor_user_id_starts_at_id"],
            ["the follow-up queue", filter({ needsAdminFollowup: true, scope: ConsultationScope.All }), "idx_consultations_followup_starts_at_id"],
            ["the unfiltered admin list", filter({ scope: ConsultationScope.All }), "idx_consultations_starts_at_id"],
        ])("should use the named index for %s", async (_label, listFilter, index) => {
            expect(await plan(listPageQuery(listFilter, db).toQuery())).toContain(index);
        });

        it("should use the partial relationship index", async () => {
            expect(await plan(hasRelationshipQuery(DOCTOR, PATIENT, db).toQuery())).toContain("idx_consultations_doctor_user_id_patient_user_id");
        });
    });

    // ───────────────────────────────────────────── rate limit
    it("should answer 429 after ten booking writes per minute from one patient", async () => {
        const statuses: number[] = [];
        for (let i = 0; i < 11; i += 1) statuses.push((await book("patient", body({ startsAt: localStart(3, "10:15") }))).status);
        expect(statuses.slice(0, 10).every((status) => status === 422)).toBe(true);
        expect(statuses[10]).toBe(429);
    });
});
