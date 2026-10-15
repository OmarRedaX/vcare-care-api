import { randomUUID } from "node:crypto";
import { DateTime } from "luxon";
import { ConsultationReminderService } from "../../src/app/consultations/service/consultation-reminder.service";
import * as outboxRepo from "../../src/app/notifications/repository/notification-outbox.repo";
import { NotificationsService } from "../../src/app/notifications/service/notifications.service";
import { OutboxDeliveryService } from "../../src/app/notifications/service/outbox-delivery.service";
import { ReminderScanService } from "../../src/app/notifications/service/reminder-scan.service";
import { getEnv } from "../../src/lib/config/env";
import { container } from "../../src/lib/di/container";
import { TOKENS } from "../../src/lib/di/tokens";
import { LogEmailAdapter } from "../../src/lib/email/log-email.adapter";
import type { EmailMessage, EmailPort } from "../../src/lib/email/types";
import { IdentityClient } from "../../src/lib/identity-client/identity-client";
import { db } from "../../src/lib/knex/knex";
import { logger } from "../../src/lib/logger/logger";
import { redis } from "../../src/lib/redis/redis";
import {
    COMPLAINT, DAY, DOCTOR, HOUR, MINUTE, PATIENT, REASON, bookingBody, localStart, useConsultationsHarness,
} from "../helpers/consultations-harness";
import { ownerDb } from "../helpers/db";
import { FakeClock } from "../helpers/fake-clock";
import { FakeIdentityServer } from "../helpers/fake-identity-server";
import { fakeLogger } from "../helpers/fake-logger";
import { captureLogs, expectNoSensitiveStrings } from "../helpers/log-capture";
import { RecordingEmail } from "../helpers/recording-email";

jest.setTimeout(60_000);

const env = getEnv();
const signal = (): AbortSignal => new AbortController().signal;

interface OutboxRow { id: number; kind: string; consultation_id: number | null; recipient_user_id: number; status: string; attempts: number; next_attempt_at: Date; last_error_code: string | null; sent_at: Date | null; payload: Record<string, unknown> }
const outboxRows = (): Promise<OutboxRow[]> => ownerDb<OutboxRow>("notification_outbox").select("*").orderBy("id");

describe("notifications delivery (integration: remaining test-plan scenarios)", () => {
    const h = useConsultationsHarness("notifications-delivery");
    let clock: FakeClock;
    let email: RecordingEmail;

    const identity = (): IdentityClient => container.resolve<IdentityClient>(TOKENS.IDENTITY_CLIENT);
    const delivery = (options: { clock?: FakeClock; email?: EmailPort; identity?: IdentityClient; log?: ReturnType<typeof fakeLogger>["logger"] } = {}): OutboxDeliveryService =>
        new OutboxDeliveryService(db, options.identity ?? identity(), options.email ?? email, new ConsultationReminderService(), env, options.log ?? fakeLogger().logger, options.clock ?? clock);
    const scanner = (useClock: FakeClock): ReminderScanService =>
        new ReminderScanService(db, new ConsultationReminderService(), new NotificationsService(), fakeLogger().logger, useClock);

    async function insertOutbox(count: number, changes: Record<string, unknown> = {}, recipient = PATIENT, consultation: Record<string, unknown> = {}): Promise<number[]> {
        const consultationId = await h.seedConsultation(consultation);
        const rows = await ownerDb("notification_outbox").insert(Array.from({ length: count }, () => ({
            kind: "booking_confirmed", consultation_id: consultationId, recipient_user_id: recipient, payload: JSON.stringify({ startsAt: new Date().toISOString(), recipientRole: "patient" }),
            status: "pending", next_attempt_at: new Date(), ...changes,
        }))).returning("id");
        return rows.map((row: { id: number }) => row.id);
    }

    beforeEach(() => {
        clock = new FakeClock(Date.now() + 5_000);
        email = new RecordingEmail();
        for (const [id, label] of [[PATIENT, "patient"], [DOCTOR, "doctor"]] as const) {
            h.identityServer.contacts.set(id, { id, email: `synthetic.${label}@example.test`, fullName: `Synthetic ${label}`, locale: "en", status: "active" });
        }
        h.identityServer.tokenScopes.length = 0;
        h.identityServer.contactTokens.length = 0;
    });

    describe("claim", () => {
        it("should hand two concurrent claims disjoint row sets that together cover every due row (N-R2)", async () => {
            const ids = await insertOutbox(200);
            const [a, b] = await Promise.all([outboxRepo.claimDue(new Date(clock.now()), 120, 300, db), outboxRepo.claimDue(new Date(clock.now()), 120, 300, db)]);
            const idsA = a.map((row) => row.id);
            const idsB = b.map((row) => row.id);
            expect(idsA.filter((id) => idsB.includes(id))).toEqual([]);
            expect([...idsA, ...idsB].sort((x, y) => x - y)).toEqual(ids);
            expect([...a, ...b].every((row) => row.attempts === 1)).toBe(true);
        });

        it("should not return a leased row again until its lease has expired, then claim it with the next attempt number", async () => {
            const [id = 0] = await insertOutbox(1);
            expect((await outboxRepo.claimDue(new Date(clock.now()), 20, 300, db)).map((row) => row.attempts)).toEqual([1]);
            expect(await outboxRepo.claimDue(new Date(clock.now() + 299_000), 20, 300, db)).toEqual([]);
            const again = await outboxRepo.claimDue(new Date(clock.now() + 301_000), 20, 300, db);
            expect(again.map((row) => [row.id, row.attempts])).toEqual([[id, 2]]);
        });

        it("should look up all recipients of a 20-row batch with a single contacts call", async () => {
            const consultationId = await h.seedConsultation();
            await ownerDb("notification_outbox").insert(Array.from({ length: 20 }, (_, index) => ({
                kind: "booking_confirmed", consultation_id: consultationId, recipient_user_id: index % 2 === 0 ? PATIENT : DOCTOR, payload: "{}", status: "pending", next_attempt_at: new Date(),
            })));
            await delivery().tick(signal());
            const calls = h.identityServer.calls.filter((call) => call.path.startsWith("/internal/users/contacts"));
            expect(calls).toHaveLength(1);
            expect(email.messages).toHaveLength(20);
        });

        it("should hold no database transaction open while calling Identity contacts or the email port (N-R4)", async () => {
            await insertOutbox(2);
            const open = async (): Promise<number> => Number((await ownerDb.raw<{ rows: Array<{ n: string }> }>(
                "SELECT count(*) AS n FROM pg_stat_activity WHERE datname = current_database() AND state LIKE 'idle in transaction%'")).rows[0]?.n);
            const seen: number[] = [];
            const realIdentity = identity();
            const spyIdentity = { getContacts: async (ids: readonly number[], requestId: string) => { seen.push(await open()); return realIdentity.getContacts(ids, requestId); } } as unknown as IdentityClient;
            const spyEmail: EmailPort = { send: async () => { seen.push(await open()); return { outcome: "sent" }; } };
            await delivery({ identity: spyIdentity, email: spyEmail }).tick(signal());
            expect(seen).toHaveLength(3);
            expect(seen.every((count) => count === 0)).toBe(true);
        });

        it("should write no audit rows for a delivery (N-R21)", async () => {
            await insertOutbox(3);
            const before = Number((await ownerDb("audit_logs").count<Array<{ count: string }>>("id"))[0]?.count);
            await delivery().tick(signal());
            expect(Number((await ownerDb("audit_logs").count<Array<{ count: string }>>("id"))[0]?.count)).toBe(before);
        });
    });

    describe("failure handling", () => {
        it("should mark the row dead at once on a permanent provider rejection and never send it again (N-R9)", async () => {
            const [id = 0] = await insertOutbox(1);
            email.fallback = { outcome: "permanent", errorCode: "provider says no" };
            await delivery().tick(signal());
            expect((await outboxRows())[0]).toMatchObject({ id, status: "dead", attempts: 1, last_error_code: "email_rejected", sent_at: null });
            clock.advance(DAY);
            await delivery().tick(signal());
            expect(email.messages).toHaveLength(1);
        });

        it("should dead-letter a row that was claimed more than the maximum through lease expiries without sending it (N-R19)", async () => {
            await insertOutbox(1, { attempts: env.OUTBOX_MAX_ATTEMPTS });
            await delivery().tick(signal());
            expect(email.messages).toHaveLength(0);
            expect((await outboxRows())[0]).toMatchObject({ status: "dead", attempts: env.OUTBOX_MAX_ATTEMPTS + 1, last_error_code: "lease_expired" });
        });

        it("should grow the contacts delay with consecutive failures without consuming attempts, then deliver on the first try after recovery (N-R7)", async () => {
            const [id = 0] = await insertOutbox(1);
            h.identityServer.options.contactsFailures = Infinity;
            const service = delivery();
            const delays: number[] = [];
            for (let round = 0; round < 3; round++) {
                const before = clock.now();
                await service.tick(signal());
                const row = (await outboxRows())[0];
                expect(row).toMatchObject({ id, status: "pending", attempts: 0, last_error_code: "contacts_unavailable" });
                delays.push((row?.next_attempt_at.getTime() ?? 0) - before);
                clock.set(row?.next_attempt_at.getTime() ?? 0);
            }
            expect(delays).toEqual([30_000, 60_000, 120_000]);
            h.identityServer.options.contactsFailures = 0;
            await service.tick(signal());
            expect((await outboxRows())[0]).toMatchObject({ status: "sent", attempts: 1, last_error_code: null });
        });

        it("should take one backoff step per tick and leave the rest of the due rows due when Identity contacts is down for several batches (N-D1)", async () => {
            const ids = await insertOutbox(45);
            h.identityServer.options.contactsFailures = Infinity;
            const before = clock.now();
            await delivery().tick(signal());
            const rows = await outboxRows();
            const delayed = rows.filter((row) => row.last_error_code === "contacts_unavailable");
            expect(delayed).toHaveLength(env.OUTBOX_BATCH_SIZE);
            expect(delayed.every((row) => row.attempts === 0 && row.next_attempt_at.getTime() - before === 30_000)).toBe(true);
            const untouched = rows.filter((row) => row.last_error_code === null);
            expect(untouched).toHaveLength(ids.length - env.OUTBOX_BATCH_SIZE);
            expect(untouched.every((row) => row.attempts === 0 && row.next_attempt_at.getTime() <= before)).toBe(true);
            expect(h.identityServer.calls.filter((call) => call.path.startsWith("/internal/users/contacts"))).toHaveLength(1);
        });

        it("should count delayed rows in the oldest-pending-age gauge while the due-lag gauge reads zero (review Medium 2)", async () => {
            const [id = 0] = await insertOutbox(1);
            const now = new Date();
            await ownerDb("notification_outbox").where({ id }).update({
                created_at: new Date(now.getTime() - 90 * MINUTE), next_attempt_at: new Date(now.getTime() + 20 * MINUTE), last_error_code: "contacts_unavailable",
            });
            await expect(outboxRepo.oldestDueAgeSeconds(now, db)).resolves.toBe(0);
            await expect(outboxRepo.oldestPendingAgeSeconds(now, db)).resolves.toBe(90 * 60);
            await ownerDb("notification_outbox").where({ id }).update({ status: "skipped", last_error_code: "recipient_unknown" });
            await expect(outboxRepo.oldestPendingAgeSeconds(now, db)).resolves.toBe(0);
        });

        it("should hand the claim back without consuming an attempt when the database fails after the claim (review Low 5)", async () => {
            const [id = 0] = await insertOutbox(1);
            const contexts = new ConsultationReminderService();
            jest.spyOn(contexts, "findDeliveryContexts").mockRejectedValueOnce(new Error("synthetic database failure"));
            const service = new OutboxDeliveryService(db, identity(), email, contexts, env, fakeLogger().logger, clock);
            await expect(service.tick(signal())).rejects.toThrow("synthetic database failure");
            const row = (await outboxRows()).find((candidate) => candidate.id === id);
            expect(row).toMatchObject({ status: "pending", attempts: 0 });
            expect(row?.next_attempt_at.getTime()).toBeLessThanOrEqual(clock.now());
            await delivery().tick(signal());
            expect((await outboxRows())[0]).toMatchObject({ status: "sent", attempts: 1 });
        });

        it("should keep rows pending when the care-service client lacks the contact grant, while status changes keep working (own token, N-R7)", async () => {
            await insertOutbox(2);
            const fake = new FakeIdentityServer();
            const url = await fake.start();
            const client = new IdentityClient({ env: { ...env, IDENTITY_INTERNAL_URL: url }, redis, sleep: () => Promise.resolve() });
            try {
                fake.contacts.set(PATIENT, { id: PATIENT, email: "synthetic.patient@example.test", fullName: "Synthetic patient", locale: "en", status: "active" });
                fake.options.withholdContactScope = true;
                await delivery({ identity: client }).tick(signal());
                expect(email.messages).toHaveLength(0);
                expect((await outboxRows()).every((row) => row.status === "pending" && row.attempts === 0 && row.last_error_code === "contacts_unavailable")).toBe(true);
                fake.users.set(555, { id: 555, fullName: "Synthetic", avatarUrl: null, status: "pending" });
                await expect(client.setUserStatus(555, "active", "review", 7, "req-grant", 1)).resolves.toBeDefined();
                expect(fake.users.get(555)?.status).toBe("active");
                expect(fake.tokenScopes).toEqual(expect.arrayContaining(["users:contact:read", "users:read users:status:write"]));
                expect(fake.contactTokens).toEqual([]);
            } finally { await client.close(); await fake.close(); }
        });

        it("should never request the contact scope while serving a booking or a suspension (care-api path)", async () => {
            expect((await h.book("patient", bookingBody({ startsAt: localStart(3, "10:00") }))).status).toBe(201);
            const suspended = await h.call("patch", `/api/admin/doctors/${DOCTOR}/suspend`, "admin", { reason: REASON }, { "Idempotency-Key": randomUUID() });
            expect(suspended.status).toBe(200);
            expect(h.identityServer.tokenScopes.length).toBeGreaterThan(0);
            expect(h.identityServer.tokenScopes).not.toContain("users:contact:read");
        });
    });

    describe("rendering from the database (N-R15)", () => {
        it("should render each participant's copy in their own timezone and take the role from the database, not the payload", async () => {
            const booked = await h.book("patient", bookingBody({ startsAt: localStart(3, "10:00"), patientTimezone: "America/New_York" }));
            expect(booked.status).toBe(201);
            // Corrupt the payload hint: it says "patient" for the doctor's row. The database decides.
            await ownerDb("notification_outbox").where({ recipient_user_id: DOCTOR }).update({ payload: ownerDb.raw("jsonb_set(payload, '{recipientRole}', '\"patient\"')") }).catch(() => undefined);
            await delivery().tick(signal());
            const toPatient = email.messages.find((message) => message.meta.recipientUserId === PATIENT);
            const toDoctor = email.messages.find((message) => message.meta.recipientUserId === DOCTOR);
            expect(toPatient?.subject).toBe("Your consultation is booked");
            expect(toPatient?.text).toContain("(America/New_York)");
            expect(toDoctor?.subject).toBe("New consultation booked");
            expect(toDoctor?.text).toContain("(Africa/Cairo)");
        });

        it("should send the exact documented copy for a booking confirmation to a patient", async () => {
            const start = new Date(Math.ceil((Date.now() + 3 * DAY) / MINUTE) * MINUTE);
            const consultationId = await h.seedConsultation({ starts_at: start, ends_at: new Date(start.getTime() + 30 * MINUTE), patient_timezone: "UTC" });
            await ownerDb("notification_outbox").insert({
                kind: "booking_confirmed", consultation_id: consultationId, recipient_user_id: PATIENT, status: "pending", next_attempt_at: new Date(),
                payload: JSON.stringify({ startsAt: start.toISOString(), endsAt: new Date(start.getTime() + 30 * MINUTE).toISOString(), recipientRole: "patient" }),
            });
            await delivery().tick(signal());
            const when = DateTime.fromJSDate(start, { zone: "UTC" }).setLocale("en").toFormat("cccc d LLLL yyyy, HH:mm");
            expect(email.messages[0]?.subject).toBe("Your consultation is booked");
            expect(email.messages[0]?.text).toBe(`Hello Synthetic patient,

Your consultation is booked for ${when} (UTC). You can review it in your Vcare account.

The Vcare team`);
        });
    });

    describe("delayed notices against the current consultation state (N-D14)", () => {
        let slot = 0;
        async function queue(kind: string, consultation: Record<string, unknown>, payloadStart?: Date): Promise<{ consultationId: number; startsAt: Date }> {
            const startsAt = new Date(Math.ceil((Date.now() + 3 * DAY) / MINUTE) * MINUTE + (slot++) * HOUR);
            const cancelled = consultation.status === "cancelled" ? { cancelled_at: new Date(), cancelled_by: "patient" } : {};
            const consultationId = await h.seedConsultation({ starts_at: startsAt, ends_at: new Date(startsAt.getTime() + 30 * MINUTE), ...cancelled, ...consultation });
            await ownerDb("notification_outbox").insert({
                kind, consultation_id: consultationId, recipient_user_id: PATIENT, status: "pending", next_attempt_at: new Date(),
                payload: JSON.stringify({ startsAt: (payloadStart ?? startsAt).toISOString(), recipientRole: "patient" }),
            });
            return { consultationId, startsAt };
        }

        it("should skip a rescheduled notice for a cancelled consultation and one whose start moved, and send a current one", async () => {
            await queue("rescheduled", { status: "cancelled" });
            await queue("rescheduled", {}, new Date(Date.now() + 9 * DAY));
            await queue("rescheduled", {});
            await delivery().tick(signal());
            const rows = await outboxRows();
            expect(rows.map((row) => [row.status, row.last_error_code])).toEqual([["skipped", "consultation_changed"], ["skipped", "consultation_changed"], ["sent", null]]);
            expect(email.messages).toHaveLength(1);
        });

        it("should skip a doctor_suspended notice for a terminal consultation and word an in_progress one for a live session", async () => {
            await queue("doctor_suspended", { status: "completed" });
            await queue("doctor_suspended", { status: "in_progress" });
            await delivery().tick(signal());
            const rows = await outboxRows();
            expect(rows.map((row) => row.status)).toEqual(["skipped", "sent"]);
            expect(email.messages).toHaveLength(1);
            expect(email.messages[0]?.text).toContain("began on");
            expect(email.messages[0]?.text).not.toMatch(/scheduled for|not been cancelled/);
        });

        it("should still send a cancelled notice for a cancelled consultation", async () => {
            await queue("cancelled", { status: "cancelled" });
            await delivery().tick(signal());
            expect(email.messages).toHaveLength(1);
        });
    });

    describe("reminders end to end", () => {
        const at = (ms: number): { starts_at: Date; ends_at: Date; created_at: Date } => ({
            starts_at: new Date(ms), ends_at: new Date(ms + 30 * MINUTE), created_at: new Date(ms - 3 * DAY),
        });
        const reminders = (): Promise<OutboxRow[]> => outboxRows().then((rows) => rows.filter((row) => row.kind.startsWith("reminder_")));
        const stamp = (id: number): Promise<{ reminder_24h_sent_at: Date | null; reminder_1h_sent_at: Date | null }> =>
            ownerDb("consultations").select("reminder_24h_sent_at", "reminder_1h_sent_at").where({ id }).first();

        it("should apply the window boundaries exactly: 24 h and 1 h inclusive, the start itself and anything after it excluded", async () => {
            const T = Math.floor(Date.now() / 1000) * 1000;
            const scanClock = new FakeClock(T);
            const cases: Array<[number, number, string[]]> = [
                [401, 24 * HOUR, ["reminder_24h"]], [402, 24 * HOUR + 1, []], [403, 0, []], [404, 1, ["reminder_1h"]],
                [405, HOUR, ["reminder_1h"]], [406, HOUR + 1, ["reminder_24h"]], [407, -1, []],
            ];
            const ids = new Map<number, number>();
            for (const [doctor, offset] of cases) ids.set(doctor, await h.seedConsultation({ doctor_user_id: doctor, ...at(T + offset) }));
            await scanner(scanClock).tick(signal());
            const rows = await reminders();
            for (const [doctor, , kinds] of cases) {
                const forConsultation = rows.filter((row) => row.consultation_id === ids.get(doctor)).map((row) => row.kind);
                expect([...new Set(forConsultation)]).toEqual(kinds);
                expect(forConsultation).toHaveLength(kinds.length * 2);
            }
        });

        it("should stamp both columns without a message when a consultation is booked within the last hour", async () => {
            const T = Math.floor(Date.now() / 1000) * 1000;
            const id = await h.seedConsultation({ starts_at: new Date(T + 30 * MINUTE), ends_at: new Date(T + HOUR), created_at: new Date(T - 5 * MINUTE) });
            await scanner(new FakeClock(T)).tick(signal());
            expect(await reminders()).toHaveLength(0);
            const marks = await stamp(id);
            expect(marks.reminder_24h_sent_at).not.toBeNull();
            expect(marks.reminder_1h_sent_at).not.toBeNull();
        });

        it("should reset the marks on a real reschedule, re-fire both reminders for the new start, and drop the stale ones at claim (N-R13, N-R10)", async () => {
            const booked = await h.book("patient", bookingBody({ startsAt: localStart(3, "10:00") }));
            expect(booked.status).toBe(201);
            const id = booked.body.data.id as number;
            const first = (await ownerDb("consultations").select("starts_at").where({ id }).first()) as { starts_at: Date };
            const scanOne = new FakeClock(first.starts_at.getTime() - 20 * HOUR);
            await scanner(scanOne).tick(signal());
            expect((await reminders()).map((row) => row.kind)).toEqual(["reminder_24h", "reminder_24h"]);
            expect((await h.reschedule(id, "patient", { startsAt: localStart(5, "11:00") })).status).toBe(200);
            expect(await stamp(id)).toEqual({ reminder_24h_sent_at: null, reminder_1h_sent_at: null });
            const moved = (await ownerDb("consultations").select("starts_at").where({ id }).first()) as { starts_at: Date };
            const scanTwo = new FakeClock(moved.starts_at.getTime() - 20 * HOUR);
            await scanner(scanTwo).tick(signal());
            expect((await reminders()).filter((row) => row.kind === "reminder_24h")).toHaveLength(4);
            await delivery({ clock: scanTwo }).tick(signal());
            const rows = await reminders();
            expect(rows.filter((row) => row.status === "skipped").map((row) => row.last_error_code)).toEqual(["consultation_changed", "consultation_changed"]);
            expect(rows.filter((row) => row.status === "sent")).toHaveLength(2);
            expect(email.messages.filter((message) => message.meta.kind === "reminder_24h")).toHaveLength(2);
        });

        it("should drop a queued reminder at claim time when the consultation has meanwhile started (N-R10)", async () => {
            const T = Math.floor(Date.now() / 1000) * 1000;
            await h.seedConsultation(at(T + 50 * MINUTE));
            await scanner(new FakeClock(T)).tick(signal());
            expect((await reminders()).map((row) => row.kind)).toEqual(["reminder_1h", "reminder_1h"]);
            await delivery({ clock: new FakeClock(T + 51 * MINUTE) }).tick(signal());
            expect(email.messages).toHaveLength(0);
            expect((await reminders()).map((row) => [row.status, row.last_error_code])).toEqual([["skipped", "reminder_expired"], ["skipped", "reminder_expired"]]);
        });

        it("should deliver a reminder to the patient and the doctor in their own timezones", async () => {
            const T = Math.floor(Date.now() / 1000) * 1000;
            await h.seedConsultation({ ...at(T + 50 * MINUTE), patient_timezone: "America/New_York" });
            await scanner(new FakeClock(T)).tick(signal());
            await delivery({ clock: new FakeClock(T + 10_000) }).tick(signal());
            const byRecipient = new Map(email.messages.map((message) => [message.meta.recipientUserId, message]));
            expect(byRecipient.get(PATIENT)?.subject).toBe("Reminder: your consultation starts within 1 hour");
            expect(byRecipient.get(PATIENT)?.text).toContain("(America/New_York)");
            expect(byRecipient.get(DOCTOR)?.subject).toBe("Reminder: a consultation starts within 1 hour");
            expect(byRecipient.get(DOCTOR)?.text).toContain("(Africa/Cairo)");
        });

        it("should send each reminder to each recipient exactly once across repeated scans and deliveries", async () => {
            const T = Math.floor(Date.now() / 1000) * 1000;
            await h.seedConsultation(at(T + 20 * HOUR));
            const scanClock = new FakeClock(T);
            for (let round = 0; round < 3; round++) {
                await scanner(scanClock).tick(signal());
                await delivery({ clock: new FakeClock(T + 10_000) }).tick(signal());
            }
            expect(email.messages.map((message) => [message.meta.kind, message.meta.recipientUserId]).sort()).toEqual([["reminder_24h", PATIENT], ["reminder_24h", DOCTOR]]);
        });

        it("should not queue a second reminder for the same start while the first is still pending or already sent (reschedule A to B to A, N-R11)", async () => {
            const T = Math.floor(Date.now() / 1000) * 1000;
            const id = await h.seedConsultation(at(T + 20 * HOUR));
            const scanClock = new FakeClock(T);
            await scanner(scanClock).tick(signal());
            expect(await reminders()).toHaveLength(2);
            // A -> B -> A: both stamps are reset while the start is unchanged and the first reminders still sit in the outbox.
            await ownerDb("consultations").where({ id }).update({ reminder_24h_sent_at: null, reminder_1h_sent_at: null });
            await scanner(scanClock).tick(signal());
            expect(await reminders()).toHaveLength(2);
            expect((await stamp(id)).reminder_24h_sent_at).not.toBeNull();
            // Once delivered, a repeat is still suppressed.
            await delivery({ clock: new FakeClock(T + 10_000) }).tick(signal());
            await ownerDb("consultations").where({ id }).update({ reminder_24h_sent_at: null });
            await scanner(scanClock).tick(signal());
            expect(await reminders()).toHaveLength(2);
            expect(email.messages).toHaveLength(2);
        });
    });

    describe("doctor_suspended payload", () => {
        it("should carry no reason text in the stored payload or the delivered message", async () => {
            expect((await h.book("patient", bookingBody({ startsAt: localStart(3, "10:00") }))).status).toBe(201);
            const suspended = await h.call("patch", `/api/admin/doctors/${DOCTOR}/suspend`, "admin", { reason: REASON }, { "Idempotency-Key": randomUUID() });
            expect(suspended.status).toBe(200);
            const rows = (await outboxRows()).filter((row) => row.kind === "doctor_suspended");
            expect(rows).toHaveLength(1);
            expect(JSON.stringify(rows[0]?.payload)).not.toContain(REASON);
            expect(JSON.stringify(rows[0])).not.toContain(REASON);
        });
    });

    describe("purge batches", () => {
        it("should delete in batches of the requested size, only sent rows older than the cutoff", async () => {
            const consultationId = await h.seedConsultation();
            const old = new Date(Date.now() - 40 * DAY);
            const base = { kind: "booking_confirmed", consultation_id: consultationId, recipient_user_id: PATIENT, payload: "{}", next_attempt_at: old };
            await ownerDb("notification_outbox").insert([
                ...Array.from({ length: 5 }, () => ({ ...base, status: "sent", sent_at: old })),
                { ...base, status: "sent", sent_at: new Date(Date.now() - 29 * DAY) },
                { ...base, status: "pending" }, { ...base, status: "dead" }, { ...base, status: "skipped" },
            ]);
            const cutoff = new Date(Date.now() - 30 * DAY);
            expect(await outboxRepo.deleteSentOlderThan(cutoff, 2, db)).toBe(2);
            expect(await outboxRepo.deleteSentOlderThan(cutoff, 2, db)).toBe(2);
            expect(await outboxRepo.deleteSentOlderThan(cutoff, 2, db)).toBe(1);
            expect(await outboxRepo.deleteSentOlderThan(cutoff, 2, db)).toBe(0);
            expect((await outboxRows()).map((row) => row.status)).toEqual(["sent", "pending", "dead", "skipped"]);
        });
    });

    describe("query plans of the real statements", () => {
        it("should serve the repository's own claim, lag, purge and reminder statements from their indexes", async () => {
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

            const captured: Array<{ sql: string; bindings: unknown[] }> = [];
            const listener = (query: { sql: string; bindings?: unknown[] }): void => { captured.push({ sql: query.sql, bindings: query.bindings ?? [] }); };
            db.on("query", listener);
            try {
                const now = new Date();
                // Plan the claim without leasing rows: capture it, then roll the effect back by resetting afterwards is unnecessary (EXPLAIN only).
                await outboxRepo.claimDue(now, 20, 300, db);
                await outboxRepo.oldestDueAgeSeconds(now, db);
                await outboxRepo.oldestPendingAgeSeconds(now, db);
                await outboxRepo.deleteSentOlderThan(new Date(now.getTime() - 30 * DAY), 5000, db);
                await scanner(new FakeClock(now.getTime())).tick(signal());
            } finally { db.removeListener("query", listener); }

            const explain = async (match: RegExp): Promise<string> => {
                const found = captured.find((entry) => match.test(entry.sql));
                if (found === undefined) throw new Error(`statement not captured: ${match}`);
                const sql = found.sql.replace(/\$\d+/g, "?");
                const result = await ownerDb.raw<{ rows: Array<{ "QUERY PLAN": string }> }>(`EXPLAIN ${sql}`, found.bindings as never);
                return result.rows.map((row) => row["QUERY PLAN"]).join("\n");
            };
            const claim = await explain(/WITH due AS/);
            expect(claim).toContain("idx_notification_outbox_pending_next_attempt_at_id");
            expect(claim).not.toMatch(/Seq Scan on notification_outbox/);
            const lag = await explain(/min\("next_attempt_at"\)/i);
            expect(lag).toContain("idx_notification_outbox_pending_next_attempt_at_id");
            expect(lag).not.toMatch(/Seq Scan/);
            const pendingAge = await explain(/min\("created_at"\)/i);
            expect(pendingAge).toContain("idx_notification_outbox_pending_created_at");
            expect(pendingAge).not.toMatch(/Seq Scan/);
            const purge = await explain(/DELETE FROM notification_outbox/);
            expect(purge).toContain("idx_notification_outbox_sent_at");
            const reminder = await explain(/from "consultations" as "c"/i);
            expect(reminder).toContain("idx_consultations_booked_starts_at");
        });
    });

    describe("log hygiene across every outcome (N-R14)", () => {
        it("should log none of the address, name, subject, body, token, complaint or reason through sent, retried, dead, skipped and delayed rows", async () => {
            const address = "SYNTHETIC-ADDRESS-5503@example.test";
            const name = "SYNTHETIC-NAME-5503";
            h.identityServer.contacts.set(PATIENT, { id: PATIENT, email: address, fullName: name, locale: "en", status: "active" });
            h.identityServer.contacts.set(DOCTOR, { id: DOCTOR, email: "SYNTHETIC-ADDRESS-5504@example.test", fullName: "SYNTHETIC-NAME-5504", locale: "en", status: "suspended" });
            const thrower: EmailPort = { send: (message: EmailMessage) => Promise.reject(new Error(`provider failure for ${message.to} ${message.text}`)) };
            jest.replaceProperty(logger as unknown as { level: string }, "level", "debug");
            const capture = captureLogs();
            try {
                const booked = await h.book("patient", bookingBody({ startsAt: localStart(3, "10:00") }));
                expect(booked.status).toBe(201);
                const live = delivery({ log: logger, email: thrower });
                await live.tick(signal());           // patient: retried (thrown), doctor: skipped (suspended)
                await ownerDb("notification_outbox").where({ status: "pending" }).update({ attempts: env.OUTBOX_MAX_ATTEMPTS - 1, next_attempt_at: new Date() });
                clock.advance(DAY);
                await live.tick(signal());           // dead
                await ownerDb("notification_outbox").where({ status: "dead" }).update({ status: "pending", next_attempt_at: new Date(), attempts: 0 });
                await delivery({ log: logger, email: new LogEmailAdapter(logger) }).tick(signal());    // sent through the log adapter
                h.identityServer.options.contactsFailures = 1;
                await ownerDb("notification_outbox").update({ status: "pending", sent_at: null, last_error_code: null, attempts: 0, next_attempt_at: new Date() });
                await delivery({ log: logger, email: new LogEmailAdapter(logger) }).tick(signal());    // delayed
                const rows = await outboxRows();
                expect(rows.map((row) => row.last_error_code ?? "").join("")).not.toMatch(/@|provider failure|SYNTHETIC/);
                expect(capture.text()).toContain("notification_dead");
                expectNoSensitiveStrings(capture, [address, name, "SYNTHETIC-ADDRESS", "SYNTHETIC-NAME", "provider failure", "Bearer", "fake-contact-token", "fake-token", COMPLAINT, REASON, "Your consultation", "Hello"]);
            } finally {
                capture.restore();
                jest.restoreAllMocks();
            }
        });
    });
});
