import type { Knex } from "knex";
import { OutboxErrorCode, OutboxKind, OutboxStatus } from "../../../../src/app/notifications/enums";
import * as repo from "../../../../src/app/notifications/repository/notification-outbox.repo";
import { OutboxDeliveryService } from "../../../../src/app/notifications/service/outbox-delivery.service";
import type { DeliveryContext, OutboxClaimedRow, OutboxFinish } from "../../../../src/app/notifications/types";
import type { EmailMessage, EmailSendResult } from "../../../../src/lib/email/types";
import { FakeClock } from "../../../helpers/fake-clock";
import { fakeLogger } from "../../../helpers/fake-logger";

const NOW = Date.parse("2030-06-01T10:00:00Z");
const START = Date.parse("2030-06-01T20:00:00Z");
const PATIENT = 101;
const DOCTOR = 202;
const db = { id: "db" } as unknown as Knex;
const SYNTHETIC_ADDRESS = "synthetic.recipient@example.test";
const SYNTHETIC_NAME = "Synthetic Recipient";

const context = (changes: Partial<DeliveryContext> = {}): DeliveryContext => ({
    status: "booked", startsAt: new Date(START), endsAt: new Date(START + 1_800_000), patientUserId: PATIENT, doctorUserId: DOCTOR,
    patientTimezone: "Africa/Cairo", doctorTimezone: "Europe/London", deleted: false, ...changes,
});
const row = (changes: Partial<OutboxClaimedRow> = {}): OutboxClaimedRow => ({
    id: 1, kind: OutboxKind.BookingConfirmed, consultation_id: 10, recipient_user_id: PATIENT,
    payload: { startsAt: new Date(START).toISOString(), endsAt: new Date(START + 1_800_000).toISOString(), recipientRole: "patient" },
    attempts: 1, request_id: null, ...changes,
});
const active = { email: SYNTHETIC_ADDRESS, fullName: SYNTHETIC_NAME, locale: "en", status: "active" as const };

function setup(options: { maxAttempts?: number; send?: (message: EmailMessage, signal: AbortSignal) => Promise<EmailSendResult> } = {}) {
    const clock = new FakeClock(NOW);
    const log = fakeLogger();
    const getContacts = jest.fn();
    const send = jest.fn(options.send ?? (() => Promise.resolve({ outcome: "sent" } as EmailSendResult)));
    const findDeliveryContexts = jest.fn();
    const finishes: OutboxFinish[] = [];
    const lost = new Set<number>();
    const claim = jest.spyOn(repo, "claimDue");
    jest.spyOn(repo, "oldestDueAgeSeconds").mockResolvedValue(0);
    jest.spyOn(repo, "finishRows").mockImplementation((batch) => {
        finishes.push(...batch);
        return Promise.resolve(batch.filter((finish) => !lost.has(finish.id)).map((finish) => finish.id));
    });
    const service = new OutboxDeliveryService(db, { getContacts } as never, { send }, { findDeliveryContexts }, { OUTBOX_BATCH_SIZE: 20, OUTBOX_MAX_ATTEMPTS: options.maxAttempts ?? 8 }, log.logger, clock);
    const run = async (rows: OutboxClaimedRow[]): Promise<{ claimed: number; leaseLost: number }> => {
        claim.mockResolvedValueOnce(rows);
        return service.deliverRound(new AbortController().signal);
    };
    return { service, clock, log, getContacts, send, findDeliveryContexts, finishes, lost, claim, run };
}

function contactsFor(ids: number[], contact = active): { contacts: Map<number, typeof active>; unavailable: Set<number> } {
    return { contacts: new Map(ids.map((id) => [id, contact])), unavailable: new Set() };
}

afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers(); });

describe("OutboxDeliveryService", () => {
    it("should send and mark the row sent when the contact is active (N-R14 outcome fields)", async () => {
        const t = setup();
        t.findDeliveryContexts.mockResolvedValue(new Map([[10, context()]]));
        t.getContacts.mockResolvedValue(contactsFor([PATIENT]));
        await expect(t.run([row()])).resolves.toEqual({ claimed: 1, leaseLost: 0 });
        expect(t.send).toHaveBeenCalledTimes(1);
        const message = t.send.mock.calls[0]?.[0] as EmailMessage;
        expect(message.to).toBe(SYNTHETIC_ADDRESS);
        expect(message.subject).toBe("Your consultation is booked");
        expect(message.text).toContain("Hello Synthetic Recipient,");
        expect(message.text).toContain("Saturday 1 June 2030, 23:00 (Africa/Cairo)");
        expect(message.meta).toEqual({ outboxId: 1, kind: "booking_confirmed", recipientUserId: PATIENT });
        expect(t.finishes).toEqual([{ id: 1, expectedAttempts: 1, status: OutboxStatus.Sent, attemptsDelta: 0, nextAttemptAt: null, lastErrorCode: null, sentAt: new Date(NOW) }]);
    });

    it("should render the doctor's copy in the doctor's profile timezone and derive the role from the database (N-R15)", async () => {
        const t = setup();
        t.findDeliveryContexts.mockResolvedValue(new Map([[10, context()]]));
        t.getContacts.mockResolvedValue(contactsFor([DOCTOR]));
        // The payload claims the patient role; the database says the recipient is the doctor.
        await t.run([row({ recipient_user_id: DOCTOR })]);
        const message = t.send.mock.calls[0]?.[0] as EmailMessage;
        expect(message.subject).toBe("New consultation booked");
        expect(message.text).toContain("Saturday 1 June 2030, 21:00 (Europe/London)");
    });

    it("should fall back to UTC when the doctor profile is gone", async () => {
        const t = setup();
        t.findDeliveryContexts.mockResolvedValue(new Map([[10, context({ doctorTimezone: null })]]));
        t.getContacts.mockResolvedValue(contactsFor([DOCTOR]));
        await t.run([row({ recipient_user_id: DOCTOR })]);
        expect((t.send.mock.calls[0]?.[0] as EmailMessage).text).toContain("(UTC)");
    });

    it.each([
        [1, 30_000], [2, 60_000], [3, 120_000], [4, 240_000], [5, 480_000], [6, 960_000], [7, 1_800_000],
    ])("should retry after send failure %i with a delay of %i ms (N-R6)", async (attempt, delay) => {
        const t = setup({ send: () => Promise.resolve({ outcome: "transient", errorCode: "whatever" }) });
        t.findDeliveryContexts.mockResolvedValue(new Map([[10, context()]]));
        t.getContacts.mockResolvedValue(contactsFor([PATIENT]));
        await t.run([row({ attempts: attempt })]);
        expect(t.finishes).toEqual([{
            id: 1, expectedAttempts: attempt, status: OutboxStatus.Pending, attemptsDelta: 0, nextAttemptAt: new Date(NOW + delay),
            lastErrorCode: OutboxErrorCode.EmailError, sentAt: null,
        }]);
    });

    it("should mark the row dead at the maximum attempt (N-R6)", async () => {
        const t = setup({ send: () => Promise.resolve({ outcome: "transient", errorCode: "x" }) });
        t.findDeliveryContexts.mockResolvedValue(new Map([[10, context()]]));
        t.getContacts.mockResolvedValue(contactsFor([PATIENT]));
        await t.run([row({ attempts: 8 })]);
        expect(t.finishes[0]).toMatchObject({ status: OutboxStatus.Dead, lastErrorCode: OutboxErrorCode.EmailError, nextAttemptAt: null });
        expect(t.log.error).toHaveBeenCalledWith("notification_dead", expect.objectContaining({ outboxId: 1, kind: "booking_confirmed" }));
        expect(t.log.metric).toHaveBeenCalledWith("notification_dead", 1, { kind: "booking_confirmed" });
    });

    it("should mark the row dead at once when the provider answer is permanent (N-R9)", async () => {
        const t = setup({ send: () => Promise.resolve({ outcome: "permanent", errorCode: "provider text" }) });
        t.findDeliveryContexts.mockResolvedValue(new Map([[10, context()]]));
        t.getContacts.mockResolvedValue(contactsFor([PATIENT]));
        await t.run([row({ attempts: 1 })]);
        expect(t.finishes[0]).toMatchObject({ status: OutboxStatus.Dead, lastErrorCode: OutboxErrorCode.EmailRejected });
    });

    it("should time a send out after 5 s and treat it as transient (N-R20)", async () => {
        jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"] });
        const t = setup({ send: () => new Promise<EmailSendResult>(() => undefined) });
        t.findDeliveryContexts.mockResolvedValue(new Map([[10, context()]]));
        t.getContacts.mockResolvedValue(contactsFor([PATIENT]));
        const pending = t.run([row()]);
        await jest.advanceTimersByTimeAsync(5_000);
        await pending;
        expect(t.finishes[0]).toMatchObject({ status: OutboxStatus.Pending, lastErrorCode: OutboxErrorCode.EmailTimeout });
    });

    it("should treat a thrown send as email_error without storing or logging the message", async () => {
        const t = setup({ send: () => Promise.reject(new Error(`boom ${SYNTHETIC_ADDRESS}`)) });
        t.findDeliveryContexts.mockResolvedValue(new Map([[10, context()]]));
        t.getContacts.mockResolvedValue(contactsFor([PATIENT]));
        await t.run([row()]);
        expect(t.finishes[0]).toMatchObject({ status: OutboxStatus.Pending, lastErrorCode: OutboxErrorCode.EmailError });
        expect(JSON.stringify(t.finishes)).not.toContain("boom");
        expect(t.log.text()).not.toContain("boom");
    });

    it("should skip an unknown recipient and a non-active one without sending (N-R8)", async () => {
        const t = setup();
        t.findDeliveryContexts.mockResolvedValue(new Map([[10, context()]]));
        t.getContacts.mockResolvedValue({ contacts: new Map([[DOCTOR, { ...active, status: "suspended" as const }]]), unavailable: new Set() });
        await t.run([row({ id: 1, recipient_user_id: PATIENT }), row({ id: 2, recipient_user_id: DOCTOR })]);
        expect(t.send).not.toHaveBeenCalled();
        expect(t.finishes).toEqual([
            expect.objectContaining({ id: 1, status: OutboxStatus.Skipped, lastErrorCode: OutboxErrorCode.RecipientUnknown }),
            expect.objectContaining({ id: 2, status: OutboxStatus.Skipped, lastErrorCode: OutboxErrorCode.RecipientInactive }),
        ]);
        expect(t.log.metric).toHaveBeenCalledWith("notification_skipped", 1, { reason: "recipient_unknown" });
    });

    it("should delay without consuming an attempt when contacts are unavailable, growing with consecutive failures and resetting on success (N-R7)", async () => {
        const t = setup();
        t.findDeliveryContexts.mockResolvedValue(new Map([[10, context()]]));
        t.getContacts.mockResolvedValue({ contacts: new Map(), unavailable: new Set([PATIENT]) });
        await t.run([row({ attempts: 3 })]);
        await t.run([row({ attempts: 4 })]);
        await t.run([row({ attempts: 5 })]);
        expect(t.send).not.toHaveBeenCalled();
        expect(t.finishes.map((finish) => [finish.attemptsDelta, finish.status, finish.lastErrorCode, (finish.nextAttemptAt?.getTime() ?? 0) - NOW])).toEqual([
            [-1, "pending", "contacts_unavailable", 30_000], [-1, "pending", "contacts_unavailable", 60_000], [-1, "pending", "contacts_unavailable", 120_000],
        ]);
        expect(t.finishes.map((finish) => finish.expectedAttempts)).toEqual([3, 4, 5]);
        t.getContacts.mockResolvedValue(contactsFor([PATIENT]));
        await t.run([row({ attempts: 1 })]);
        t.getContacts.mockResolvedValue({ contacts: new Map(), unavailable: new Set([PATIENT]) });
        await t.run([row({ attempts: 1 })]);
        expect((t.finishes.at(-1)?.nextAttemptAt?.getTime() ?? 0) - NOW).toBe(30_000);
        expect(t.log.warn).not.toHaveBeenCalledWith("notification_failed", expect.anything());
    });

    it("should still send rows whose recipient was found when others in the batch are unavailable", async () => {
        const t = setup();
        t.findDeliveryContexts.mockResolvedValue(new Map([[10, context()]]));
        t.getContacts.mockResolvedValue({ contacts: new Map([[DOCTOR, active]]), unavailable: new Set([PATIENT]) });
        await t.run([row({ id: 1, recipient_user_id: PATIENT }), row({ id: 2, recipient_user_id: DOCTOR })]);
        expect(t.send).toHaveBeenCalledTimes(1);
        expect(t.finishes.map((finish) => [finish.id, finish.status])).toEqual([[1, "pending"], [2, "sent"]]);
    });

    it("should look all recipients up with one batched call", async () => {
        const t = setup();
        t.findDeliveryContexts.mockResolvedValue(new Map([[10, context()]]));
        t.getContacts.mockResolvedValue(contactsFor([PATIENT, DOCTOR]));
        await t.run([row({ id: 1 }), row({ id: 2 }), row({ id: 3, recipient_user_id: DOCTOR })]);
        expect(t.getContacts).toHaveBeenCalledTimes(1);
        expect(t.getContacts.mock.calls[0]?.[0]).toEqual([PATIENT, DOCTOR]);
        expect(t.findDeliveryContexts).toHaveBeenCalledTimes(1);
    });

    describe("claim-time re-check (N-R10)", () => {
        const reminder = (changes: Partial<OutboxClaimedRow> = {}): OutboxClaimedRow => row({ kind: OutboxKind.Reminder1h, ...changes });
        it.each([
            ["cancelled", context({ status: "cancelled" }), OutboxErrorCode.ConsultationChanged],
            ["deleted", context({ deleted: true }), OutboxErrorCode.ConsultationChanged],
            ["rescheduled", context({ startsAt: new Date(START + 3_600_000) }), OutboxErrorCode.ConsultationChanged],
            ["started", context({ startsAt: new Date(START), status: "booked" }), OutboxErrorCode.ReminderExpired],
        ])("should drop a reminder for a %s consultation", async (name, ctx, code) => {
            const t = setup();
            if (name === "started") t.clock.set(START);
            t.findDeliveryContexts.mockResolvedValue(new Map([[10, ctx]]));
            await t.run([reminder()]);
            expect(t.send).not.toHaveBeenCalled();
            expect(t.getContacts).not.toHaveBeenCalled();
            expect(t.finishes).toEqual([expect.objectContaining({ status: OutboxStatus.Skipped, lastErrorCode: code })]);
        });

        it("should skip a row whose consultation is missing", async () => {
            const t = setup();
            t.findDeliveryContexts.mockResolvedValue(new Map());
            await t.run([row()]);
            expect(t.finishes[0]).toMatchObject({ status: OutboxStatus.Skipped, lastErrorCode: OutboxErrorCode.ConsultationMissing });
        });

        it("should skip a row whose recipient is neither participant", async () => {
            const t = setup();
            t.findDeliveryContexts.mockResolvedValue(new Map([[10, context()]]));
            await t.run([row({ recipient_user_id: 999 })]);
            expect(t.finishes[0]).toMatchObject({ status: OutboxStatus.Skipped, lastErrorCode: OutboxErrorCode.ConsultationChanged });
        });

        it("should skip with template_missing when no template exists for the recipient's role", async () => {
            const t = setup();
            t.findDeliveryContexts.mockResolvedValue(new Map([[10, context()]]));
            await t.run([row({ kind: OutboxKind.DoctorSuspended, recipient_user_id: DOCTOR })]);
            expect(t.finishes[0]).toMatchObject({ status: OutboxStatus.Skipped, lastErrorCode: OutboxErrorCode.TemplateMissing });
            expect(t.getContacts).not.toHaveBeenCalled();
        });

        it.each([OutboxKind.BookingConfirmed, OutboxKind.Cancelled, OutboxKind.Rescheduled, OutboxKind.ScheduleBlocked, OutboxKind.DoctorSuspended])(
            "should still send an event notification (%s) for a consultation that has since been cancelled", async (kind) => {
                const t = setup();
                t.findDeliveryContexts.mockResolvedValue(new Map([[10, context({ status: "cancelled", deleted: true })]]));
                t.getContacts.mockResolvedValue(contactsFor([PATIENT]));
                await t.run([row({ kind })]);
                expect(t.send).toHaveBeenCalledTimes(1);
            });

        it("should send a reminder whose payload matches the consultation", async () => {
            const t = setup();
            t.findDeliveryContexts.mockResolvedValue(new Map([[10, context()]]));
            t.getContacts.mockResolvedValue(contactsFor([PATIENT]));
            await t.run([reminder()]);
            expect(t.send).toHaveBeenCalledTimes(1);
        });
    });

    it("should dead-letter a row claimed beyond the maximum without sending (N-R19)", async () => {
        const t = setup({ maxAttempts: 8 });
        t.findDeliveryContexts.mockResolvedValue(new Map([[10, context()]]));
        t.getContacts.mockResolvedValue(contactsFor([PATIENT]));
        await t.run([row({ id: 5, attempts: 9 })]);
        expect(t.send).not.toHaveBeenCalled();
        expect(t.finishes).toEqual([expect.objectContaining({ id: 5, expectedAttempts: 9, status: OutboxStatus.Dead, lastErrorCode: OutboxErrorCode.LeaseExpired })]);
    });

    it("should report a lost lease and not count it as written when the guarded update changes nothing (N-R3)", async () => {
        const t = setup();
        t.findDeliveryContexts.mockResolvedValue(new Map([[10, context()]]));
        t.getContacts.mockResolvedValue(contactsFor([PATIENT]));
        t.lost.add(1);
        await expect(t.run([row()])).resolves.toEqual({ claimed: 1, leaseLost: 1 });
        expect(t.log.warn).toHaveBeenCalledWith("notification_lease_lost", { outboxId: 1 });
        expect(t.log.info).not.toHaveBeenCalledWith("notification_sent", expect.anything());
    });

    it("should log ids, kind and counts only, never the address, name, subject or body (N-R14)", async () => {
        const t = setup({ send: () => Promise.resolve({ outcome: "transient", errorCode: "x" }) });
        t.findDeliveryContexts.mockResolvedValue(new Map([[10, context()]]));
        t.getContacts.mockResolvedValue(contactsFor([PATIENT]));
        await t.run([row()]);
        t.send.mockResolvedValueOnce({ outcome: "sent" });
        await t.run([row({ id: 2 })]);
        for (const needle of [SYNTHETIC_ADDRESS, SYNTHETIC_NAME, "Your consultation is booked", "Hello"]) {
            expect(t.log.text()).not.toContain(needle);
        }
    });

    describe("tick", () => {
        it("should emit the lag gauge then keep claiming until a short batch", async () => {
            const t = setup();
            const lag = jest.spyOn(repo, "oldestDueAgeSeconds").mockResolvedValue(42);
            const full = Array.from({ length: 20 }, (_, index) => row({ id: index + 1, recipient_user_id: 7 }));
            t.claim.mockResolvedValueOnce(full).mockResolvedValueOnce([row({ id: 99 })]);
            t.findDeliveryContexts.mockResolvedValue(new Map());
            await expect(t.service.tick(new AbortController().signal)).resolves.toBe("done");
            expect(lag).toHaveBeenCalledTimes(1);
            expect(t.log.metric).toHaveBeenCalledWith("notification_outbox_lag_seconds", 42, {});
            expect(t.claim).toHaveBeenCalledTimes(2);
            expect(t.claim.mock.calls[0]?.slice(1, 3)).toEqual([20, 300]);
        });

        it("should stop at the round cap", async () => {
            const t = setup();
            const full = Array.from({ length: 20 }, (_, index) => row({ id: index + 1 }));
            t.claim.mockResolvedValue(full);
            t.findDeliveryContexts.mockResolvedValue(new Map());
            await t.service.tick(new AbortController().signal);
            expect(t.claim).toHaveBeenCalledTimes(10);
        });

        it("should not claim when already aborted and should report incomplete when a lease was lost", async () => {
            const t = setup();
            const aborted = new AbortController();
            aborted.abort();
            await t.service.tick(aborted.signal);
            expect(t.claim).not.toHaveBeenCalled();
            t.findDeliveryContexts.mockResolvedValue(new Map());
            t.lost.add(1);
            t.claim.mockResolvedValueOnce([row()]);
            await expect(t.service.tick(new AbortController().signal)).resolves.toBe("incomplete");
        });
    });
});
