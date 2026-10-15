import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { ConsultationReminderService } from "../../src/app/consultations/service/consultation-reminder.service";
import { ConsultationSuspensionImpactProvider } from "../../src/app/consultations/service/suspension-impact.provider";
import { NotificationsService } from "../../src/app/notifications/service/notifications.service";
import { OutboxDeliveryService } from "../../src/app/notifications/service/outbox-delivery.service";
import { OutboxPurgeService } from "../../src/app/notifications/service/outbox-purge.service";
import { ReminderScanService } from "../../src/app/notifications/service/reminder-scan.service";
import * as outboxRepo from "../../src/app/notifications/repository/notification-outbox.repo";
import { getEnv } from "../../src/lib/config/env";
import { container } from "../../src/lib/di/container";
import { TOKENS } from "../../src/lib/di/tokens";
import { LogEmailAdapter } from "../../src/lib/email/log-email.adapter";
import type { IdentityClient } from "../../src/lib/identity-client/identity-client";
import { db } from "../../src/lib/knex/knex";
import { logger } from "../../src/lib/logger/logger";
import { buildWorkerLoops } from "../../src/worker-loops";
import {
    ADMIN, COMPLAINT, DAY, DOCTOR, HOUR, MINUTE, OTHER_PATIENT, PATIENT, REASON, bookingBody, localStart, useConsultationsHarness,
} from "../helpers/consultations-harness";
import { ownerDb } from "../helpers/db";
import { FakeClock } from "../helpers/fake-clock";
import { fakeLogger } from "../helpers/fake-logger";
import { captureLogs, expectNoSensitiveStrings } from "../helpers/log-capture";
import { RecordingEmail } from "../helpers/recording-email";

jest.setTimeout(60_000);

const env = getEnv();
const signal = (): AbortSignal => new AbortController().signal;

interface OutboxRow { id: number; kind: string; consultation_id: number | null; recipient_user_id: number; status: string; attempts: number; next_attempt_at: Date; last_error_code: string | null; sent_at: Date | null; payload: Record<string, unknown> }
const outboxRows = (): Promise<OutboxRow[]> => ownerDb<OutboxRow>("notification_outbox").select("*").orderBy("id");

function runWorkerOnce(loop: string): Promise<{ code: number | null; output: string }> {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ["--import", "tsx", "src/worker.ts", "--once", loop], {
            cwd: path.resolve(__dirname, "..", ".."), env: { ...process.env, LOG_LEVEL: "info" }, stdio: ["ignore", "pipe", "pipe"],
        });
        let output = "";
        const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`worker did not exit; output: ${output}`)); }, 45_000);
        child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
        child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
        child.on("exit", (code) => { clearTimeout(timer); resolve({ code, output }); });
        child.on("error", reject);
    });
}

describe("notifications (integration: real Postgres and Redis, fake Identity, recording email port)", () => {
    const h = useConsultationsHarness("notifications");
    let clock: FakeClock;
    let email: RecordingEmail;

    const identity = (): IdentityClient => container.resolve<IdentityClient>(TOKENS.IDENTITY_CLIENT);
    const delivery = (options: { clock?: FakeClock; email?: RecordingEmail; log?: ReturnType<typeof fakeLogger>["logger"] } = {}): OutboxDeliveryService =>
        new OutboxDeliveryService(db, identity(), options.email ?? email, new ConsultationReminderService(), env, options.log ?? fakeLogger().logger, options.clock ?? clock);
    const scanner = (useClock: FakeClock = clock): ReminderScanService =>
        new ReminderScanService(db, new ConsultationReminderService(), new NotificationsService(), fakeLogger().logger, useClock);

    async function insertOutbox(count: number, changes: Record<string, unknown> = {}): Promise<number[]> {
        const consultationId = await h.seedConsultation();
        const rows = await ownerDb("notification_outbox").insert(Array.from({ length: count }, () => ({
            kind: "booking_confirmed", consultation_id: consultationId, recipient_user_id: PATIENT, payload: JSON.stringify({ startsAt: new Date().toISOString(), recipientRole: "patient" }),
            status: "pending", next_attempt_at: new Date(), ...changes,
        }))).returning("id");
        return rows.map((row: { id: number }) => row.id);
    }

    beforeEach(() => {
        clock = new FakeClock(Date.now() + 5_000);
        email = new RecordingEmail();
        h.identityServer.contacts.set(PATIENT, { id: PATIENT, email: "synthetic.patient@example.test", fullName: "Synthetic Patient", locale: "en", status: "active" });
        h.identityServer.contacts.set(DOCTOR, { id: DOCTOR, email: "synthetic.doctor@example.test", fullName: "Synthetic Doctor", locale: "en", status: "active" });
        h.identityServer.contacts.set(OTHER_PATIENT, { id: OTHER_PATIENT, email: "synthetic.other@example.test", fullName: "Synthetic Other", locale: "en", status: "active" });
        h.identityServer.tokenScopes.length = 0;
    });

    describe("outbox claim and delivery", () => {
        it("should send 200 rows exactly once with two concurrent workers (N-R2)", async () => {
            const ids = await insertOutbox(200);
            const second = new RecordingEmail();
            await Promise.all([delivery().tick(signal()), delivery({ email: second }).tick(signal())]);
            const sentIds = [...email.ids(), ...second.ids()].sort((a, b) => a - b);
            expect(sentIds).toEqual(ids);
            const rows = await outboxRows();
            expect(rows.every((row) => row.status === "sent" && row.sent_at !== null && row.attempts === 1 && row.last_error_code === null)).toBe(true);
        });

        it("should run as care_app with column-level update only (the service never needs more)", async () => {
            const [id] = await insertOutbox(1);
            await delivery().tick(signal());
            expect((await outboxRows()).find((row) => row.id === id)?.status).toBe("sent");
        });

        it("should send again after a crash between send and mark, once, and let the stale writer change nothing (N-R3, at-least-once)", async () => {
            const [id = 0] = await insertOutbox(1);
            // Worker A claims (lease 300 s) and "crashes" after sending, before marking.
            const first = await outboxRepo.claimDue(new Date(clock.now()), 20, 300, db);
            expect(first.map((row) => [row.id, row.attempts])).toEqual([[id, 1]]);
            await expect(outboxRepo.claimDue(new Date(clock.now() + 10_000), 20, 300, db)).resolves.toEqual([]);
            // Past the lease the row is due again and is sent by the next worker.
            clock.advance(301_000);
            await delivery().tick(signal());
            expect(email.ids()).toEqual([id]);
            expect((await outboxRows())[0]).toMatchObject({ status: "sent", attempts: 2 });
            // The late worker A tries to write its result with claim number 1: nothing changes.
            await expect(outboxRepo.finishRows([{ id, expectedAttempts: 1, status: "dead" as never, attemptsDelta: 0, nextAttemptAt: null, lastErrorCode: null, sentAt: null }], db)).resolves.toEqual([]);
            expect((await outboxRows())[0]).toMatchObject({ status: "sent", attempts: 2 });
        });

        it("should back off and dead-letter after 8 failing sends (N-R6)", async () => {
            const [id = 0] = await insertOutbox(1);
            email.fallback = { outcome: "transient", errorCode: "x" };
            const delays: number[] = [];
            for (let attempt = 1; attempt <= 8; attempt++) {
                const before = clock.now();
                await delivery().tick(signal());
                const row = (await outboxRows())[0];
                expect(row?.attempts).toBe(attempt);
                if (attempt < 8) {
                    expect(row).toMatchObject({ status: "pending", last_error_code: "email_error" });
                    delays.push((row?.next_attempt_at.getTime() ?? 0) - before);
                    clock.set(row?.next_attempt_at.getTime() ?? 0);
                }
            }
            expect(delays).toEqual([30_000, 60_000, 120_000, 240_000, 480_000, 960_000, 1_800_000]);
            expect((await outboxRows())[0]).toMatchObject({ id, status: "dead", attempts: 8, last_error_code: "email_error", sent_at: null });
            expect(email.messages).toHaveLength(8);
            clock.advance(10 * DAY);
            await delivery().tick(signal());
            expect(email.messages).toHaveLength(8);
        });

        it("should keep rows pending without consuming attempts while Identity contacts are down, bookings unaffected, then recover (N-R5, N-R7)", async () => {
            h.identityServer.options.contactsFailures = Infinity;
            const booked = await h.book("patient", bookingBody({ startsAt: localStart(3, "10:00") }));
            expect(booked.status).toBe(201);
            expect((await outboxRows()).length).toBeGreaterThan(0);
            const pending = (await outboxRows()).length;
            await delivery().tick(signal());
            await delivery().tick(signal());
            expect(email.messages).toHaveLength(0);
            const rows = await outboxRows();
            expect(rows).toHaveLength(pending);
            expect(rows.every((row) => row.status === "pending" && row.attempts === 0 && row.last_error_code === "contacts_unavailable")).toBe(true);
            h.identityServer.options.contactsFailures = 0;
            clock.advance(10 * 60_000);
            await delivery().tick(signal());
            expect(email.messages.length).toBe(pending);
            expect((await outboxRows()).every((row) => row.status === "sent")).toBe(true);
        });

        it("should skip an unknown recipient and a suspended recipient without sending", async () => {
            h.identityServer.contacts.delete(PATIENT);
            h.identityServer.contacts.set(DOCTOR, { id: DOCTOR, email: "synthetic.doctor@example.test", fullName: "Synthetic Doctor", locale: "en", status: "suspended" });
            const consultationId = await h.seedConsultation();
            await ownerDb("notification_outbox").insert([PATIENT, DOCTOR].map((recipient) => ({
                kind: "booking_confirmed", consultation_id: consultationId, recipient_user_id: recipient, payload: "{}", status: "pending", next_attempt_at: new Date(),
            })));
            await delivery().tick(signal());
            expect(email.messages).toHaveLength(0);
            expect((await outboxRows()).map((row) => [row.status, row.last_error_code])).toEqual([["skipped", "recipient_unknown"], ["skipped", "recipient_inactive"]]);
        });
    });

    describe("reminder scan", () => {
        /** Booked well before the window opens (3 days earlier), so the confirmation does not cover the reminder. */
        const startsIn = (ms: number): { starts_at: Date; ends_at: Date; created_at: Date } => ({
            starts_at: new Date(Date.now() + ms), ends_at: new Date(Date.now() + ms + 30 * MINUTE), created_at: new Date(Date.now() + ms - 3 * DAY),
        });
        const reminders = (): Promise<OutboxRow[]> => outboxRows().then((rows) => rows.filter((row) => row.kind.startsWith("reminder_")));
        const stamps = (id: number): Promise<{ reminder_24h_sent_at: Date | null; reminder_1h_sent_at: Date | null; updated_at: Date }> =>
            ownerDb("consultations").select("reminder_24h_sent_at", "reminder_1h_sent_at", "updated_at").where({ id }).first();

        it("should queue each reminder once per recipient across repeated and concurrent scans (N-R11, N-R12)", async () => {
            const id = await h.seedConsultation(startsIn(20 * HOUR));
            const before = await stamps(id);
            await Promise.all([scanner().tick(signal()), scanner().tick(signal())]);
            await scanner().tick(signal());
            const rows = await reminders();
            expect(rows.map((row) => [row.kind, row.recipient_user_id]).sort()).toEqual([["reminder_24h", PATIENT], ["reminder_24h", DOCTOR]]);
            const after = await stamps(id);
            expect(after.reminder_24h_sent_at).not.toBeNull();
            expect(after.reminder_1h_sent_at).toBeNull();
            expect(after.updated_at).toEqual(before.updated_at);
        });

        it("should send the 1 h reminder when it comes due after the 24 h one", async () => {
            await h.seedConsultation(startsIn(20 * HOUR));
            await scanner().tick(signal());
            const advanced = new FakeClock(Date.now() + 19.5 * HOUR);
            await scanner(advanced).tick(signal());
            expect((await reminders()).map((row) => row.kind).sort()).toEqual(["reminder_1h", "reminder_1h", "reminder_24h", "reminder_24h"]);
        });

        it("should stamp without queuing when the consultation was booked inside the window", async () => {
            const times = startsIn(10 * HOUR);
            const id = await h.seedConsultation({ ...times, created_at: new Date(times.starts_at.getTime() - 5 * HOUR) });
            await scanner().tick(signal());
            expect(await reminders()).toHaveLength(0);
            expect((await stamps(id)).reminder_24h_sent_at).not.toBeNull();
        });

        it("should queue only the 1 h reminder inside the last hour and stamp the 24 h one (N-D6)", async () => {
            const id = await h.seedConsultation(startsIn(50 * MINUTE));
            await scanner().tick(signal());
            expect((await reminders()).map((row) => row.kind)).toEqual(["reminder_1h", "reminder_1h"]);
            const marks = await stamps(id);
            expect(marks.reminder_24h_sent_at).not.toBeNull();
            expect(marks.reminder_1h_sent_at).not.toBeNull();
        });

        it("should not queue for a started, cancelled or soft-deleted consultation, or one beyond 24 h", async () => {
            await h.seedConsultation({ ...startsIn(-5 * MINUTE) });
            await h.seedConsultation({ doctor_user_id: 301, status: "cancelled", cancelled_at: new Date(), cancelled_by: "admin", ...startsIn(10 * HOUR) });
            await h.seedConsultation({ doctor_user_id: 302, deleted_at: new Date(), ...startsIn(10 * HOUR) });
            await h.seedConsultation({ doctor_user_id: 303, ...startsIn(25 * HOUR) });
            await scanner().tick(signal());
            expect(await reminders()).toHaveLength(0);
        });

        it("should still queue reminders for a booked consultation flagged for admin follow-up (N-R22)", async () => {
            await h.seedConsultation({ needs_admin_followup: true, followup_reason: "schedule_blocked", ...startsIn(20 * HOUR) });
            await scanner().tick(signal());
            expect(await reminders()).toHaveLength(2);
        });

        it("should re-arm after a reschedule and drop the stale queued reminders at claim (N-R10, N-R13)", async () => {
            const times = startsIn(20 * HOUR);
            const id = await h.seedConsultation(times);
            await scanner().tick(signal());
            // What rescheduleRow does: new interval, both marks cleared.
            const moved = new Date(times.starts_at.getTime() + 3 * HOUR);
            await ownerDb("consultations").where({ id }).update({ starts_at: moved, ends_at: new Date(moved.getTime() + 30 * MINUTE), reminder_24h_sent_at: null, reminder_1h_sent_at: null });
            await scanner().tick(signal());
            expect(await reminders()).toHaveLength(4);
            await delivery().tick(signal());
            const rows = await reminders();
            expect(rows.filter((row) => row.status === "skipped").map((row) => row.last_error_code)).toEqual(["consultation_changed", "consultation_changed"]);
            expect(rows.filter((row) => row.status === "sent")).toHaveLength(2);
        });

        it("should drop a queued reminder whose consultation was cancelled before the claim", async () => {
            const id = await h.seedConsultation(startsIn(20 * HOUR));
            await scanner().tick(signal());
            await ownerDb("consultations").where({ id }).update({ status: "cancelled", cancelled_at: new Date(), cancelled_by: "patient" });
            await delivery().tick(signal());
            expect(email.messages).toHaveLength(0);
            expect((await reminders()).map((row) => [row.status, row.last_error_code])).toEqual([["skipped", "consultation_changed"], ["skipped", "consultation_changed"]]);
        });

        it("should skip a locked row and pick it up on the next scan", async () => {
            const id = await h.seedConsultation(startsIn(20 * HOUR));
            const locker = await ownerDb.transaction(async (trx) => {
                await trx.raw("SELECT id FROM consultations WHERE id = ? FOR UPDATE", [id]);
                await scanner().tick(signal());
                return (await trx("notification_outbox").count<Array<{ count: string }>>("id"))[0]?.count;
            });
            expect(Number(locker)).toBe(0);
            await scanner().tick(signal());
            expect(await reminders()).toHaveLength(2);
        });

        it("should issue the same number of statements for 1 and for 500 candidates", async () => {
            const statements: string[] = [];
            const listener = (query: { sql: string }): void => { statements.push(query.sql); };
            const count = async (): Promise<number> => {
                statements.length = 0;
                db.on("query", listener);
                try { await scanner().tick(signal()); } finally { db.removeListener("query", listener); }
                return statements.filter((sql) => /^(select|insert|update)/i.test(sql)).length;
            };
            await h.seedConsultation(startsIn(20 * HOUR));
            const one = await count();
            await ownerDb.raw("TRUNCATE notification_outbox");
            await ownerDb.raw(`INSERT INTO consultations (doctor_user_id, patient_user_id, consultation_type_id, starts_at, ends_at, status, complaint_text, patient_timezone, price, currency, idempotency_key, request_hash, created_at)
                SELECT 5000 + i, 6000 + i, 1, now() + interval '20 hours' + (i || ' seconds')::interval, now() + interval '21 hours' + (i || ' seconds')::interval, 'booked', 'SYNTHETIC', 'UTC', 100, 'EGP', gen_random_uuid(), repeat('a', 64), now() - interval '3 days'
                FROM generate_series(1, 150) AS i`);
            const many = await count();
            expect(one).toBeGreaterThan(0);
            expect(many).toBe(one);
            expect((await reminders()).length).toBe(300);
        });
    });

    describe("doctor_suspended producer", () => {
        const suspend = (): ReturnType<typeof h.call> => h.call("patch", `/api/admin/doctors/${DOCTOR}/suspend`, "admin", { reason: REASON }, { "Idempotency-Key": randomUUID() });
        const reinstate = (): ReturnType<typeof h.call> => h.call("patch", `/api/admin/doctors/${DOCTOR}/reinstate`, "admin", { reason: REASON }, { "Idempotency-Key": randomUUID() });
        const suspended = (): Promise<OutboxRow[]> => outboxRows().then((rows) => rows.filter((row) => row.kind === "doctor_suspended"));

        it("should queue one notice per affected patient in the suspension transaction, and none on a second suspension (N-R17)", async () => {
            expect((await h.book("patient", bookingBody({ startsAt: localStart(3, "10:00") }))).status).toBe(201);
            expect((await h.book("otherPatient", bookingBody({ startsAt: localStart(3, "11:00") }))).status).toBe(201);
            const first = await suspend();
            expect(first.status).toBe(200);
            expect(first.body.data.flaggedConsultationIds).toHaveLength(2);
            const rows = await suspended();
            expect(rows.map((row) => row.recipient_user_id).sort()).toEqual([PATIENT, OTHER_PATIENT]);
            expect(rows.every((row) => row.status === "pending" && Object.keys(row.payload).sort().join() === "endsAt,recipientRole,startsAt")).toBe(true);
            expect((await reinstate()).status).toBe(200);
            const second = await suspend();
            expect(second.status).toBe(200);
            expect(second.body.data.flaggedConsultationIds).toHaveLength(2);
            expect(await suspended()).toHaveLength(2);
        });

        it("should notify a consultation previously flagged schedule_blocked", async () => {
            const id = await h.seedConsultation({ needs_admin_followup: true, followup_reason: "schedule_blocked" });
            expect((await suspend()).status).toBe(200);
            expect((await suspended()).map((row) => row.consultation_id)).toEqual([id]);
        });

        it("should leave no notice when the suspension transaction rolls back (N-R1)", async () => {
            const id = await h.seedConsultation();
            const provider = new ConsultationSuspensionImpactProvider(new NotificationsService());
            await expect(db.transaction(async (trx) => {
                await provider.flagFutureConsultations({ doctorProfileId: 1, doctorUserId: DOCTOR, now: new Date() }, trx);
                throw new Error("rollback");
            })).rejects.toThrow("rollback");
            expect(await suspended()).toHaveLength(0);
            expect((await h.consultationRows()).find((row) => row.id === id)).toMatchObject({ needs_admin_followup: false });
        });

        it("should deliver the notice to the patient without a reason or a counterpart name", async () => {
            await h.book("patient", bookingBody({ startsAt: localStart(3, "10:00") }));
            await db("notification_outbox").where("kind", "booking_confirmed").update({ status: "skipped", last_error_code: "template_missing", next_attempt_at: new Date() }).catch(() => undefined);
            await ownerDb("notification_outbox").update({ status: "skipped", last_error_code: "template_missing" });
            await suspend();
            await delivery().tick(signal());
            expect(email.messages).toHaveLength(1);
            const message = email.messages[0];
            expect(message?.subject).toBe("We need to follow up on your consultation");
            expect(`${message?.subject}${message?.text}`).not.toContain(REASON);
            expect(`${message?.subject}${message?.text}`).not.toContain("Synthetic Doctor");
        });
    });

    describe("purge", () => {
        it("should delete only sent rows older than the cutoff, in batches, and keep pending, dead and skipped (N-R18)", async () => {
            const consultationId = await h.seedConsultation();
            const old = new Date(Date.now() - 40 * DAY);
            const recent = new Date(Date.now() - 5 * DAY);
            const base = { kind: "booking_confirmed", consultation_id: consultationId, recipient_user_id: PATIENT, payload: "{}", next_attempt_at: old };
            await ownerDb("notification_outbox").insert([
                { ...base, status: "sent", sent_at: old }, { ...base, status: "sent", sent_at: old }, { ...base, status: "sent", sent_at: recent },
                { ...base, status: "pending" }, { ...base, status: "dead" }, { ...base, status: "skipped" },
            ]);
            await new OutboxPurgeService(db, env, fakeLogger().logger, new FakeClock(Date.now())).tick(signal());
            expect((await outboxRows()).map((row) => row.status)).toEqual(["sent", "pending", "dead", "skipped"]);
        });
    });

    describe("query plans", () => {
        async function plan(sql: string, bindings: unknown[] = []): Promise<string> {
            return db.transaction(async (trx) => {
                const result = await trx.raw<{ rows: Array<{ "QUERY PLAN": string }> }>(`EXPLAIN ${sql}`, bindings as never);
                return result.rows.map((row) => row["QUERY PLAN"]).join("\n");
            });
        }

        it("should serve the claim, lag and purge queries from their partial indexes and the reminder queries from the booked index", async () => {
            const consultationId = await h.seedConsultation();
            await ownerDb.raw(`INSERT INTO notification_outbox (kind, consultation_id, recipient_user_id, payload, status, next_attempt_at, sent_at)
                SELECT 'booking_confirmed', ?, 101, '{}', CASE WHEN i <= 5000 THEN 'pending' ELSE 'sent' END,
                       now() - (i || ' seconds')::interval, CASE WHEN i <= 5000 THEN NULL ELSE now() - interval '40 days' - (i || ' seconds')::interval END
                FROM generate_series(1, 10000) AS i`, [consultationId]);
            await ownerDb.raw(`INSERT INTO consultations (doctor_user_id, patient_user_id, consultation_type_id, starts_at, ends_at, status, complaint_text, patient_timezone, price, currency, idempotency_key, request_hash)
                SELECT 7000 + i, 8000 + i, 1, now() + (i || ' minutes')::interval, now() + (i || ' minutes')::interval + interval '30 minutes', CASE WHEN i % 4 = 0 THEN 'booked' ELSE 'completed' END,
                       'SYNTHETIC', 'UTC', 100, 'EGP', gen_random_uuid(), repeat('a', 64)
                FROM generate_series(1, 6000) AS i`);
            await ownerDb.raw("ANALYZE notification_outbox");
            await ownerDb.raw("ANALYZE consultations");
            const claim = await plan(`SELECT id FROM notification_outbox WHERE status = 'pending' AND next_attempt_at <= now() ORDER BY next_attempt_at, id LIMIT 20 FOR UPDATE SKIP LOCKED`);
            expect(claim).toContain("idx_notification_outbox_pending_next_attempt_at_id");
            expect(claim).not.toMatch(/Seq Scan/);
            const lag = await plan(`SELECT MIN(next_attempt_at) FROM notification_outbox WHERE status = 'pending' AND next_attempt_at <= now()`);
            expect(lag).toContain("idx_notification_outbox_pending_next_attempt_at_id");
            expect(lag).not.toMatch(/Seq Scan/);
            const purge = await plan(`SELECT id FROM notification_outbox WHERE status = 'sent' AND sent_at < now() - interval '30 days' ORDER BY sent_at LIMIT 5000 FOR UPDATE SKIP LOCKED`);
            expect(purge).toContain("idx_notification_outbox_sent_at");
            expect(purge).not.toMatch(/Seq Scan/);
            const remind24 = await plan(`SELECT c.id FROM consultations c WHERE c.status = 'booked' AND c.deleted_at IS NULL AND c.starts_at > now() AND c.starts_at <= now() + interval '24 hours'
                AND c.reminder_24h_sent_at IS NULL ORDER BY c.starts_at, c.id LIMIT 200 FOR UPDATE OF c SKIP LOCKED`);
            expect(remind24).toContain("idx_consultations_booked_starts_at");
            const remind1 = await plan(`SELECT c.id FROM consultations c WHERE c.status = 'booked' AND c.deleted_at IS NULL AND c.starts_at > now() AND c.starts_at <= now() + interval '1 hour'
                AND c.reminder_1h_sent_at IS NULL ORDER BY c.starts_at, c.id LIMIT 200 FOR UPDATE OF c SKIP LOCKED`);
            expect(remind1).toContain("idx_consultations_booked_starts_at");
        });
    });

    describe("log hygiene and wiring", () => {
        it("should never log the address, name, complaint or reason through a full booking, cancel and delivery cycle (N-R14)", async () => {
            const address = "SYNTHETIC-ADDRESS-9911@example.test";
            const name = "SYNTHETIC-NAME-9911";
            h.identityServer.contacts.set(PATIENT, { id: PATIENT, email: address, fullName: name, locale: "en", status: "active" });
            h.identityServer.contacts.set(DOCTOR, { id: DOCTOR, email: "SYNTHETIC-ADDRESS-9922@example.test", fullName: "SYNTHETIC-NAME-9922", locale: "en", status: "active" });
            jest.replaceProperty(logger as unknown as { level: string }, "level", "debug");
            const capture = captureLogs();
            try {
                const booked = await h.book("patient", bookingBody({ startsAt: localStart(3, "10:00") }));
                expect(booked.status).toBe(201);
                expect((await h.cancel(booked.body.data.id as number, "admin", { reason: REASON })).status).toBe(200);
                await delivery({ log: logger, email: undefined }).tick(signal());
                const adapterRun = new OutboxDeliveryService(db, identity(), new LogEmailAdapter(logger), new ConsultationReminderService(), env, logger, clock);
                await ownerDb("notification_outbox").update({ status: "pending", sent_at: null, attempts: 0, next_attempt_at: new Date() });
                await adapterRun.tick(signal());
                h.identityServer.options.contactsFailures = 1;
                await ownerDb("notification_outbox").update({ status: "pending", sent_at: null, attempts: 0, next_attempt_at: new Date() });
                await adapterRun.tick(signal());
                expect(capture.text()).toContain("email_log_adapter_send");
                expectNoSensitiveStrings(capture, [address, name, "SYNTHETIC-ADDRESS-9922", "SYNTHETIC-NAME-9922", COMPLAINT, REASON, "Your consultation", "Hello"]);
                void ADMIN;
            } finally {
                capture.restore();
                jest.restoreAllMocks();
            }
        });

        it("should register the three notification loops in buildWorkerLoops", () => {
            const loops = buildWorkerLoops({ env, db, logger: fakeLogger().logger, storage: {} as never, identity: identity() });
            expect(loops.map((loop) => loop.name)).toEqual(expect.arrayContaining(["notification-outbox", "consultation-reminders", "notification-outbox-purge"]));
            expect(loops.find((loop) => loop.name === "notification-outbox")?.intervalMs).toBe(env.OUTBOX_POLL_SECONDS * 1000);
            expect(loops.find((loop) => loop.name === "consultation-reminders")?.intervalMs).toBe(env.REMINDER_SCAN_SECONDS * 1000);
            expect(loops.find((loop) => loop.name === "notification-outbox-purge")?.intervalMs).toBe(env.OUTBOX_PURGE_SECONDS * 1000);
        });

        it.each(["notification-outbox", "consultation-reminders", "notification-outbox-purge"])("should exit 0 after one tick for `worker --once %s`", async (loop) => {
            const result = await runWorkerOnce(loop);
            expect(result.code).toBe(0);
            expect(result.output).toContain("worker_once_completed");
        });

        it("should run exactly one tick of each notification loop through the real loop objects", async () => {
            await insertOutbox(1);
            const loops = buildWorkerLoops({ env, db, logger: fakeLogger().logger, storage: {} as never, identity: identity() });
            for (const name of ["notification-outbox", "consultation-reminders", "notification-outbox-purge"]) {
                await expect(loops.find((loop) => loop.name === name)?.tick(signal())).resolves.toBe("done");
            }
            expect((await outboxRows())[0]?.status).toBe("sent");
        });
    });
});
