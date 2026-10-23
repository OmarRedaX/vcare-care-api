import { randomUUID } from "node:crypto";
import type { Express } from "express";
import { DateTime } from "luxon";
import request from "supertest";
import { container } from "../../src/lib/di/container";
import { TOKENS } from "../../src/lib/di/tokens";
import { buildTestApps } from "../helpers/app";
import { expectErrorEnvelope } from "../helpers/contract";
import { closeDb, ownerDb, truncateAll } from "../helpers/db";
import { buildFakeJwksWiring, startFakeJwks } from "../helpers/fake-jwks";
import { closeRedis } from "../helpers/redis";
import { signExpiredUserToken, signUserToken } from "../helpers/tokens";
import type { FakeJwks, FakeJwksWiring } from "../helpers/types";

jest.setTimeout(60_000);

describe("availability slots (integration: real Postgres and real wiring, AV-R1..AV-R13)", () => {
    let fake: FakeJwks;
    let wiring: FakeJwksWiring;
    let app: Express;
    const tokens = {} as Record<"patient" | "admin" | "doctor" | "pending" | "expired", string>;
    const previous: Array<{ token: symbol; value: unknown }> = [];
    let profileId: number;
    let typeId: number;
    let from: string;
    let to: string;

    const url = (id = 202, type = typeId, timezone?: string): string => `/api/doctors/${id}/slots?typeId=${type}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}` +
        (timezone === undefined ? "" : `&timezone=${encodeURIComponent(timezone)}`);
    const call = (token: string | undefined, path = url()) => {
        let test = request(app).get(path);
        if (token !== undefined) test = test.set("Authorization", `Bearer ${token}`);
        return test;
    };

    beforeAll(async () => {
        fake = await startFakeJwks(["availability"]);
        wiring = await buildFakeJwksWiring(fake);
        for (const token of [TOKENS.JwksCache, TOKENS.UserTokenVerifier]) previous.push({ token, value: container.resolve(token) });
        container.registerInstance(TOKENS.JwksCache, wiring.cache);
        container.registerInstance(TOKENS.UserTokenVerifier, wiring.verifier);
        app = buildTestApps().publicApp;
        tokens.patient = await signUserToken(fake.key("availability"), { sub: "101", role: "patient", status: "active" });
        tokens.admin = await signUserToken(fake.key("availability"), { sub: "303", role: "admin", status: "active" });
        tokens.doctor = await signUserToken(fake.key("availability"), { sub: "202", role: "doctor", status: "active" });
        tokens.pending = await signUserToken(fake.key("availability"), { sub: "101", role: "patient", status: "pending" });
        tokens.expired = await signExpiredUserToken(fake.key("availability"), { sub: "101", role: "patient", status: "active" });
    });

    beforeEach(async () => {
        await truncateAll();
        app = buildTestApps().publicApp;
        const local = DateTime.now().setZone("Africa/Cairo").plus({ days: 1 }).startOf("day");
        from = local.toISO()!;
        to = local.plus({ days: 1 }).toISO()!;
        const rows = await ownerDb("doctor_profiles").insert({ user_id: 202, headline: "Synthetic Doctor", years_experience: 5,
            consultation_fee: 1000, currency: "EGP", default_slot_minutes: 30, timezone: "Africa/Cairo",
            is_accepting_patients: true, verification_status: "approved", identity_sync_status: "synced", decided_at: new Date() }).returning("id");
        profileId = Number(rows[0]?.id);
        await ownerDb("working_hours").insert({ doctor_profile_id: profileId, weekday: local.weekday, start_time: "09:00", end_time: "11:00" });
        const types = await ownerDb("consultation_types").insert({ doctor_profile_id: profileId, name: "Synthetic Visit", duration_minutes: 30,
            price: 1000, currency: "EGP", is_active: true }).returning("id");
        typeId = Number(types[0]?.id);
    });

    afterAll(async () => {
        await truncateAll();
        for (const entry of previous) container.registerInstance(entry.token, entry.value);
        wiring.cache.stop(); await fake.close(); await closeRedis(); await closeDb();
    });

    it("should enforce patient and admin RBAC with no doctor or unauthenticated access", async () => {
        expect((await call(undefined)).status).toBe(401);
        expect((await call(tokens.expired)).status).toBe(401);
        expect((await call(tokens.doctor)).status).toBe(403);
        expect((await call(tokens.pending)).status).toBe(403);
        for (const token of [tokens.patient, tokens.admin]) {
            const response = await call(token);
            expect(response.status).toBe(200);
            expect(response.body.success).toBe(true);
            expect(response.body.data).toHaveLength(4);
            expect(response.body.meta).toMatchObject({ timezone: "UTC", doctorTimezone: "Africa/Cairo", count: 4 });
            expect(response.body.data[0]).toEqual(expect.objectContaining({ timezone: "UTC", startsAt: expect.any(String), endsAt: expect.any(String),
                startsAtLocal: expect.any(String), endsAtLocal: expect.any(String) }));
        }
    });

    it("should return 404 for an unknown, non-bookable, or foreign type for both roles", async () => {
        for (const token of [tokens.patient, tokens.admin]) {
            expectErrorEnvelope((await call(token, url(999))).body, "NotFound");
            expectErrorEnvelope((await call(token, url(202, 999))).body, "NotFound");
        }
        await ownerDb("doctor_profiles").where("id", profileId).update({ is_accepting_patients: false });
        for (const token of [tokens.patient, tokens.admin]) {
            const response = await call(token);
            expect(response.status).toBe(404); expectErrorEnvelope(response.body, "NotFound");
        }
    });

    it("should conceal every non-bookable doctor state from patients and admins", async () => {
        const states = [
            { suspended_at: new Date(), suspension_reason: "Synthetic QA suspension" },
            { is_accepting_patients: false },
            { verification_status: "submitted" },
            { identity_sync_status: "pending" },
        ];
        for (const state of states) {
            app = buildTestApps().publicApp;
            await ownerDb("doctor_profiles").where("id", profileId).update(state);
            for (const token of [tokens.patient, tokens.admin]) {
                const response = await call(token);
                expect(response.status).toBe(404); expectErrorEnvelope(response.body, "NotFound");
            }
            await ownerDb("doctor_profiles").where("id", profileId).update({ suspended_at: null, suspension_reason: null, is_accepting_patients: true,
                verification_status: "approved", identity_sync_status: "synced" });
        }
        app = buildTestApps().publicApp;
        await ownerDb("consultation_types").where("id", typeId).update({ is_active: false });
        for (const token of [tokens.patient, tokens.admin]) {
            const response = await call(token);
            expect(response.status).toBe(404); expectErrorEnvelope(response.body, "NotFound");
        }
    });

    it("should return empty clipped windows outside the booking horizon", async () => {
        const now = DateTime.now().toUTC();
        const windowUrl = (start: DateTime, end: DateTime): string =>
            `/api/doctors/202/slots?typeId=${typeId}&from=${encodeURIComponent(start.toISO()!)}&to=${encodeURIComponent(end.toISO()!)}`;
        const past = await call(tokens.patient, windowUrl(now.minus({ days: 3 }), now.minus({ days: 2 })));
        expect(past.status).toBe(200); expect(past.body.data).toEqual([]);
        expect(past.body.meta.from).toBe(past.body.meta.to);
        const future = await call(tokens.patient, windowUrl(now.plus({ days: 62 }), now.plus({ days: 63 })));
        expect(future.status).toBe(200); expect(future.body.data).toEqual([]);
        expect(future.body.meta.from).toBe(future.body.meta.to);
    });

    it("should validate the original window and IANA timezone", async () => {
        const reversed = `/api/doctors/202/slots?typeId=${typeId}&from=${encodeURIComponent(to)}&to=${encodeURIComponent(from)}`;
        const longTo = DateTime.fromISO(from).plus({ days: 15 }).toISO()!;
        for (const path of [reversed, `/api/doctors/202/slots?typeId=${typeId}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(longTo)}`,
            url(202, typeId, "Invalid/Zone"), url(202, typeId, "A".repeat(65)), `${url()}&unknown=1`]) {
            const response = await call(tokens.patient, path);
            expect(response.status).toBe(400); expectErrorEnvelope(response.body, "ValidationFailed");
        }
    });

    it("should compute from Postgres when Redis is unavailable and use the requested render zone", async () => {
        const response = await call(tokens.patient, url(202, typeId, "America/New_York"));
        expect(response.status).toBe(200);
        expect(response.body.data).toHaveLength(4);
        expect(response.body.data[0].timezone).toBe("America/New_York");
        expect(response.body.data[0].startsAt).toMatch(/Z$/);
        expect(response.body.data[0].startsAtLocal).toMatch(/-0[45]:00$/);
    });

    it("should remove a booked slot and restore it after cancellation through the real write routes", async () => {
        const before = await call(tokens.patient);
        const start = before.body.data[0]?.startsAt as string;
        const book = await request(app).post("/api/consultations").set("Authorization", `Bearer ${tokens.patient}`)
            .set("Idempotency-Key", randomUUID()).send({ doctorId: 202, typeId, startsAt: start,
                complaintText: "SYNTHETIC-SLOT-BOOKING-7701", patientTimezone: "UTC" });
        expect(book.status).toBe(201);
        const during = await call(tokens.patient);
        expect(during.status).toBe(200);
        expect(during.body.data.map((slot: { startsAt: string }) => slot.startsAt)).not.toContain(start);
        const id = Number(book.body.data.id);
        const cancel = await request(app).patch(`/api/consultations/${id}/cancel`).set("Authorization", `Bearer ${tokens.patient}`)
            .set("Idempotency-Key", randomUUID()).send({});
        expect(cancel.status).toBe(200);
        const after = await call(tokens.patient);
        expect(after.body.data.map((slot: { startsAt: string }) => slot.startsAt)).toContain(start);
    });

    it("should accept listed starts and reject an off-grid booking", async () => {
        const listed = await call(tokens.patient);
        expect(listed.status).toBe(200);
        const starts = [listed.body.data[0]?.startsAt, listed.body.data[2]?.startsAt] as string[];
        for (const start of starts) {
            const booked = await request(app).post("/api/consultations").set("Authorization", `Bearer ${tokens.patient}`)
                .set("Idempotency-Key", randomUUID()).send({ doctorId: 202, typeId, startsAt: start,
                    complaintText: "SYNTHETIC-SLOT-BOOKING-7702", patientTimezone: "UTC" });
            expect(booked.status).toBe(201);
        }
        const offGrid = DateTime.fromISO(starts[0]!).plus({ minutes: 5 }).toISO()!;
        const refused = await request(app).post("/api/consultations").set("Authorization", `Bearer ${tokens.patient}`)
            .set("Idempotency-Key", randomUUID()).send({ doctorId: 202, typeId, startsAt: offGrid,
                complaintText: "SYNTHETIC-SLOT-BOOKING-7703", patientTimezone: "UTC" });
        expect(refused.status).toBe(422); expectErrorEnvelope(refused.body, "OutsideWorkingHours");
    });
});
