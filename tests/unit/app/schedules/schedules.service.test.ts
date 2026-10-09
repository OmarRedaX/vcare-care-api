import "reflect-metadata";
import type { Knex } from "knex";
import { ConsultationType } from "../../../../src/app/schedules/entity/consultation-type.entity";
import { ScheduleException } from "../../../../src/app/schedules/entity/schedule-exception.entity";
import { WorkingHour } from "../../../../src/app/schedules/entity/working-hour.entity";
import * as typesRepo from "../../../../src/app/schedules/repository/consultation-types.repo";
import * as exceptionsRepo from "../../../../src/app/schedules/repository/schedule-exceptions.repo";
import * as hoursRepo from "../../../../src/app/schedules/repository/working-hours.repo";
import { SchedulesService } from "../../../../src/app/schedules/service/schedules.service";
import type { ScheduleOwner } from "../../../../src/app/schedules/types";
import type { AuditRecorder } from "../../../../src/lib/audit/audit";
import type { Env } from "../../../../src/lib/config/types";
import { encodeCursor } from "../../../../src/lib/http/pagination/cursor";
import type { Logger } from "../../../../src/lib/logger/logger";
import type { AuthContext } from "../../../../src/lib/types/types";

const actor: AuthContext = { userId: 202, role: "doctor", status: "active", emailVerified: true };
const NOW = new Date("2027-06-10T10:30:00Z");
const owner = (changes: Partial<ScheduleOwner> = {}): ScheduleOwner => ({ profileId: 9, userId: 202, timezone: "Africa/Cairo", currency: "EGP", isSuspended: false, ...changes });
const hour = (id: number, weekday: number, startTime: string, endTime: string): WorkingHour => new WorkingHour({ id, weekday, startTime, endTime });
const exception = (changes: Partial<ScheduleException> = {}): ScheduleException => new ScheduleException({
    id: 5, date: "2027-06-20", type: "custom_hours" as never, startTime: "10:00", endTime: "12:00", reason: null, createdAt: NOW, ...changes,
});
const type = (changes: Partial<ConsultationType> = {}): ConsultationType => new ConsultationType({
    id: 3, name: "Synthetic Visit 001", durationMinutes: 30, price: 100, currency: "EGP", isActive: true, createdAt: NOW, updatedAt: NOW, ...changes,
});
const pgUnique = (constraint: string): Error => Object.assign(new Error("pg"), { code: "23505", constraint });
const dayOffInput = (changes: Record<string, unknown> = {}) => ({ type: "day_off" as never, date: "2027-06-20", endDate: null, startMinute: null, endMinute: null, reason: null, confirmConflicts: false, ...changes });
const hoursInput = (confirmConflicts = false) => ({ days: [{ weekday: 1, intervals: [{ startMinute: 540, endMinute: 720 }] }], confirmConflicts });

function setup(allowed: string[] = ["EGP"]) {
    const events: string[] = [];
    const trx = { id: "trx" } as unknown as Knex.Transaction;
    const transaction = jest.fn(async (callback: (conn: Knex.Transaction) => Promise<unknown>) => { const result = await callback(trx); events.push("commit"); return result; });
    const db = { transaction } as unknown as Knex;
    const record = jest.fn().mockResolvedValue(undefined);
    const logError = jest.fn();
    const logger = { error: logError, warn: jest.fn(), info: jest.fn(), debug: jest.fn() } as unknown as Logger;
    const owners = { find: jest.fn().mockResolvedValue(owner()), lock: jest.fn().mockResolvedValue(owner()) };
    const impact = { findAffected: jest.fn().mockResolvedValue([]), flagAffected: jest.fn().mockResolvedValue(undefined) };
    const listener = { onScheduleChanged: jest.fn().mockImplementation(() => { events.push("listener"); return Promise.resolve(); }) };
    const service = new SchedulesService(db, { record } as unknown as AuditRecorder, { ALLOWED_CURRENCIES: allowed } as unknown as Env, logger, owners, impact, listener);
    const mocks = {
        listHours: jest.spyOn(hoursRepo, "listLiveHours").mockResolvedValue([]),
        softDeleteHours: jest.spyOn(hoursRepo, "softDeleteLiveHours").mockResolvedValue(),
        insertHours: jest.spyOn(hoursRepo, "insertHours").mockImplementation((_id, rows) => Promise.resolve(rows.map((row, i) => hour(i + 1, row.weekday, row.startTime, row.endTime)))),
        listExceptions: jest.spyOn(exceptionsRepo, "listExceptionsPage").mockResolvedValue([]),
        insertExceptions: jest.spyOn(exceptionsRepo, "insertExceptions").mockImplementation((_id, rows) => Promise.resolve(rows.map((row, i) => exception({ id: i + 1, date: row.date, type: row.type, startTime: row.startTime, endTime: row.endTime })))),
        findException: jest.spyOn(exceptionsRepo, "findExceptionById").mockResolvedValue(exception()),
        softDeleteException: jest.spyOn(exceptionsRepo, "softDeleteException").mockResolvedValue(),
        listTypes: jest.spyOn(typesRepo, "listTypesPage").mockResolvedValue([]),
        countTypes: jest.spyOn(typesRepo, "countLiveTypes").mockResolvedValue(0),
        insertType: jest.spyOn(typesRepo, "insertType").mockResolvedValue(type()),
        findType: jest.spyOn(typesRepo, "findTypeById").mockResolvedValue(type()),
        updateType: jest.spyOn(typesRepo, "updateType").mockResolvedValue(type({ name: "Synthetic Renamed" })),
        hasActive: jest.spyOn(typesRepo, "hasActiveType").mockResolvedValue(true),
    };
    return { service, trx, db, transaction, record, logger, logError, owners, impact, listener, events, mocks };
}

beforeEach(() => { jest.useFakeTimers({ now: NOW }); });
afterEach(() => { jest.useRealTimers(); jest.restoreAllMocks(); });

describe("SchedulesService working hours", () => {
    it("should lock the owner, soft-delete, insert and audit schedule.hours_replaced in one transaction", async () => {
        const { service, trx, transaction, record, owners, mocks, events, listener } = setup();
        mocks.listHours.mockResolvedValue([hour(1, 2, "08:00", "09:00")]);
        const view = await service.replaceWorkingHours(actor, hoursInput());
        expect(transaction).toHaveBeenCalledTimes(1);
        expect(owners.lock).toHaveBeenCalledWith(202, trx);
        expect(mocks.softDeleteHours).toHaveBeenCalledWith(9, trx);
        expect(mocks.insertHours).toHaveBeenCalledWith(9, [{ weekday: 1, startTime: "09:00", endTime: "12:00" }], trx);
        expect(record).toHaveBeenCalledTimes(1);
        expect(record).toHaveBeenCalledWith(trx, { actor: { kind: "user", userId: 202, role: "doctor" }, action: "schedule.hours_replaced",
            entityType: "doctor_profile", entityId: 9, metadata: { dayCount: 1, intervalCount: 1, confirmed: false } });
        expect(view).toEqual({ timezone: "Africa/Cairo", days: [{ weekday: 1, intervals: [{ startTime: "09:00", endTime: "12:00" }] }] });
        expect(listener.onScheduleChanged).toHaveBeenCalledWith({ doctorProfileId: 9, doctorUserId: 202, kind: "working_hours" });
        expect(events).toEqual(["commit", "listener"]);
    });

    it("should return the current set with no write, audit, provider or listener call when the set is equal (S-R3)", async () => {
        const { service, record, impact, listener, mocks } = setup();
        mocks.listHours.mockResolvedValue([hour(1, 1, "09:00", "12:00")]);
        const view = await service.replaceWorkingHours(actor, hoursInput());
        expect(view.days).toEqual([{ weekday: 1, intervals: [{ startTime: "09:00", endTime: "12:00" }] }]);
        expect(mocks.softDeleteHours).not.toHaveBeenCalled();
        expect(mocks.insertHours).not.toHaveBeenCalled();
        expect(record).not.toHaveBeenCalled();
        expect(impact.findAffected).not.toHaveBeenCalled();
        expect(listener.onScheduleChanged).not.toHaveBeenCalled();
    });

    it("should clear all hours for days: [] and audit zero counts", async () => {
        const { service, record, trx, mocks } = setup();
        mocks.listHours.mockResolvedValue([hour(1, 1, "09:00", "12:00")]);
        const view = await service.replaceWorkingHours(actor, { days: [], confirmConflicts: false });
        expect(view.days).toEqual([]);
        expect(mocks.softDeleteHours).toHaveBeenCalledWith(9, trx);
        expect(record).toHaveBeenCalledWith(trx, expect.objectContaining({ metadata: { dayCount: 0, intervalCount: 0, confirmed: false } }));
    });

    it("should treat days: [] over an empty set as a no-op", async () => {
        const { service, record, mocks } = setup();
        await service.replaceWorkingHours(actor, { days: [], confirmConflicts: false });
        expect(mocks.softDeleteHours).not.toHaveBeenCalled();
        expect(record).not.toHaveBeenCalled();
    });

    it("should validate before any I/O when the hours overlap", async () => {
        const { service, transaction } = setup();
        const input = { days: [{ weekday: 1, intervals: [{ startMinute: 540, endMinute: 720 }, { startMinute: 600, endMinute: 800 }] }], confirmConflicts: false };
        await expect(service.replaceWorkingHours(actor, input)).rejects.toMatchObject({ code: "ValidationFailed" });
        expect(transaction).not.toHaveBeenCalled();
    });

    it("should throw NotFound without a profile and Forbidden when the locked owner is suspended (S-R17)", async () => {
        const { service, owners, mocks, record } = setup();
        owners.lock.mockResolvedValueOnce(undefined);
        await expect(service.replaceWorkingHours(actor, hoursInput())).rejects.toMatchObject({ code: "NotFound", status: 404 });
        owners.lock.mockResolvedValueOnce(owner({ isSuspended: true }));
        await expect(service.replaceWorkingHours(actor, hoursInput())).rejects.toMatchObject({ code: "Forbidden", status: 403 });
        expect(mocks.listHours).not.toHaveBeenCalled();
        expect(record).not.toHaveBeenCalled();
    });

    it("should reject (so Knex rolls back) and not notify when the audit throws (S-R18)", async () => {
        const { service, record, listener } = setup();
        record.mockRejectedValueOnce(new Error("audit down"));
        await expect(service.replaceWorkingHours(actor, hoursInput())).rejects.toThrow("audit down");
        expect(listener.onScheduleChanged).not.toHaveBeenCalled();
    });

    it("should read hours without a lock and throw NotFound without a profile", async () => {
        const { service, owners, mocks, transaction } = setup();
        mocks.listHours.mockResolvedValue([hour(2, 3, "10:00", "11:00"), hour(1, 1, "09:00", "10:00")]);
        const view = await service.getWorkingHours(actor);
        expect(view.days.map((d) => d.weekday)).toEqual([1, 3]);
        expect(owners.lock).not.toHaveBeenCalled();
        expect(transaction).not.toHaveBeenCalled();
        owners.find.mockResolvedValueOnce(undefined);
        await expect(service.getWorkingHours(actor)).rejects.toMatchObject({ code: "NotFound" });
    });
});

describe("SchedulesService conflicts (stub provider)", () => {
    const operations: Array<[string, (s: SchedulesService, confirm: boolean) => Promise<unknown>, string, (m: ReturnType<typeof setup>["mocks"]) => void]> = [
        ["replaceWorkingHours", (s, c) => s.replaceWorkingHours(actor, hoursInput(c)), "schedule.hours_replaced", () => undefined],
        ["createExceptions", (s, c) => s.createExceptions(actor, dayOffInput({ confirmConflicts: c })), "schedule.exception_created", () => undefined],
        ["deleteException of a custom_hours", (s, c) => s.deleteException(actor, 5, c), "schedule.exception_deleted", () => undefined],
    ];

    it.each(operations)("should throw ScheduleConflictsUnconfirmed with all ids ascending and write no audit in %s", async (_name, run, _action) => {
        const { service, impact, record, listener } = setup();
        impact.findAffected.mockResolvedValue([9, 3, 5]);
        await expect(run(service, false)).rejects.toMatchObject({
            code: "ScheduleConflictsUnconfirmed", status: 409, extra: { conflicts: { consultationIds: [3, 5, 9], count: 3 } },
        });
        expect(impact.flagAffected).not.toHaveBeenCalled();
        expect(record).not.toHaveBeenCalled();
        expect(listener.onScheduleChanged).not.toHaveBeenCalled();
    });

    it.each(operations)("should flag, audit conflicts_confirmed and the operation's own row, then notify in %s", async (_name, run, action) => {
        const { service, impact, record, trx, listener } = setup();
        impact.findAffected.mockResolvedValue([9, 3, 5]);
        await run(service, true);
        expect(impact.flagAffected).toHaveBeenCalledWith(expect.anything(), [3, 5, 9], trx);
        const actions = record.mock.calls.map((call) => (call[1] as { action: string }).action);
        expect(actions).toEqual(["schedule.conflicts_confirmed", action]);
        expect(record.mock.calls[0]?.[1]).toMatchObject({ entityType: "doctor_profile", entityId: 9 });
        expect(listener.onScheduleChanged).toHaveBeenCalledTimes(1);
    });

    it("should write the first 20 ids joined and idsTruncated for 25 ids, and the change kind", async () => {
        const { service, impact, record } = setup();
        const ids = Array.from({ length: 25 }, (_unused, i) => i + 1);
        impact.findAffected.mockResolvedValue([...ids].reverse());
        await service.replaceWorkingHours(actor, hoursInput(true));
        expect(record.mock.calls[0]?.[1]).toMatchObject({ metadata: { change: "working_hours", count: 25, consultationIds: ids.slice(0, 20).join(","), idsTruncated: true } });
        expect(record.mock.calls[1]?.[1]).toMatchObject({ action: "schedule.hours_replaced", metadata: { confirmed: true } });
    });

    it("should not flag idsTruncated for exactly 20 ids", async () => {
        const { service, impact, record } = setup();
        impact.findAffected.mockResolvedValue(Array.from({ length: 20 }, (_unused, i) => i + 1));
        await service.replaceWorkingHours(actor, hoursInput(true));
        expect(record.mock.calls[0]?.[1]).toMatchObject({ metadata: { count: 20, idsTruncated: false } });
    });

    it("should never call the provider for a day_off delete or a past exception delete (S-R9)", async () => {
        const { service, impact, mocks } = setup();
        mocks.findException.mockResolvedValue(exception({ type: "day_off" as never, startTime: null, endTime: null }));
        await service.deleteException(actor, 5, false);
        mocks.findException.mockResolvedValue(exception({ date: "2027-06-09" }));
        await service.deleteException(actor, 5, false);
        expect(impact.findAffected).not.toHaveBeenCalled();
    });

    it("should call the provider for a custom_hours exception dated today (doctor timezone)", async () => {
        const { service, impact, mocks } = setup();
        mocks.findException.mockResolvedValue(exception({ date: "2027-06-10" }));
        await service.deleteException(actor, 5, false);
        expect(impact.findAffected).toHaveBeenCalledTimes(1);
    });

    it("should pass kind, dates, now and timezone in the context", async () => {
        const { service, impact, mocks, trx } = setup();
        await service.replaceWorkingHours(actor, hoursInput());
        await service.createExceptions(actor, dayOffInput({ date: "2027-06-20", endDate: "2027-06-22" }));
        mocks.findException.mockResolvedValue(exception({ date: "2027-06-25" }));
        await service.deleteException(actor, 5, false);
        const contexts = impact.findAffected.mock.calls.map((call) => call[0]);
        expect(contexts[0]).toEqual({ doctorProfileId: 9, doctorUserId: 202, timezone: "Africa/Cairo", now: NOW, change: { kind: "working_hours" } });
        expect(contexts[1]).toMatchObject({ change: { kind: "schedule_exception_created", fromDate: "2027-06-20", toDate: "2027-06-22" }, timezone: "Africa/Cairo", now: NOW });
        expect(contexts[2]).toMatchObject({ change: { kind: "schedule_exception_deleted", date: "2027-06-25" } });
        expect(impact.findAffected.mock.calls[0]?.[1]).toBe(trx);
    });

    it("should not block when the default provider returns []", async () => {
        const { service, record, impact } = setup();
        await service.createExceptions(actor, dayOffInput());
        expect(impact.flagAffected).not.toHaveBeenCalled();
        expect(record).toHaveBeenCalledTimes(1);
    });
});

describe("SchedulesService exceptions", () => {
    it.each([
        ["Pacific/Kiritimati", "2027-06-10", false], ["Pacific/Kiritimati", "2027-06-11", true],
        ["Pacific/Pago_Pago", "2027-06-09", true], ["Pacific/Pago_Pago", "2027-06-10", true], ["Pacific/Pago_Pago", "2027-06-08", false],
    ] as const)("should judge 'before today' in the doctor's timezone (%s, %s accepted=%s)", async (timezone, date, accepted) => {
        const { service, owners, record } = setup();
        owners.lock.mockResolvedValue(owner({ timezone }));
        const call = service.createExceptions(actor, dayOffInput({ date }));
        if (accepted) { await expect(call).resolves.toHaveLength(1); expect(record).toHaveBeenCalledTimes(1); }
        else { await expect(call).rejects.toMatchObject({ code: "ValidationFailed", details: [{ field: "date" }] }); expect(record).not.toHaveBeenCalled(); }
    });

    it("should insert one row per date of a range in one statement and audit the range", async () => {
        const { service, mocks, record, trx } = setup();
        const created = await service.createExceptions(actor, dayOffInput({ date: "2027-06-20", endDate: "2027-06-22", reason: "Synthetic leave" }));
        expect(mocks.insertExceptions).toHaveBeenCalledTimes(1);
        expect(mocks.insertExceptions.mock.calls[0]?.[1].map((row) => row.date)).toEqual(["2027-06-20", "2027-06-21", "2027-06-22"]);
        expect(created).toHaveLength(3);
        expect(record).toHaveBeenCalledWith(trx, expect.objectContaining({ action: "schedule.exception_created", entityType: "doctor_profile", entityId: 9,
            metadata: { type: "day_off", fromDate: "2027-06-20", toDate: "2027-06-22", count: 3 } }));
        expect(JSON.stringify(record.mock.calls)).not.toContain("Synthetic leave");
    });

    it("should store custom_hours times as HH:mm including 24:00", async () => {
        const { service, mocks } = setup();
        await service.createExceptions(actor, dayOffInput({ type: "custom_hours", startMinute: 600, endMinute: 1440 }));
        expect(mocks.insertExceptions.mock.calls[0]?.[1]).toEqual([{ date: "2027-06-20", type: "custom_hours", startTime: "10:00", endTime: "24:00", reason: null }]);
    });

    it("should map 23505 on the live-date index to Conflict with field date, and write no audit or notification", async () => {
        const { service, mocks, record, listener } = setup();
        mocks.insertExceptions.mockRejectedValue(pgUnique("uq_schedule_exceptions_doctor_profile_id_date"));
        await expect(service.createExceptions(actor, dayOffInput())).rejects.toMatchObject({ code: "Conflict", status: 409, details: [{ field: "date" }] });
        expect(record).not.toHaveBeenCalled();
        expect(listener.onScheduleChanged).not.toHaveBeenCalled();
    });

    it("should not map a 23505 on another constraint", async () => {
        const { service, mocks } = setup();
        const other = pgUnique("uq_something_else");
        mocks.insertExceptions.mockRejectedValue(other);
        await expect(service.createExceptions(actor, dayOffInput())).rejects.toBe(other);
    });

    it("should validate the shape and range before any I/O", async () => {
        const { service, transaction } = setup();
        await expect(service.createExceptions(actor, dayOffInput({ startMinute: 600 }))).rejects.toMatchObject({ code: "ValidationFailed" });
        await expect(service.createExceptions(actor, dayOffInput({ endDate: "2027-09-30" }))).rejects.toMatchObject({ code: "ValidationFailed" });
        expect(transaction).not.toHaveBeenCalled();
    });

    it("should return NotFound for a foreign, absent or deleted id on delete and write nothing", async () => {
        const { service, mocks, record, listener } = setup();
        mocks.findException.mockResolvedValue(undefined);
        await expect(service.deleteException(actor, 77, true)).rejects.toMatchObject({ code: "NotFound", status: 404 });
        expect(mocks.findException).toHaveBeenCalledWith(9, 77, expect.anything());
        expect(mocks.softDeleteException).not.toHaveBeenCalled();
        expect(record).not.toHaveBeenCalled();
        expect(listener.onScheduleChanged).not.toHaveBeenCalled();
    });

    it("should soft-delete and audit schedule.exception_deleted with entity schedule_exception", async () => {
        const { service, record, trx, mocks } = setup();
        await service.deleteException(actor, 5, false);
        expect(mocks.softDeleteException).toHaveBeenCalledWith(5, trx);
        expect(record).toHaveBeenCalledWith(trx, expect.objectContaining({ action: "schedule.exception_deleted", entityType: "schedule_exception", entityId: 5,
            metadata: { type: "custom_hours", date: "2027-06-20" } }));
    });

    it("should default fromDate to today in the doctor's timezone and fetch limit + 1", async () => {
        const { service, mocks } = setup();
        await service.listExceptions(actor, { limit: 5 });
        expect(mocks.listExceptions).toHaveBeenCalledWith(9, { fromDate: "2027-06-10", toDate: null, after: null, fetch: 6 }, expect.anything());
    });

    it("should build a (date, id) cursor when a further row exists and none otherwise", async () => {
        const { service, mocks } = setup();
        mocks.listExceptions.mockResolvedValue([exception({ id: 1, date: "2027-06-20" }), exception({ id: 2, date: "2027-06-21" })]);
        const page = await service.listExceptions(actor, { limit: 1 });
        expect(page.meta).toEqual({ nextCursor: encodeCursor("2027-06-20", 1), hasMore: true, count: 1 });
        const last = await service.listExceptions(actor, { limit: 2 });
        expect(last.meta).toEqual({ nextCursor: null, hasMore: false, count: 2 });
    });

    it("should pass the decoded cursor and reject malformed or non-date cursors with field cursor", async () => {
        const { service, mocks } = setup();
        await service.listExceptions(actor, { limit: 20, cursor: encodeCursor("2027-06-20", 4) });
        expect(mocks.listExceptions.mock.calls[0]?.[1].after).toEqual({ sortValue: "2027-06-20", id: 4 });
        for (const cursor of ["!!!", encodeCursor("2027-02-30", 1), encodeCursor(5, 1)]) {
            await expect(service.listExceptions(actor, { limit: 20, cursor })).rejects.toMatchObject({ code: "ValidationFailed", details: [{ field: "cursor" }] });
        }
    });

    it("should reject fromDate after toDate", async () => {
        const { service } = setup();
        await expect(service.listExceptions(actor, { fromDate: "2027-07-02", toDate: "2027-07-01" })).rejects.toMatchObject({ code: "ValidationFailed", details: [{ field: "fromDate" }] });
        await expect(service.listExceptions(actor, { toDate: "2027-06-09" })).rejects.toMatchObject({ code: "ValidationFailed" });
    });
});

describe("SchedulesService change listener", () => {
    it("should notify once with the right kind for each real change", async () => {
        const { service, listener, mocks } = setup();
        await service.createExceptions(actor, dayOffInput());
        await service.deleteException(actor, 5, false);
        await service.createConsultationType(actor, { name: "Synthetic Visit 001", durationMinutes: 30, price: 1, currency: "EGP" });
        await service.updateConsultationType(actor, 3, { name: "Synthetic Renamed" });
        mocks.listHours.mockResolvedValue([]);
        await service.replaceWorkingHours(actor, hoursInput());
        expect(listener.onScheduleChanged.mock.calls.map((call) => call[0].kind)).toEqual(["schedule_exception", "schedule_exception", "consultation_type", "consultation_type", "working_hours"]);
    });

    it("should not notify on a no-op, a 409, a validation failure or a rolled-back write", async () => {
        const { service, listener, impact, mocks, record } = setup();
        mocks.listHours.mockResolvedValue([hour(1, 1, "09:00", "12:00")]);
        await service.replaceWorkingHours(actor, hoursInput());
        mocks.listHours.mockResolvedValue([]);
        impact.findAffected.mockResolvedValue([1]);
        await expect(service.replaceWorkingHours(actor, hoursInput())).rejects.toMatchObject({ code: "ScheduleConflictsUnconfirmed" });
        await expect(service.createExceptions(actor, dayOffInput({ startMinute: 1 }))).rejects.toMatchObject({ code: "ValidationFailed" });
        impact.findAffected.mockResolvedValue([]);
        record.mockRejectedValueOnce(new Error("rollback"));
        await expect(service.createExceptions(actor, dayOffInput())).rejects.toThrow("rollback");
        await service.updateConsultationType(actor, 3, { name: "Synthetic Visit 001" });
        expect(listener.onScheduleChanged).not.toHaveBeenCalled();
    });

    it("should log schedule_change_listener_failed without data and still return success when the listener rejects (S-R11)", async () => {
        const { service, listener, logError } = setup();
        listener.onScheduleChanged.mockRejectedValue(new Error("Synthetic secret 4417"));
        await expect(service.createExceptions(actor, dayOffInput({ reason: "SYNTHETIC-REASON-4417" }))).resolves.toHaveLength(1);
        const errorLog = logError;
        expect(errorLog).toHaveBeenCalledTimes(1);
        const [message, fields] = errorLog.mock.calls[0] as [string, Record<string, unknown>];
        expect(message).toBe("schedule_change_listener_failed");
        expect(Object.keys(fields).sort()).toEqual(["doctorProfileId", "kind", "requestId"]);
        expect(JSON.stringify(errorLog.mock.calls)).not.toMatch(/4417|secret/);
    });
});

describe("SchedulesService consultation types", () => {
    const input = { name: "Synthetic Visit 001", durationMinutes: 30, price: 100, currency: "EGP" };

    it("should create, audit numeric fields only and notify", async () => {
        const { service, record, trx, mocks } = setup();
        const created = await service.createConsultationType(actor, input);
        expect(mocks.insertType).toHaveBeenCalledWith(9, input, trx);
        expect(created.id).toBe(3);
        expect(record).toHaveBeenCalledWith(trx, expect.objectContaining({ action: "consultation_type.created", entityType: "consultation_type", entityId: 3,
            metadata: { durationMinutes: 30, price: 100, currency: "EGP" } }));
        expect(JSON.stringify(record.mock.calls)).not.toContain("Synthetic Visit");
    });

    it("should reject a currency outside ALLOWED_CURRENCIES before opening a transaction (create and update)", async () => {
        const { service, transaction } = setup(["EGP"]);
        await expect(service.createConsultationType(actor, { ...input, currency: "USD" })).rejects.toMatchObject({ code: "ValidationFailed", details: [{ field: "currency" }] });
        await expect(service.updateConsultationType(actor, 3, { currency: "USD" })).rejects.toMatchObject({ code: "ValidationFailed", details: [{ field: "currency" }] });
        expect(transaction).not.toHaveBeenCalled();
    });

    it("should reject an allowed currency that differs from the profile currency (S-R13)", async () => {
        const { service, mocks, record } = setup(["EGP", "USD"]);
        await expect(service.createConsultationType(actor, { ...input, currency: "USD" })).rejects.toMatchObject({ code: "ValidationFailed", details: [{ field: "currency" }] });
        await expect(service.updateConsultationType(actor, 3, { currency: "USD" })).rejects.toMatchObject({ code: "ValidationFailed", details: [{ field: "currency" }] });
        expect(mocks.insertType).not.toHaveBeenCalled();
        expect(mocks.updateType).not.toHaveBeenCalled();
        expect(record).not.toHaveBeenCalled();
    });

    it("should accept the 20th type and throw ConsultationTypeLimitReached at 20 live types", async () => {
        const { service, mocks } = setup();
        mocks.countTypes.mockResolvedValue(19);
        await expect(service.createConsultationType(actor, input)).resolves.toBeDefined();
        mocks.countTypes.mockResolvedValue(20);
        await expect(service.createConsultationType(actor, input)).rejects.toMatchObject({ code: "Conflict", status: 409, details: [{ field: "consultationTypes" }] });
    });

    it("should map 23505 on the name index to Conflict (create and update) and not on another constraint", async () => {
        const { service, mocks, record } = setup();
        mocks.insertType.mockRejectedValue(pgUnique("uq_consultation_types_doctor_profile_id_name"));
        await expect(service.createConsultationType(actor, input)).rejects.toMatchObject({ code: "Conflict", details: [{ field: "name" }] });
        mocks.updateType.mockRejectedValue(pgUnique("uq_consultation_types_doctor_profile_id_name"));
        await expect(service.updateConsultationType(actor, 3, { name: "Other" })).rejects.toMatchObject({ code: "Conflict", details: [{ field: "name" }] });
        const other = pgUnique("uq_other");
        mocks.insertType.mockRejectedValue(other);
        await expect(service.createConsultationType(actor, input)).rejects.toBe(other);
        expect(record).not.toHaveBeenCalled();
    });

    it("should treat a no-op PATCH as success without write, audit or listener", async () => {
        const { service, mocks, record, listener } = setup();
        const result = await service.updateConsultationType(actor, 3, { name: "Synthetic Visit 001", price: 100, isActive: true });
        expect(result.id).toBe(3);
        expect(mocks.updateType).not.toHaveBeenCalled();
        expect(record).not.toHaveBeenCalled();
        expect(listener.onScheduleChanged).not.toHaveBeenCalled();
    });

    it("should audit only the changed wire names, sorted", async () => {
        const { service, record, mocks, trx } = setup();
        await service.updateConsultationType(actor, 3, { price: 50, name: "Synthetic Renamed", isActive: false, durationMinutes: 30 });
        expect(mocks.updateType).toHaveBeenCalledWith(3, { name: "Synthetic Renamed", price: 50, is_active: false }, trx);
        expect(record).toHaveBeenCalledWith(trx, expect.objectContaining({ action: "consultation_type.updated", entityType: "consultation_type", entityId: 3,
            metadata: { changedFields: "isActive,name,price" } }));
    });

    it("should return NotFound for a foreign or absent type id before comparing currency", async () => {
        const { service, mocks } = setup(["EGP", "USD"]);
        mocks.findType.mockResolvedValue(undefined);
        await expect(service.updateConsultationType(actor, 99, { currency: "USD" })).rejects.toMatchObject({ code: "NotFound" });
        expect(mocks.findType).toHaveBeenCalledWith(9, 99, expect.anything());
    });

    it("should paginate types by id with the isActive filter and reject cursors whose sort value is not the id", async () => {
        const { service, mocks } = setup();
        mocks.listTypes.mockResolvedValue([type({ id: 1 }), type({ id: 2 })]);
        const page = await service.listConsultationTypes(actor, { limit: 1, isActive: true });
        expect(page.meta).toEqual({ nextCursor: encodeCursor(1, 1), hasMore: true, count: 1 });
        expect(mocks.listTypes).toHaveBeenCalledWith(9, { isActive: true, afterId: null, fetch: 2 }, expect.anything());
        await service.listConsultationTypes(actor, { limit: 20, cursor: encodeCursor(7, 7) });
        expect(mocks.listTypes.mock.calls[1]?.[1]).toEqual({ isActive: null, afterId: 7, fetch: 21 });
        await expect(service.listConsultationTypes(actor, { limit: 20, cursor: encodeCursor(5, 7) })).rejects.toMatchObject({ code: "ValidationFailed", details: [{ field: "cursor" }] });
    });

    it("should delegate hasActiveConsultationType with the caller's connection", async () => {
        const { service, mocks, trx, db } = setup();
        await expect(service.hasActiveConsultationType(9, trx)).resolves.toBe(true);
        expect(mocks.hasActive).toHaveBeenCalledWith(9, trx);
        await service.hasActiveConsultationType(9);
        expect(mocks.hasActive).toHaveBeenLastCalledWith(9, db);
    });
});
