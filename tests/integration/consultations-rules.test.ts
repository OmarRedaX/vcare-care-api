import { randomUUID } from "node:crypto";
import type { Knex } from "knex";
import { db } from "../../src/lib/knex/knex";
import { logger } from "../../src/lib/logger/logger";
import { container } from "../../src/lib/di/container";
import { TOKENS } from "../../src/lib/di/tokens";
import type { ScheduleImpactProvider } from "../../src/app/schedules/types";
import { expectErrorEnvelope } from "../helpers/contract";
import {
    ADMIN, ALLERGEN, COMPLAINT, DAY, DOCTOR, localStart, MINUTE, OTHER_PATIENT, PATIENT, REASON, bookingBody, useConsultationsHarness,
} from "../helpers/consultations-harness";
import { ownerDb } from "../helpers/db";
import { captureLogs } from "../helpers/log-capture";
import { redis } from "../../src/lib/redis/redis";
import type { ConsultationsService } from "../../src/app/consultations/service/consultations.service";
import type { AuthContext } from "../../src/lib/types/types";

jest.setTimeout(120_000);

const BERLIN_DOCTOR = 205;
const NEW_YORK_DOCTOR = 206;

describe("consultations business rules (integration: real routes, Postgres, Redis; only Identity faked)", () => {
    const h = useConsultationsHarness("consultations-rules");

    /** Polls until some backend waits on a lock (the request under test is blocked behind the lock the test holds). */
    async function waitForLockWaiter(): Promise<void> {
        for (let attempt = 0; attempt < 200; attempt += 1) {
            const result = await ownerDb.raw<{ rows: Array<{ n: number }> }>("SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND datname = current_database()");
            if ((result.rows[0]?.n ?? 0) > 0) return;
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
        throw new Error("no backend ever waited on a lock");
    }
    /** Holds `FOR UPDATE` on the doctor's profile in a real transaction until `release()`; `then` runs inside it just before the commit. */
    function holdProfileLock(mode: "UPDATE" | "SHARE", inside?: (trx: Knex.Transaction) => Promise<void>) {
        let release!: () => void;
        const released = new Promise<void>((resolve) => { release = resolve; });
        let locked!: () => void;
        const lockedSignal = new Promise<void>((resolve) => { locked = resolve; });
        const done = ownerDb.transaction(async (trx) => {
            await trx.raw(`SELECT id FROM doctor_profiles WHERE user_id = ? FOR ${mode}`, [DOCTOR]);
            locked();
            await released;
            if (inside !== undefined) await inside(trx);
        });
        return { locked: lockedSignal, release, done };
    }
    const xmins = async (table: string, where = "TRUE"): Promise<string[]> =>
        (await ownerDb.raw<{ rows: Array<{ x: string }> }>(`SELECT xmin::text AS x FROM ${table} WHERE ${where} ORDER BY 1`)).rows.map((row) => row.x);

    // ───────────────────────────────────────────── C-R2 concurrency
    describe("concurrency", () => {
        it("should let exactly one of five concurrent bookings of one slot win and answer the rest 409 SlotUnavailable", async () => {
            const tokens = await Promise.all([301, 302, 303, 304, 305].map((id) => h.signFor(id)));
            const responses = await Promise.all(tokens.map((token) => h.callWith(token, "post", "/api/consultations", bookingBody(), { "Idempotency-Key": randomUUID() })));
            expect(responses.map((res) => res.status).sort()).toEqual([201, 409, 409, 409, 409]);
            for (const loser of responses.filter((res) => res.status === 409)) expectErrorEnvelope(loser.body, "SlotUnavailable");
            expect(await h.consultationRows()).toHaveLength(1);
            expect(await h.outbox()).toHaveLength(2);
            expect(await h.audits("consultation.booked")).toHaveLength(1);
        });

        it("should let exactly one of two concurrent reschedules into one free slot win and leave the loser untouched", async () => {
            const a = await h.seedConsultation({ patient_user_id: PATIENT });
            const bStart = new Date(Date.now() + 4 * DAY);
            const b = await h.seedConsultation({ patient_user_id: OTHER_PATIENT, starts_at: bStart, ends_at: new Date(bStart.getTime() + 30 * MINUTE) });
            const target = localStart(6, "11:00");
            const [first, second] = await Promise.all([h.reschedule(a, "patient", { startsAt: target }), h.reschedule(b, "otherPatient", { startsAt: target })]);
            expect([first.status, second.status].sort()).toEqual([200, 409]);
            expectErrorEnvelope((first.status === 409 ? first : second).body, "SlotUnavailable");
            const loserId = first.status === 409 ? a : b;
            const rows = await h.consultationRows();
            expect(rows.filter((row) => new Date(row.starts_at).toISOString() === new Date(target).toISOString())).toHaveLength(1);
            expect(rows.find((row) => row.id === loserId)?.starts_at.getTime()).not.toBe(new Date(target).getTime());
            expect(await h.audits("consultation.rescheduled")).toHaveLength(1);
            expect((await h.outbox()).filter((row) => row.kind === "rescheduled")).toHaveLength(2);
        });

        it("should end cancelled with consistent audit when a cancel races a reschedule of the same consultation", async () => {
            const id = await h.seedConsultation();
            const [cancelled, moved] = await Promise.all([h.cancel(id, "patient"), h.reschedule(id, "admin", { startsAt: localStart(6, "11:00"), reason: REASON })]);
            expect(cancelled.status).toBe(200);
            expect([200, 409]).toContain(moved.status);
            if (moved.status === 409) expectErrorEnvelope(moved.body, "InvalidTransition");
            const [row] = await h.consultationRows();
            expect(row).toMatchObject({ status: "cancelled" });
            expect(await h.audits("consultation.rescheduled")).toHaveLength(moved.status === 200 ? 1 : 0);
            expect(await h.audits("consultation.cancelled")).toHaveLength(1);
        });

        it("should answer a second request with the same key while the first is still running with 409 Conflict and Retry-After: 1", async () => {
            const key = randomUUID();
            const lock = holdProfileLock("UPDATE");
            await lock.locked;
            const first = Promise.resolve(h.book("patient", bookingBody(), key));
            await waitForLockWaiter();
            const inFlight = await h.book("patient", bookingBody(), key);
            expect(inFlight.status).toBe(409); expectErrorEnvelope(inFlight.body, "Conflict");
            expect(inFlight.headers["retry-after"]).toBe("1");
            lock.release(); await lock.done;
            const created = await first;
            expect(created.status).toBe(201);
            const replay = await h.book("patient", bookingBody(), key);
            expect(replay.status).toBe(201);
            expect(replay.body.data.id).toBe(created.body.data.id);
            expect(await h.consultationRows()).toHaveLength(1);
        });
    });

    // ───────────────────────────────────────────── C-R8 idempotency
    describe("idempotency", () => {
        it.each([
            ["book", () => h.call("post", "/api/consultations", "patient", bookingBody())],
            ["reschedule", () => h.call("patch", "/api/consultations/1/reschedule", "patient", { startsAt: localStart(5, "11:00") })],
            ["cancel", () => h.call("patch", "/api/consultations/1/cancel", "patient", {})],
        ])("should answer 400 ValidationFailed on %s without an Idempotency-Key and on a key that is not a UUID", async (_name, send) => {
            await h.seedConsultation();
            const missing = await send();
            expect(missing.status).toBe(400); expectErrorEnvelope(missing.body, "ValidationFailed");
            expect(missing.body.error.details).toEqual([{ field: "Idempotency-Key", issue: "is required" }]);
            const malformed = await send().set("Idempotency-Key", "not-a-uuid");
            expect(malformed.status).toBe(400); expect(malformed.body.error.details).toEqual([{ field: "Idempotency-Key", issue: "must be a UUID" }]);
            expect((await h.consultationRows())[0]).toMatchObject({ status: "booked" });
        });

        it("should replay a reschedule for the same key and body without a second write, and answer 422 for another body", async () => {
            const id = await h.seedConsultation();
            const key = randomUUID();
            const payload = { startsAt: localStart(5, "11:00"), reason: REASON };
            const first = await h.reschedule(id, "patient", payload, key);
            const again = await h.reschedule(id, "patient", payload, key);
            expect(first.status).toBe(200); expect(again.status).toBe(200);
            expect(again.body.data).toEqual(first.body.data);
            expect(await h.audits("consultation.rescheduled")).toHaveLength(1);
            expect((await h.outbox()).filter((row) => row.kind === "rescheduled")).toHaveLength(2);
            const conflicting = await h.reschedule(id, "patient", { startsAt: localStart(5, "12:00"), reason: REASON }, key);
            expect(conflicting.status).toBe(422); expectErrorEnvelope(conflicting.body, "IdempotencyConflict");
        });

        it("should replay a cancel for the same key, answer InvalidTransition for a new key, and 422 for the same key with another body", async () => {
            const id = await h.seedConsultation();
            const key = randomUUID();
            const first = await h.cancel(id, "doctor", { reason: REASON }, key);
            const again = await h.cancel(id, "doctor", { reason: REASON }, key);
            expect(first.status).toBe(200); expect(again.status).toBe(200);
            expect(again.body.data).toEqual(first.body.data);
            expect(await h.audits("consultation.cancelled")).toHaveLength(1);
            const retriedWithNewKey = await h.cancel(id, "doctor", { reason: REASON });
            expect(retriedWithNewKey.status).toBe(409); expectErrorEnvelope(retriedWithNewKey.body, "InvalidTransition");
            const conflicting = await h.cancel(id, "doctor", { reason: `${REASON} changed` }, key);
            expect(conflicting.status).toBe(422); expectErrorEnvelope(conflicting.body, "IdempotencyConflict");
        });

        it("should answer both of two concurrent same-key bookings with one consultation when the Redis idempotency record is bypassed", async () => {
            const service = container.resolve<ConsultationsService>(TOKENS.ConsultationsService);
            const actor: AuthContext = { userId: PATIENT, role: "patient", status: "active", emailVerified: true };
            const input = { doctorId: DOCTOR, typeId: 1, startsAtMs: Date.parse(localStart(3, "10:00")), complaintText: COMPLAINT, patientTimezone: "America/New_York" };
            const key = randomUUID();
            const results = await Promise.allSettled([service.book(actor, input, key, "a".repeat(64)), service.book(actor, input, key, "a".repeat(64))]);
            expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
            const ids = results.map((result) => (result as PromiseFulfilledResult<{ id: number }>).value.id);
            expect(ids[0]).toBe(ids[1]);
            expect(await h.consultationRows()).toHaveLength(1);
            expect(await h.outbox()).toHaveLength(2);
        });

        it("should keep the full response, complaint text included, in the Redis idempotency record for at most 24 hours (documented retention)", async () => {
            const key = randomUUID();
            expect((await h.book("patient", bookingBody(), key)).status).toBe(201);
            const keys = await redis.keys(`idem:*${key}`);
            expect(keys).toHaveLength(1);
            const stored = await redis.get(keys[0] ?? "");
            expect(stored).toContain(COMPLAINT);
            expect(await redis.ttl(keys[0] ?? "")).toBeLessThanOrEqual(86_400);
            expect(await redis.ttl(keys[0] ?? "")).toBeGreaterThan(0);
        });

        it("should scope a key to its principal so another patient can use the same key", async () => {
            const key = randomUUID();
            expect((await h.book("patient", bookingBody({ startsAt: localStart(3, "10:00") }), key)).status).toBe(201);
            expect((await h.book("otherPatient", bookingBody({ startsAt: localStart(3, "11:00") }), key)).status).toBe(201);
            expect(await h.consultationRows()).toHaveLength(2);
        });

        it("should not store a failed attempt: a retry with the same key books once the cause is gone", async () => {
            const key = randomUUID();
            await ownerDb.raw("ALTER TABLE audit_logs ADD CONSTRAINT chk_audit_booked_retry_test CHECK (action <> 'consultation.booked')");
            try {
                expect((await h.book("patient", bookingBody(), key)).status).toBe(500);
            } finally {
                await ownerDb.raw("ALTER TABLE audit_logs DROP CONSTRAINT IF EXISTS chk_audit_booked_retry_test");
            }
            const retry = await h.book("patient", bookingBody(), key);
            expect(retry.status).toBe(201);
            expect(await h.consultationRows()).toHaveLength(1);
        });
    });

    // ───────────────────────────────────────────── C-R3 DST
    describe("booking across daylight-saving changes (fixed clock, doctor timezone)", () => {
        const typeOf = async (userId: number): Promise<number> => Number((await ownerDb("consultation_types").join("doctor_profiles", "doctor_profiles.id", "consultation_types.doctor_profile_id")
            .where("doctor_profiles.user_id", userId).select("consultation_types.id").first() as { id: number }).id);
        async function bookAt(doctorId: number, iso: string, zone: string) {
            await h.resetRateLimits();
            return h.book("patient", bookingBody({ doctorId, typeId: await typeOf(doctorId), startsAt: iso, patientTimezone: zone }));
        }
        const expectBooked = (res: { status: number; body: { data: Record<string, unknown> } }, iso: string, local: string): void => {
            expect(res.status).toBe(201);
            expect(Date.parse(res.body.data.startsAt as string)).toBe(Date.parse(iso));
            expect(res.body.data.startsAtLocal).toBe(local);
        };

        beforeEach(async () => {
            await h.seedDoctor(BERLIN_DOCTOR, {}, { timezone: "Europe/Berlin", start: "01:00", end: "05:00" });
            await h.seedDoctor(NEW_YORK_DOCTOR, {}, { timezone: "America/New_York", start: "00:00", end: "04:00" });
        });

        it("should book both occurrences of the repeated hour when Berlin falls back and render each with its own offset", async () => {
            h.clock.freeze(Date.parse("2026-10-20T00:00:00Z"));
            expectBooked(await bookAt(BERLIN_DOCTOR, "2026-10-25T02:30:00+02:00", "Europe/Berlin"), "2026-10-25T00:30:00Z", "2026-10-25T02:30:00+02:00");
            expectBooked(await bookAt(BERLIN_DOCTOR, "2026-10-25T02:30:00+01:00", "Europe/Berlin"), "2026-10-25T01:30:00Z", "2026-10-25T02:30:00+01:00");
            expectBooked(await bookAt(BERLIN_DOCTOR, "2026-10-25T01:00:00+02:00", "Europe/Berlin"), "2026-10-24T23:00:00Z", "2026-10-25T01:00:00+02:00");
            expectBooked(await bookAt(BERLIN_DOCTOR, "2026-10-25T04:30:00+01:00", "Europe/Berlin"), "2026-10-25T03:30:00Z", "2026-10-25T04:30:00+01:00");
        });

        it("should keep the grid in real elapsed minutes across the fall-back and refuse an off-grid minute and the closing instant", async () => {
            h.clock.freeze(Date.parse("2026-10-20T00:00:00Z"));
            for (const iso of ["2026-10-25T02:15:00+01:00", "2026-10-25T02:45:00+02:00", "2026-10-25T05:00:00+01:00", "2026-10-25T00:30:00+02:00"]) {
                const res = await bookAt(BERLIN_DOCTOR, iso, "Europe/Berlin");
                expect([iso, res.status]).toEqual([iso, 422]);
                expectErrorEnvelope(res.body, "OutsideWorkingHours");
            }
            expect(await h.consultationRows()).toHaveLength(0);
        });

        it("should show different offsets for the days before and after the Berlin change", async () => {
            h.clock.freeze(Date.parse("2026-10-20T00:00:00Z"));
            expectBooked(await bookAt(BERLIN_DOCTOR, "2026-10-24T03:00:00+02:00", "Europe/Berlin"), "2026-10-24T01:00:00Z", "2026-10-24T03:00:00+02:00");
            expectBooked(await bookAt(BERLIN_DOCTOR, "2026-10-26T03:00:00+01:00", "Europe/Berlin"), "2026-10-26T02:00:00Z", "2026-10-26T03:00:00+01:00");
        });

        it("should book back-to-back across the Berlin spring-forward gap and render an instant inside the skipped hour after the gap", async () => {
            h.clock.freeze(Date.parse("2026-03-20T00:00:00Z"));
            expectBooked(await bookAt(BERLIN_DOCTOR, "2026-03-29T01:30:00+01:00", "Europe/Berlin"), "2026-03-29T00:30:00Z", "2026-03-29T01:30:00+01:00");
            expectBooked(await bookAt(BERLIN_DOCTOR, "2026-03-29T03:00:00+02:00", "Europe/Berlin"), "2026-03-29T01:00:00Z", "2026-03-29T03:00:00+02:00");
            // 02:30 +01:00 is 01:30Z: a wall time that does not exist in Berlin that day, rendered as 03:30 +02:00.
            expectBooked(await bookAt(BERLIN_DOCTOR, "2026-03-29T02:30:00+01:00", "Europe/Berlin"), "2026-03-29T01:30:00Z", "2026-03-29T03:30:00+02:00");
            expectBooked(await bookAt(BERLIN_DOCTOR, "2026-03-29T04:30:00+02:00", "Europe/Berlin"), "2026-03-29T02:30:00Z", "2026-03-29T04:30:00+02:00");
            const closing = await bookAt(BERLIN_DOCTOR, "2026-03-29T05:00:00+02:00", "Europe/Berlin");
            expect(closing.status).toBe(422); expectErrorEnvelope(closing.body, "OutsideWorkingHours");
        });

        it("should book both occurrences of 01:30 when New York falls back and refuse the closing instant", async () => {
            h.clock.freeze(Date.parse("2026-10-25T00:00:00Z"));
            expectBooked(await bookAt(NEW_YORK_DOCTOR, "2026-11-01T01:30:00-04:00", "America/New_York"), "2026-11-01T05:30:00Z", "2026-11-01T01:30:00-04:00");
            expectBooked(await bookAt(NEW_YORK_DOCTOR, "2026-11-01T01:30:00-05:00", "America/New_York"), "2026-11-01T06:30:00Z", "2026-11-01T01:30:00-05:00");
            expectBooked(await bookAt(NEW_YORK_DOCTOR, "2026-11-01T03:30:00-05:00", "America/New_York"), "2026-11-01T08:30:00Z", "2026-11-01T03:30:00-05:00");
            const closing = await bookAt(NEW_YORK_DOCTOR, "2026-11-01T04:00:00-05:00", "America/New_York");
            expect(closing.status).toBe(422); expectErrorEnvelope(closing.body, "OutsideWorkingHours");
        });

        it("should book on either side of the New York spring-forward gap and refuse an off-grid minute", async () => {
            h.clock.freeze(Date.parse("2026-03-01T00:00:00Z"));
            expectBooked(await bookAt(NEW_YORK_DOCTOR, "2026-03-08T01:30:00-05:00", "America/New_York"), "2026-03-08T06:30:00Z", "2026-03-08T01:30:00-05:00");
            expectBooked(await bookAt(NEW_YORK_DOCTOR, "2026-03-08T03:00:00-04:00", "America/New_York"), "2026-03-08T07:00:00Z", "2026-03-08T03:00:00-04:00");
            const off = await bookAt(NEW_YORK_DOCTOR, "2026-03-08T03:15:00-04:00", "America/New_York");
            expect(off.status).toBe(422); expectErrorEnvelope(off.body, "OutsideWorkingHours");
        });

        it("should evaluate past and horizon against the injected clock, not the wall clock", async () => {
            h.clock.freeze(Date.parse("2026-03-20T00:00:00Z"));
            const past = await bookAt(BERLIN_DOCTOR, "2026-03-19T03:00:00+01:00", "Europe/Berlin");
            expect(past.status).toBe(422); expectErrorEnvelope(past.body, "BookingInPast");
            const beyond = await bookAt(BERLIN_DOCTOR, "2026-05-30T03:00:00+02:00", "Europe/Berlin");
            expect(beyond.status).toBe(422); expectErrorEnvelope(beyond.body, "BeyondBookingHorizon");
        });

        it("should enforce the patient policy window against the injected clock", async () => {
            h.clock.freeze(Date.parse("2026-03-20T00:00:00Z"));
            const id = await h.seedConsultation({ starts_at: new Date("2026-03-20T02:00:00Z"), ends_at: new Date("2026-03-20T02:30:00Z") });
            h.clock.freeze(Date.parse("2026-03-20T00:00:00.001Z"));
            const blocked = await h.cancel(id, "patient");
            expect(blocked.status).toBe(409); expectErrorEnvelope(blocked.body, "PolicyWindowViolation");
            h.clock.freeze(Date.parse("2026-03-20T00:00:00Z"));
            expect((await h.cancel(id, "patient")).status).toBe(200);
        });
    });

    // ───────────────────────────────────────────── C-R6 suspension race
    describe("suspension racing a booking", () => {
        const suspend = () => h.call("patch", `/api/admin/doctors/${DOCTOR}/suspend`, "admin", { reason: `${REASON} suspension review` });

        it("should refuse a booking that waited behind the suspension transaction with 409 DoctorNotBookable and write nothing", async () => {
            const lock = holdProfileLock("UPDATE", async (trx) => {
                await trx("doctor_profiles").where("user_id", DOCTOR).update({ suspended_at: new Date(), suspension_reason: "synthetic", identity_sync_status: "pending" });
            });
            await lock.locked;
            const booking = Promise.resolve(h.book());
            await waitForLockWaiter();
            lock.release(); await lock.done;
            const res = await booking;
            expect(res.status).toBe(409); expectErrorEnvelope(res.body, "DoctorNotBookable");
            expect(await h.consultationRows()).toHaveLength(0);
            expect(await h.outbox()).toHaveLength(0);
            expect(await h.audits("consultation.booked")).toHaveLength(0);
        });

        it("should make the suspension wait for an in-flight booking and then flag that booking", async () => {
            const start = new Date(Date.now() + 3 * DAY);
            const lock = holdProfileLock("SHARE", async (trx) => {
                // What the booking transaction does after it passed the share-locked checks: it inserts and commits.
                await trx("consultations").insert({
                    doctor_user_id: DOCTOR, patient_user_id: PATIENT, consultation_type_id: 1, starts_at: start, ends_at: new Date(start.getTime() + 30 * MINUTE),
                    status: "booked", complaint_text: COMPLAINT, patient_timezone: "UTC", price: 15000, currency: "EGP", idempotency_key: randomUUID(), request_hash: "a".repeat(64),
                });
            });
            await lock.locked;
            const suspension = Promise.resolve(suspend());
            await waitForLockWaiter();
            lock.release(); await lock.done;
            const res = await suspension;
            expect(res.status).toBe(200);
            expect(res.body.data.flaggedConsultationIds).toEqual([(await h.consultationRows())[0]?.id]);
            expect((await h.consultationRows())[0]).toMatchObject({ needs_admin_followup: true, followup_reason: "doctor_suspended", status: "booked" });
        });

        it("should leave no booked consultation of a suspended doctor unflagged however the race interleaves", async () => {
            const outcomes = { booked: 0, refused: 0 };
            for (let round = 0; round < 8; round += 1) {
                await h.resetRateLimits();
                await ownerDb("notification_outbox").delete(); await ownerDb("consultations").delete(); await ownerDb("identity_sync_jobs").delete();
                await ownerDb("doctor_profiles").where("user_id", DOCTOR).update({ suspended_at: null, suspension_reason: null, identity_sync_status: "synced" });
                const user = h.identityServer.users.get(DOCTOR);
                if (user !== undefined) user.status = "active";
                const [booking, suspension] = await Promise.all([h.book("patient", bookingBody({ startsAt: localStart(3 + round, "10:00") })), suspend()]);
                expect(suspension.status).toBe(200);
                const rows = await h.consultationRows();
                if (booking.status === 201) {
                    outcomes.booked += 1;
                    expect(rows).toHaveLength(1);
                    expect(rows[0]).toMatchObject({ needs_admin_followup: true, followup_reason: "doctor_suspended" });
                } else {
                    outcomes.refused += 1;
                    expect(booking.status).toBe(409); expectErrorEnvelope(booking.body, "DoctorNotBookable");
                    expect(rows).toHaveLength(0);
                }
            }
            expect(outcomes.booked + outcomes.refused).toBe(8);
        });

        it("should reject every booking and reschedule after the suspension commits", async () => {
            const id = await h.seedConsultation();
            expect((await suspend()).status).toBe(200);
            const book = await h.book("otherPatient");
            expect(book.status).toBe(409); expectErrorEnvelope(book.body, "DoctorNotBookable");
            const move = await h.reschedule(id, "patient", { startsAt: localStart(5, "11:00") });
            expect(move.status).toBe(409); expectErrorEnvelope(move.body, "DoctorNotBookable");
            expect((await h.consultationRows())[0]).toMatchObject({ needs_admin_followup: true, followup_reason: "doctor_suspended", status: "booked" });
        });
    });

    // ───────────────────────────────────────────── C-R16 / C-R17 transactions
    describe("transactional atomicity of the write, its audit row and its outbox rows", () => {
        const withConstraint = async (table: string, name: string, check: string, run: () => Promise<void>): Promise<void> => {
            await ownerDb.raw(`ALTER TABLE ${table} ADD CONSTRAINT ${name} CHECK (${check})`);
            try { await run(); } finally { await ownerDb.raw(`ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${name}`); }
        };

        it("should leave no consultation, outbox or booked audit row when the audit insert of a booking fails", async () => {
            await withConstraint("audit_logs", "chk_audit_booked_atomic_test", "action <> 'consultation.booked'", async () => {
                const res = await h.book();
                expect(res.status).toBe(500); expectErrorEnvelope(res.body, "InternalError");
                expect(JSON.stringify(res.body)).not.toContain(COMPLAINT);
            });
            expect(await h.consultationRows()).toHaveLength(0);
            expect(await h.outbox()).toHaveLength(0);
            expect(await h.audits("consultation.booked")).toHaveLength(0);
            // The slot is not held by the failed attempt.
            expect((await h.book()).status).toBe(201);
        });

        it("should leave no consultation and no audit row when the outbox insert of a booking fails", async () => {
            await withConstraint("notification_outbox", "chk_outbox_booked_atomic_test", "kind <> 'booking_confirmed'", async () => {
                const res = await h.book();
                expect(res.status).toBe(500); expectErrorEnvelope(res.body, "InternalError");
            });
            expect(await h.consultationRows()).toHaveLength(0);
            expect(await h.audits("consultation.booked")).toHaveLength(0);
        });

        it("should keep the old interval, flags and reminder marks when the audit insert of a reschedule fails", async () => {
            const marked = new Date(Date.now() - 3_600_000);
            const id = await h.seedConsultation({ needs_admin_followup: true, followup_reason: "schedule_blocked", reminder_24h_sent_at: marked });
            const [before] = await h.consultationRows();
            await withConstraint("audit_logs", "chk_audit_rescheduled_atomic_test", "action <> 'consultation.rescheduled'", async () => {
                expect((await h.reschedule(id, "patient", { startsAt: localStart(5, "11:00"), reason: REASON })).status).toBe(500);
            });
            const [after] = await h.consultationRows();
            expect(after).toEqual(before);
            expect((await h.outbox()).filter((row) => row.kind === "rescheduled")).toHaveLength(0);
            expect(await h.audits("consultation.rescheduled")).toHaveLength(0);
        });

        it("should keep the consultation booked with no cancel stamp when the audit insert of a cancel fails", async () => {
            const id = await h.seedConsultation();
            const [before] = await h.consultationRows();
            await withConstraint("audit_logs", "chk_audit_cancelled_atomic_test", "action <> 'consultation.cancelled'", async () => {
                expect((await h.cancel(id, "doctor", { reason: REASON })).status).toBe(500);
            });
            expect((await h.consultationRows())[0]).toEqual(before);
            expect(await h.outbox()).toHaveLength(0);
        });

        it("should fail closed with no clinical text when the read audit of a consultation fails", async () => {
            const id = await h.seedConsultation();
            await withConstraint("audit_logs", "chk_audit_read_atomic_test", "action <> 'consultation.read'", async () => {
                const res = await h.call("get", `/api/consultations/${id}`, "patient");
                expect(res.status).toBe(500); expectErrorEnvelope(res.body, "InternalError");
                expect(JSON.stringify(res.body)).not.toContain(COMPLAINT);
            });
        });

        it("should write the consultation, its outbox rows and its audit row in one transaction for book, reschedule and cancel", async () => {
            const booked = await h.book();
            const id = booked.body.data.id as number;
            expect(await xmins("consultations")).toHaveLength(1);
            const bookTxn = (await xmins("consultations"))[0];
            expect(await xmins("notification_outbox", "kind = 'booking_confirmed'")).toEqual([bookTxn, bookTxn]);
            expect(await xmins("audit_logs", "action = 'consultation.booked'")).toEqual([bookTxn]);
            expect((await h.audits("consultation.booked"))[0]?.request_id).toBe(booked.headers["x-request-id"]);

            const moved = await h.reschedule(id, "patient", { startsAt: localStart(5, "11:00"), reason: REASON });
            expect(moved.status).toBe(200);
            const moveTxn = (await xmins("consultations"))[0];
            expect(moveTxn).not.toBe(bookTxn);
            expect(await xmins("notification_outbox", "kind = 'rescheduled'")).toEqual([moveTxn, moveTxn]);
            expect(await xmins("audit_logs", "action = 'consultation.rescheduled'")).toEqual([moveTxn]);

            const cancelled = await h.cancel(id, "doctor", { reason: REASON });
            expect(cancelled.status).toBe(200);
            const cancelTxn = (await xmins("consultations"))[0];
            expect(await xmins("notification_outbox", "kind = 'cancelled'")).toEqual([cancelTxn, cancelTxn]);
            expect(await xmins("audit_logs", "action = 'consultation.cancelled'")).toEqual([cancelTxn]);
        });

        it("should keep every outbox payload to ids, instants and roles and every audit metadata clinical-free", async () => {
            const id = (await h.book()).body.data.id as number;
            await h.reschedule(id, "patient", { startsAt: localStart(5, "11:00"), reason: REASON });
            await h.cancel(id, "doctor", { reason: REASON });
            const allowed = new Set(["startsAt", "endsAt", "previousStartsAt", "byRole", "recipientRole"]);
            for (const row of await h.outbox()) {
                for (const key of Object.keys(row.payload as Record<string, unknown>)) expect(allowed.has(key)).toBe(true);
            }
            const serialized = JSON.stringify([await h.outbox(), await ownerDb("audit_logs").select("metadata")]);
            for (const secret of [COMPLAINT, REASON, "example.test", ALLERGEN]) expect(serialized).not.toContain(secret);
        });
    });

    // ───────────────────────────────────────────── audit on clinical reads
    describe("audit of clinical reads", () => {
        it("should write one consultation.read row per participant read carrying the actor, entity, request id and no clinical text", async () => {
            const id = await h.seedConsultation();
            const patientRead = await h.call("get", `/api/consultations/${id}`, "patient");
            const doctorRead = await h.call("get", `/api/consultations/${id}?timezone=Asia/Tokyo`, "doctor");
            const rows = await h.audits("consultation.read");
            expect(rows).toHaveLength(2);
            expect(rows[0]).toMatchObject({ actor_user_id: PATIENT, actor_role: "patient", entity_type: "consultation", entity_id: id, metadata: { viewerRole: "patient" } });
            expect(rows[1]).toMatchObject({ actor_user_id: DOCTOR, actor_role: "doctor", entity_id: id, metadata: { viewerRole: "doctor" } });
            expect(rows[0]?.request_id).toBe(patientRead.headers["x-request-id"]);
            expect(rows[1]?.request_id).toBe(doctorRead.headers["x-request-id"]);
            expect(JSON.stringify(rows)).not.toContain(COMPLAINT);
        });

        it("should write one patient_profile.read row per profile read and none for a denied or missing read", async () => {
            await h.seedConsultation();
            await ownerDb("patient_profiles").insert({ user_id: PATIENT, timezone: "UTC", allergies: [ALLERGEN] });
            expect((await h.call("get", `/api/patients/${PATIENT}`, "doctor")).status).toBe(200);
            expect((await h.call("get", `/api/patients/${PATIENT}`, "otherDoctor")).status).toBe(404);
            expect((await h.call("get", `/api/patients/${PATIENT}`, "admin")).status).toBe(403);
            expect((await h.call("get", `/api/patients/${PATIENT}`, "otherPatient")).status).toBe(404);
            const rows = await h.audits("patient_profile.read");
            expect(rows).toHaveLength(1);
            expect(rows[0]).toMatchObject({ actor_user_id: DOCTOR, entity_type: "patient_profile", metadata: { patientUserId: PATIENT, viewerRole: "doctor" } });
            expect(JSON.stringify(rows)).not.toContain(ALLERGEN);
        });

        it("should write no audit row for the list (no clinical text on list items) or for an admin get-one", async () => {
            const id = await h.seedConsultation();
            await h.call("get", "/api/consultations", "patient");
            await h.call("get", "/api/consultations", "doctor");
            await h.call("get", `/api/consultations/${id}`, "admin");
            expect(await h.audits("consultation.read")).toHaveLength(0);
        });

        it("should audit every write for any caller role with the acting role in the metadata", async () => {
            const id = (await h.book()).body.data.id as number;
            await h.reschedule(id, "admin", { startsAt: localStart(5, "11:00"), reason: REASON });
            await h.cancel(id, "admin", { reason: REASON });
            expect((await h.audits("consultation.booked", "consultation.rescheduled", "consultation.cancelled")).map((row) => [row.action, row.actor_role, row.actor_user_id]))
                .toEqual([["consultation.booked", "patient", PATIENT], ["consultation.rescheduled", "admin", ADMIN], ["consultation.cancelled", "admin", ADMIN]]);
        });
    });

    // ───────────────────────────────────────────── privacy
    describe("log hygiene", () => {
        it("should keep complaint text, reasons, allergens and tokens out of every log line across success, validation and failure paths", async () => {
            await ownerDb("patient_profiles").insert({ user_id: PATIENT, timezone: "UTC", allergies: [ALLERGEN] });
            // The suite runs at LOG_LEVEL=warn; lower the root logger so every request_completed line (info) is emitted and checked too.
            const level = logger as unknown as { level: string };
            const previousLevel = level.level;
            level.level = "debug";
            const logs = captureLogs();
            let ids: number[] = [];
            try {
                const booked = await h.book("patient", bookingBody({ startsAt: localStart(3, "10:00") }));
                const second = await h.book("patient", bookingBody({ startsAt: localStart(3, "11:00") }));
                const third = await h.book("patient", bookingBody({ startsAt: localStart(3, "12:00") }));
                ids = [booked.body.data.id, second.body.data.id, third.body.data.id] as number[];
                await h.book("patient", bookingBody({ complaintText: `${COMPLAINT} ${"x".repeat(5000)}` })); // 400 carrying the text in the body
                await h.book("otherPatient", bookingBody({ startsAt: localStart(3, "10:00") })); // 409
                await h.call("get", "/api/consultations", "patient"); await h.call("get", "/api/consultations", "admin");
                await h.call("get", `/api/consultations/${ids[0]}`, "patient"); await h.call("get", `/api/consultations/${ids[0]}`, "doctor");
                await h.call("get", `/api/patients/${PATIENT}`, "doctor");
                await h.reschedule(ids[0] as number, "patient", { startsAt: localStart(5, "11:00"), reason: REASON });
                await h.reschedule(ids[1] as number, "admin", { startsAt: localStart(5, "12:00"), reason: REASON });
                await h.reschedule(ids[1] as number, "admin", { startsAt: localStart(5, "12:00") }); // 400 without the required reason
                await h.cancel(ids[0] as number, "patient", { reason: REASON });
                await h.cancel(ids[1] as number, "doctor", { reason: REASON });
                await h.cancel(ids[2] as number, "admin", { reason: REASON });
                await h.cancel(ids[2] as number, "admin", { reason: REASON }); // 409 InvalidTransition
                await ownerDb.raw("ALTER TABLE audit_logs ADD CONSTRAINT chk_audit_logs_privacy_test CHECK (action <> 'consultation.read') NOT VALID");
                try { await h.call("get", `/api/consultations/${ids[0]}`, "patient"); } finally { await ownerDb.raw("ALTER TABLE audit_logs DROP CONSTRAINT IF EXISTS chk_audit_logs_privacy_test"); }
            } finally {
                logs.restore();
                level.level = previousLevel;
            }
            const text = logs.text();
            for (const secret of [COMPLAINT, REASON, ALLERGEN, ...Object.values(h.tokens), "Authorization", "Bearer "]) expect(text).not.toContain(secret);
            const completed = logs.lines().filter((line) => line.message === "request_completed");
            expect(completed.length).toBeGreaterThan(15);
            expect(completed.some((line) => String(line.route).includes("/api/consultations") && line.status === 201)).toBe(true);
            expect(completed.some((line) => line.status === 500)).toBe(true);
            for (const line of completed) {
                expect(Object.keys(line)).not.toContain("body");
                expect(Object.keys(line)).not.toContain("complaintText");
                expect(Object.keys(line)).not.toContain("cancelReason");
            }
        });
    });

    // ───────────────────────────────────────────── performance guards
    describe("performance budgets", () => {
        it("should keep booking p95 under 200 ms over 24 sequential bookings", async () => {
            await h.book("patient", bookingBody({ startsAt: localStart(20, "09:00") })); // warm-up: connections, JIT, caches
            const durations: number[] = [];
            for (let index = 0; index < 24; index += 1) {
                if (index % 5 === 0) await h.resetRateLimits();
                const startsAt = localStart(21 + Math.floor(index / 8), `${String(9 + (index % 8)).padStart(2, "0")}:00`);
                const started = performance.now();
                const res = await h.book("patient", bookingBody({ startsAt }));
                durations.push(performance.now() - started);
                expect(res.status).toBe(201);
            }
            durations.sort((a, b) => a - b);
            const p95 = durations[Math.ceil(durations.length * 0.95) - 1] ?? Infinity;
            expect(p95).toBeLessThan(200);
        });

        it("should find the affected consultations among 200 real rows with three queries inside the budget", async () => {
            await ownerDb.raw(`INSERT INTO consultations (doctor_user_id, patient_user_id, consultation_type_id, starts_at, ends_at, status, complaint_text, patient_timezone,
                    price, currency, idempotency_key, request_hash)
                SELECT ?, 100 + (i % 20), 1, ((current_date + 2 + (i / 4)) + make_time(10 + (i % 4), 0, 0)) AT TIME ZONE 'Africa/Cairo',
                    ((current_date + 2 + (i / 4)) + make_time(10 + (i % 4), 30, 0)) AT TIME ZONE 'Africa/Cairo', 'booked', 'SYNTHETIC', 'UTC', 100, 'EGP', gen_random_uuid(), repeat('a', 64)
                FROM generate_series(0, 199) AS i`, [DOCTOR]);
            await ownerDb("working_hours").update({ start_time: "12:00" });
            const provider = container.resolve<ScheduleImpactProvider>(TOKENS.ScheduleImpactProvider);
            const ctx = { doctorProfileId: 1, doctorUserId: DOCTOR, timezone: "Africa/Cairo", now: new Date(), change: { kind: "working_hours" as const } };
            await db.transaction((trx) => provider.findAffected(ctx, trx)); // warm-up
            const started = performance.now();
            const affected = await db.transaction((trx) => provider.findAffected(ctx, trx));
            const elapsed = performance.now() - started;
            // Rows at 10:00 and 11:00 local end before the new 12:00 opening; ids are insertion order, 4 rows per day.
            expect(affected).toEqual(Array.from({ length: 200 }, (_value, index) => index).filter((index) => index % 4 < 2).map((index) => index + 1));
            expect(elapsed).toBeLessThan(150);
        });
    });
});
