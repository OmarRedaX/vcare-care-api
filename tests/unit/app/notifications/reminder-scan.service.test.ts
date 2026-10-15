import type { Knex } from "knex";
import { OUTBOX_PAYLOAD_KEYS } from "../../../../src/app/notifications/constants";
import { OutboxKind } from "../../../../src/app/notifications/enums";
import * as repo from "../../../../src/app/notifications/repository/notification-outbox.repo";
import { ReminderScanService } from "../../../../src/app/notifications/service/reminder-scan.service";
import type { OutboxMessage, QueuedReminder, ReminderCandidate, ReminderKind } from "../../../../src/app/notifications/types";
import { FakeClock } from "../../../helpers/fake-clock";
import { fakeLogger } from "../../../helpers/fake-logger";

const NOW = Date.parse("2030-06-01T10:00:00Z");
const HOUR = 3_600_000;
const trx = { id: "trx" } as unknown as Knex.Transaction;

function candidate(id: number, startsInMs: number, bookedBeforeStartMs: number): ReminderCandidate {
    const startsAt = new Date(NOW + startsInMs);
    return { id, patientUserId: 100 + id, doctorUserId: 900, startsAt, endsAt: new Date(startsAt.getTime() + 1_800_000), createdAt: new Date(startsAt.getTime() - bookedBeforeStartMs) };
}

function setup(due: { h24?: ReminderCandidate[]; h1?: ReminderCandidate[]; queued?: QueuedReminder[] }) {
    const findQueued = jest.spyOn(repo, "findQueuedReminders").mockResolvedValue(due.queued ?? []);
    const enqueued: OutboxMessage[] = [];
    const stamps: Array<[number[], number[]]> = [];
    const consultations = {
        findDeliveryContexts: jest.fn(),
        listReminderCandidates: jest.fn((kind: ReminderKind) => Promise.resolve(kind === OutboxKind.Reminder24h ? (due.h24 ?? []) : (due.h1 ?? []))),
        stampReminders: jest.fn((ids24: number[], ids1: number[]) => { stamps.push([[...ids24], [...ids1]]); return Promise.resolve(); }),
    };
    const notifications = { enqueue: jest.fn((_trx: Knex.Transaction, messages: OutboxMessage[]) => { enqueued.push(...messages); return Promise.resolve(); }) };
    const transaction = jest.fn((handler: (t: Knex.Transaction) => Promise<unknown>) => handler(trx));
    const log = fakeLogger();
    const service = new ReminderScanService({ transaction } as unknown as Knex, consultations, notifications, log.logger, new FakeClock(NOW));
    return { service, consultations, notifications, enqueued, stamps, transaction, log, findQueued };
}

afterEach(() => { jest.restoreAllMocks(); });

describe("ReminderScanService", () => {
    it("should skip a reminder that is already pending or sent for the same kind, consultation, recipient and start, but still stamp (N-R11, reschedule A to B to A)", async () => {
        const start = new Date(NOW + 20 * HOUR).toISOString();
        const t = setup({
            h24: [candidate(1, 20 * HOUR, 72 * HOUR)],
            queued: [{ kind: OutboxKind.Reminder24h, consultationId: 1, recipientUserId: 101, startsAt: start }],
        });
        await t.service.scanOnce();
        // The patient already has this reminder for this start; the doctor does not.
        expect(t.enqueued.map((message) => message.recipientUserId)).toEqual([900]);
        expect(t.stamps).toEqual([[[1], []]]);
        expect(t.findQueued).toHaveBeenCalledTimes(1);
    });

    it("should still enqueue when the queued reminder is for a different start", async () => {
        const t = setup({
            h24: [candidate(1, 20 * HOUR, 72 * HOUR)],
            queued: [{ kind: OutboxKind.Reminder24h, consultationId: 1, recipientUserId: 101, startsAt: new Date(NOW + 5 * HOUR).toISOString() }],
        });
        await t.service.scanOnce();
        expect(t.enqueued).toHaveLength(2);
    });

    it("should enqueue a 24 h reminder for both the patient and the doctor and stamp it", async () => {
        const t = setup({ h24: [candidate(1, 20 * HOUR, 72 * HOUR)] });
        await t.service.scanOnce();
        expect(t.enqueued.map((message) => [message.kind, message.recipientUserId, message.payload.recipientRole])).toEqual([
            [OutboxKind.Reminder24h, 101, "patient"], [OutboxKind.Reminder24h, 900, "doctor"],
        ]);
        expect(t.stamps).toEqual([[[1], []]]);
    });

    it("should enqueue payloads within the allowlist and with ISO instants", async () => {
        const t = setup({ h1: [candidate(1, 30 * 60_000, 72 * HOUR)] });
        await t.service.scanOnce();
        for (const message of t.enqueued) {
            expect(Object.keys(message.payload).every((key) => OUTBOX_PAYLOAD_KEYS.includes(key))).toBe(true);
            expect(message.payload.startsAt).toBe(new Date(NOW + 30 * 60_000).toISOString());
        }
    });

    it("should stamp without a message when booked inside the 24 h window (N-R12)", async () => {
        const t = setup({ h24: [candidate(1, 20 * HOUR, 20 * HOUR)] });
        await t.service.scanOnce();
        expect(t.enqueued).toEqual([]);
        expect(t.stamps).toEqual([[[1], []]]);
    });

    it("should stamp without a message when booked inside the 1 h window", async () => {
        const t = setup({ h1: [candidate(1, 30 * 60_000, 40 * 60_000)] });
        await t.service.scanOnce();
        expect(t.enqueued).toEqual([]);
        expect(t.stamps).toEqual([[[], [1]]]);
    });

    it("should treat created exactly at the window start as booked inside it (boundary)", async () => {
        const t = setup({ h24: [candidate(1, 20 * HOUR, 24 * HOUR)], h1: [candidate(2, 30 * 60_000, HOUR)] });
        await t.service.scanOnce();
        expect(t.enqueued).toEqual([]);
    });

    it("should send only the 1 h reminder when the start is within an hour and stamp the 24 h one without a message (N-D6)", async () => {
        const c = candidate(1, 50 * 60_000, 72 * HOUR);
        const t = setup({ h24: [c], h1: [c] });
        await t.service.scanOnce();
        expect(new Set(t.enqueued.map((message) => message.kind))).toEqual(new Set([OutboxKind.Reminder1h]));
        expect(t.enqueued).toHaveLength(2);
        expect(t.stamps).toEqual([[[1], [1]]]);
    });

    it("should still send the 24 h reminder when the start is just over an hour away", async () => {
        const t = setup({ h24: [candidate(1, HOUR + 1, 72 * HOUR)] });
        await t.service.scanOnce();
        expect(t.enqueued.map((message) => message.kind)).toEqual([OutboxKind.Reminder24h, OutboxKind.Reminder24h]);
    });

    it("should treat exactly one hour away as the 1 h window only", async () => {
        const c = candidate(1, HOUR, 72 * HOUR);
        const t = setup({ h24: [c], h1: [c] });
        await t.service.scanOnce();
        expect(new Set(t.enqueued.map((message) => message.kind))).toEqual(new Set([OutboxKind.Reminder1h]));
    });

    it("should enqueue reminders for a consultation flagged needs_admin_followup (N-R22): the scan has no flag predicate", async () => {
        const t = setup({ h24: [candidate(1, 20 * HOUR, 72 * HOUR)] });
        await t.service.scanOnce();
        expect(t.enqueued).toHaveLength(2);
    });

    it("should run one transaction per iteration with one enqueue and one stamp call", async () => {
        const t = setup({ h24: [candidate(1, 20 * HOUR, 72 * HOUR), candidate(2, 21 * HOUR, 72 * HOUR)] });
        await t.service.scanOnce();
        expect(t.transaction).toHaveBeenCalledTimes(1);
        expect(t.consultations.listReminderCandidates).toHaveBeenCalledTimes(2);
        expect(t.notifications.enqueue).toHaveBeenCalledTimes(1);
        expect(t.consultations.stampReminders).toHaveBeenCalledTimes(1);
    });

    it("should continue only while a page is full and cap the iterations", async () => {
        const full = Array.from({ length: 200 }, (_, index) => candidate(index + 1, 20 * HOUR, 72 * HOUR));
        const t = setup({ h24: full });
        await t.service.tick(new AbortController().signal);
        expect(t.transaction).toHaveBeenCalledTimes(5);
        expect(t.log.metric).toHaveBeenCalledWith("notification_reminders_enqueued", 200, { kind: "reminder_24h" });
        const short = setup({ h24: full.slice(0, 3) });
        await short.service.tick(new AbortController().signal);
        expect(short.transaction).toHaveBeenCalledTimes(1);
    });

    it("should not scan when already aborted", async () => {
        const t = setup({});
        const aborted = new AbortController();
        aborted.abort();
        await t.service.tick(aborted.signal);
        expect(t.transaction).not.toHaveBeenCalled();
    });
});
