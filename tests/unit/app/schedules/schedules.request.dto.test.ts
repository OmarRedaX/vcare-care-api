import "reflect-metadata";
import {
    ConsultationTypeCreateDto, ConsultationTypeUpdateDto, DeleteExceptionQueryDto, ListExceptionsQueryDto, ListTypesQueryDto,
    ScheduleExceptionCreateDto, WorkingHoursReplaceDto,
} from "../../../../src/app/schedules/dto/schedules.request.dto";
import { validateBody, validateQuery } from "../../../../src/lib/validation/validate";

const day = (weekday: unknown, ...intervals: Array<[string, string]>): object => ({ weekday, intervals: intervals.map(([startTime, endTime]) => ({ startTime, endTime })) });
const fields = async (promise: Promise<unknown>): Promise<string[]> => {
    const error = await promise.then(() => undefined, (caught: unknown) => caught as { code: string; details: Array<{ field: string }> });
    expect(error).toMatchObject({ code: "ValidationFailed" });
    return (error as { details: Array<{ field: string }> }).details.map((detail) => detail.field);
};

describe("WorkingHoursReplaceDto", () => {
    it("should accept a valid body and convert it to minutes with confirmConflicts false by default", async () => {
        const dto = await validateBody(WorkingHoursReplaceDto, { days: [day(1, ["09:00", "12:00"], ["14:00", "24:00"])] });
        expect(dto.toInput()).toEqual({ days: [{ weekday: 1, intervals: [{ startMinute: 540, endMinute: 720 }, { startMinute: 840, endMinute: 1440 }] }], confirmConflicts: false });
    });
    it("should accept days: [] and confirmConflicts true", async () => {
        const dto = await validateBody(WorkingHoursReplaceDto, { days: [], confirmConflicts: true });
        expect(dto.toInput()).toEqual({ days: [], confirmConflicts: true });
    });
    it("should accept 7 days of 6 intervals each", async () => {
        const intervals = Array.from({ length: 6 }, (_unused, i): [string, string] => [`0${i}:00`, `0${i}:30`]);
        await expect(validateBody(WorkingHoursReplaceDto, { days: [1, 2, 3, 4, 5, 6, 7].map((weekday) => day(weekday, ...intervals)) })).resolves.toBeDefined();
    });

    it.each([[0], [8], [1.5], ["1"], [null]])("should reject weekday %p", async (weekday) => {
        expect(await fields(validateBody(WorkingHoursReplaceDto, { days: [day(weekday, ["09:00", "10:00"])] }))).toContain("days.0.weekday");
    });
    it("should reject 0 intervals and 7 intervals on a day", async () => {
        expect(await fields(validateBody(WorkingHoursReplaceDto, { days: [day(1)] }))).toContain("days.0.intervals");
        const seven = Array.from({ length: 7 }, (_unused, i): [string, string] => [`0${i}:00`, `0${i}:30`]);
        expect(await fields(validateBody(WorkingHoursReplaceDto, { days: [day(1, ...seven)] }))).toContain("days.0.intervals");
    });
    it.each([["25:00"], ["9:00"], ["24:01"], ["09:60"], [""], ["09:00:00"]])("should reject the time %p", async (time) => {
        expect(await fields(validateBody(WorkingHoursReplaceDto, { days: [day(1, [time, "23:00"])] }))).toContain("days.0.intervals.0.startTime");
        expect(await fields(validateBody(WorkingHoursReplaceDto, { days: [day(1, ["00:00", time])] }))).toContain("days.0.intervals.0.endTime");
    });
    it.each([["doctorProfileId"], ["userId"]])("should reject the unknown member %s", async (member) => {
        expect(await fields(validateBody(WorkingHoursReplaceDto, { days: [], [member]: 9 }))).toContain(member);
    });
    it.each([["yes"], [1], [null]])("should reject a non-boolean confirmConflicts %p", async (value) => {
        expect(await fields(validateBody(WorkingHoursReplaceDto, { days: [], confirmConflicts: value }))).toContain("confirmConflicts");
    });
    it("should reject more than 7 days and a missing or non-array days", async () => {
        const eight = [1, 2, 3, 4, 5, 6, 7, 1].map((weekday) => day(weekday, ["09:00", "10:00"]));
        expect(await fields(validateBody(WorkingHoursReplaceDto, { days: eight }))).toContain("days");
        expect(await fields(validateBody(WorkingHoursReplaceDto, {}))).toContain("days");
        expect(await fields(validateBody(WorkingHoursReplaceDto, { days: "x" }))).toContain("days");
    });
    it("should reject unknown members inside a day and an interval", async () => {
        expect(await fields(validateBody(WorkingHoursReplaceDto, { days: [{ ...day(1, ["09:00", "10:00"]), extra: 1 }] }))).toContain("days.0.extra");
    });
});

describe("ScheduleExceptionCreateDto", () => {
    it("should accept a day_off with endDate and convert it", async () => {
        const dto = await validateBody(ScheduleExceptionCreateDto, { type: "day_off", date: "2027-05-01", endDate: "2027-05-10", reason: "Synthetic leave" });
        expect(dto.toInput()).toEqual({ type: "day_off", date: "2027-05-01", endDate: "2027-05-10", startMinute: null, endMinute: null, reason: "Synthetic leave", confirmConflicts: false });
    });
    it("should accept custom_hours with times including 24:00", async () => {
        const dto = await validateBody(ScheduleExceptionCreateDto, { type: "custom_hours", date: "2027-05-01", startTime: "10:00", endTime: "24:00", confirmConflicts: true });
        expect(dto.toInput()).toMatchObject({ type: "custom_hours", startMinute: 600, endMinute: 1440, endDate: null, reason: null, confirmConflicts: true });
    });
    it("should reject 2027-02-30 for date and endDate", async () => {
        expect(await fields(validateBody(ScheduleExceptionCreateDto, { type: "day_off", date: "2027-02-30" }))).toContain("date");
        expect(await fields(validateBody(ScheduleExceptionCreateDto, { type: "day_off", date: "2027-02-01", endDate: "2027-02-30" }))).toContain("endDate");
    });
    it("should reject a reason of 501 code points, null and NUL but accept exactly 500 code points", async () => {
        const base = { type: "day_off", date: "2027-05-01" };
        expect(await fields(validateBody(ScheduleExceptionCreateDto, { ...base, reason: "x".repeat(501) }))).toContain("reason");
        expect(await fields(validateBody(ScheduleExceptionCreateDto, { ...base, reason: null }))).toContain("reason");
        expect(await fields(validateBody(ScheduleExceptionCreateDto, { ...base, reason: "bad\u0000reason" }))).toContain("reason");
        await expect(validateBody(ScheduleExceptionCreateDto, { ...base, reason: "x".repeat(500) })).resolves.toBeDefined();
        await expect(validateBody(ScheduleExceptionCreateDto, { ...base, reason: "\u{1F600}".repeat(500) })).resolves.toBeDefined();
    });
    it.each([["holiday"], ["DAY_OFF"], [null], [1]])("should reject the type %p", async (type) => {
        expect(await fields(validateBody(ScheduleExceptionCreateDto, { type, date: "2027-05-01" }))).toContain("type");
    });
    it("should reject unknown members, bad times and a non-boolean confirmConflicts", async () => {
        const base = { type: "custom_hours", date: "2027-05-01", startTime: "10:00", endTime: "11:00" };
        expect(await fields(validateBody(ScheduleExceptionCreateDto, { ...base, doctorProfileId: 4 }))).toContain("doctorProfileId");
        expect(await fields(validateBody(ScheduleExceptionCreateDto, { ...base, startTime: "25:00" }))).toContain("startTime");
        expect(await fields(validateBody(ScheduleExceptionCreateDto, { ...base, confirmConflicts: "true" }))).toContain("confirmConflicts");
    });
});

describe("ConsultationTypeCreateDto", () => {
    const valid = { name: "Synthetic Visit 001", durationMinutes: 30, price: 15000, currency: "EGP" };
    it("should accept a valid body and the boundary values", async () => {
        expect((await validateBody(ConsultationTypeCreateDto, valid)).toInput()).toEqual(valid);
        for (const change of [{ name: "ab" }, { name: "x".repeat(100) }, { durationMinutes: 5 }, { durationMinutes: 240 }, { price: 0 }, { price: 2147483647 }]) {
            await expect(validateBody(ConsultationTypeCreateDto, { ...valid, ...change })).resolves.toBeDefined();
        }
    });
    it.each([
        ["1 code point", { name: "a" }], ["101 code points", { name: "x".repeat(101) }], ["whitespace only", { name: "     " }],
        ["control characters", { name: "Synthetic\u0001Visit" }], ["a tab", { name: "Synthetic\tVisit" }], ["a number", { name: 5 }],
    ])("should reject a name of %s", async (_label, change) => {
        expect(await fields(validateBody(ConsultationTypeCreateDto, { ...valid, ...change }))).toContain("name");
    });
    it.each([[4], [241], [1.5], ["30"], [null]])("should reject duration %p", async (durationMinutes) => {
        expect(await fields(validateBody(ConsultationTypeCreateDto, { ...valid, durationMinutes }))).toContain("durationMinutes");
    });
    it.each([[-1], [2147483648], [1.5], ["100"], [null]])("should reject price %p", async (price) => {
        expect(await fields(validateBody(ConsultationTypeCreateDto, { ...valid, price }))).toContain("price");
    });
    it.each([["egp"], ["EG"], ["EGPP"], ["E1P"], [null], [1]])("should reject currency %p", async (currency) => {
        expect(await fields(validateBody(ConsultationTypeCreateDto, { ...valid, currency }))).toContain("currency");
    });
    it("should reject unknown members and isActive", async () => {
        expect(await fields(validateBody(ConsultationTypeCreateDto, { ...valid, isActive: false }))).toContain("isActive");
        expect(await fields(validateBody(ConsultationTypeCreateDto, { ...valid, doctorProfileId: 1 }))).toContain("doctorProfileId");
    });
});

describe("ConsultationTypeUpdateDto", () => {
    it("should report isEmpty for {} and not for any single member", async () => {
        expect((await validateBody(ConsultationTypeUpdateDto, {})).isEmpty()).toBe(true);
        for (const change of [{ name: "Synthetic" }, { durationMinutes: 10 }, { price: 0 }, { currency: "EGP" }, { isActive: false }]) {
            expect((await validateBody(ConsultationTypeUpdateDto, change)).isEmpty()).toBe(false);
        }
    });
    it.each(["name", "durationMinutes", "price", "currency", "isActive"])("should reject null for %s", async (member) => {
        expect(await fields(validateBody(ConsultationTypeUpdateDto, { [member]: null }))).toContain(member);
    });
    it("should omit absent members in toChanges and keep falsy present members", async () => {
        expect((await validateBody(ConsultationTypeUpdateDto, { price: 0, isActive: false })).toChanges()).toEqual({ price: 0, isActive: false });
        expect((await validateBody(ConsultationTypeUpdateDto, { name: "Synthetic Renamed" })).toChanges()).toEqual({ name: "Synthetic Renamed" });
    });
    it("should apply the create value rules and reject a string isActive and unknown members", async () => {
        expect(await fields(validateBody(ConsultationTypeUpdateDto, { durationMinutes: 4 }))).toContain("durationMinutes");
        expect(await fields(validateBody(ConsultationTypeUpdateDto, { price: 2147483648 }))).toContain("price");
        expect(await fields(validateBody(ConsultationTypeUpdateDto, { name: "  " }))).toContain("name");
        expect(await fields(validateBody(ConsultationTypeUpdateDto, { isActive: "false" }))).toContain("isActive");
        expect(await fields(validateBody(ConsultationTypeUpdateDto, { userId: 1 }))).toContain("userId");
    });
});

describe("query DTOs", () => {
    it("should accept isActive true/false and convert them", async () => {
        expect((await validateQuery(ListTypesQueryDto, { isActive: "false" })).isActive).toBe(false);
        expect((await validateQuery(ListTypesQueryDto, { isActive: "true" })).isActive).toBe(true);
    });
    it.each([["yes"], ["1"], ["TRUE"], [""]])("should reject isActive=%p", async (isActive) => {
        expect(await fields(validateQuery(ListTypesQueryDto, { isActive }))).toContain("isActive");
    });
    it.each([["0"], ["101"], ["-1"], ["1.5"], ["abc"]])("should reject limit=%p", async (limit) => {
        expect(await fields(validateQuery(ListTypesQueryDto, { limit }))).toContain("limit");
        expect(await fields(validateQuery(ListExceptionsQueryDto, { limit }))).toContain("limit");
    });
    it("should default limit to 20 and accept 1 and 100", async () => {
        expect((await validateQuery(ListTypesQueryDto, {})).limit).toBe(20);
        expect((await validateQuery(ListExceptionsQueryDto, { limit: "1" })).limit).toBe(1);
        expect((await validateQuery(ListExceptionsQueryDto, { limit: "100" })).limit).toBe(100);
    });
    it("should validate fromDate/toDate as real calendar dates", async () => {
        await expect(validateQuery(ListExceptionsQueryDto, { fromDate: "2027-02-28", toDate: "2028-02-29" })).resolves.toBeDefined();
        expect(await fields(validateQuery(ListExceptionsQueryDto, { fromDate: "2027-02-30" }))).toContain("fromDate");
        expect(await fields(validateQuery(ListExceptionsQueryDto, { toDate: "tomorrow" }))).toContain("toDate");
    });
    it.each([["1"], ["maybe"], ["TRUE"], [""]])("should reject confirmConflicts=%p", async (confirmConflicts) => {
        expect(await fields(validateQuery(DeleteExceptionQueryDto, { confirmConflicts }))).toContain("confirmConflicts");
    });
    it("should accept confirmConflicts true/false and absent", async () => {
        expect((await validateQuery(DeleteExceptionQueryDto, { confirmConflicts: "true" })).confirmConflicts).toBe(true);
        expect((await validateQuery(DeleteExceptionQueryDto, { confirmConflicts: "false" })).confirmConflicts).toBe(false);
        expect((await validateQuery(DeleteExceptionQueryDto, {})).confirmConflicts).toBeUndefined();
    });
    it("should reject unknown query members", async () => {
        expect(await fields(validateQuery(ListTypesQueryDto, { doctorProfileId: "1" }))).toContain("doctorProfileId");
    });
});
