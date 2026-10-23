// Rules covered: spec 2.2 / 12.2.5 (page view loads of active types, batched slot inputs), AV-R19 (shortest type: ties lowest id).
import "reflect-metadata";
import knex from "knex";
import type { Knex } from "knex";
import { listActiveTypesForProfiles, listActiveTypesForProfilesQuery } from "../../../../src/app/schedules/repository/consultation-types.repo";
import { ScheduleExceptionType } from "../../../../src/app/schedules/enums";
import * as slotRepo from "../../../../src/app/schedules/repository/slot-inputs.repo";
import { listShortestTypesQuery } from "../../../../src/app/schedules/repository/slot-inputs.repo";
import { SchedulesService } from "../../../../src/app/schedules/service/schedules.service";
import { SlotInputsReader } from "../../../../src/app/schedules/service/slot-inputs.reader";

const dry = knex({ client: "pg" });
afterAll(async () => { await dry.destroy(); });
afterEach(() => jest.restoreAllMocks());

const row = (id: number, profile: number, minutes = 30) => ({ id, doctor_profile_id: profile, name: `T${id}`, duration_minutes: minutes, price: 100, currency: "EGP", is_active: true, created_at: new Date(0), updated_at: new Date(0) });
const rowsConn = (rows: unknown[]): Knex => {
    const builder = { select: () => builder, whereRaw: () => builder, where: () => builder, whereNull: () => builder, orderBy: () => builder, then: (resolve: (value: unknown[]) => void) => resolve(rows) };
    return (() => builder) as unknown as Knex;
};

describe("listActiveTypesForProfiles", () => {
    it("should select explicit columns of live active types of the given profiles with one ANY statement ordered by profile then id", () => {
        const { sql, bindings } = listActiveTypesForProfilesQuery([4, 5], dry).toSQL();
        expect(sql).toMatch(/^select "doctor_profile_id", "id", "name", "duration_minutes", "price", "currency", "is_active", "created_at", "updated_at" from "consultation_types"/);
        expect(sql).toContain("doctor_profile_id = ANY(?::bigint[])");
        expect(sql).toContain('"is_active" = ?');
        expect(sql).toContain('"deleted_at" is null');
        expect(sql).toContain('order by "doctor_profile_id" asc, "id" asc');
        expect(bindings).toEqual([[4, 5], true]);
    });

    it("should group the types by owner profile in id order and leave profiles with none absent", async () => {
        const grouped = await listActiveTypesForProfiles([4, 5, 6], rowsConn([row(1, 4), row(2, 4, 15), row(3, 5)]));
        expect([...grouped.keys()]).toEqual([4, 5]);
        expect(grouped.get(4)?.map((type) => type.id)).toEqual([1, 2]);
        expect(grouped.get(4)?.[1]).toMatchObject({ durationMinutes: 15, isActive: true, currency: "EGP" });
    });

    it("should not query for an empty profile list", async () => {
        const never = (() => { throw new Error("must not query"); }) as unknown as Knex;
        expect((await listActiveTypesForProfiles([], never)).size).toBe(0);
    });

    it("should be exposed by SchedulesService on its own connection or the caller one", async () => {
        const conn = rowsConn([row(1, 4)]);
        const service = new SchedulesService(conn, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never);
        expect((await service.listActiveTypesFor([4], conn)).get(4)).toHaveLength(1);
    });
});

describe("shortest active type statement (AV-R19)", () => {
    it("should pick the smallest duration with the lowest id on ties, one row per doctor, active and live only", () => {
        const { sql } = listShortestTypesQuery([4, 5], dry).toSQL();
        expect(sql).toContain('distinct on ("doctor_profile_id")');
        expect(sql).toContain('order by "doctor_profile_id" asc, "duration_minutes" asc, "id" asc');
        expect(sql).toContain("doctor_profile_id = ANY(?::bigint[])");
        expect(sql).toContain('"is_active" = ?');
        expect(sql).toContain('"deleted_at" is null');
    });
});

describe("SlotInputsReader.loadSlotInputs", () => {
    it("should group hours, exceptions and the shortest type per profile with the 24:00 end kept, running the statements one after the other", async () => {
        const order: string[] = [];
        jest.spyOn(slotRepo, "listSlotHours").mockImplementation(() => { order.push("hours"); return Promise.resolve([
            { doctor_profile_id: 4, weekday: 1, start_time: "09:00:00", end_time: "12:00:00" }, { doctor_profile_id: 4, weekday: 1, start_time: "13:00:00", end_time: "24:00:00" },
            { doctor_profile_id: 5, weekday: 2, start_time: "08:00:00", end_time: "09:00:00" }]); });
        jest.spyOn(slotRepo, "listSlotExceptions").mockImplementation(() => { order.push("exceptions"); return Promise.resolve([
            { doctor_profile_id: 5, date: "2027-01-05", type: ScheduleExceptionType.DayOff, start_time: null, end_time: null }]); });
        jest.spyOn(slotRepo, "listShortestTypes").mockImplementation(() => { order.push("types"); return Promise.resolve([{ id: 8, doctor_profile_id: 4, duration_minutes: 15 }]); });
        const result = await new SlotInputsReader({} as Knex).loadSlotInputs([4, 5, 6], "2027-01-01", "2027-01-31");
        expect(order).toEqual(["hours", "exceptions", "types"]);
        expect(result.get(4)).toEqual({ weekly: [{ weekday: 1, intervals: [{ startMinute: 540, endMinute: 720 }, { startMinute: 780, endMinute: 1440 }] }], exceptions: [], shortestType: { id: 8, durationMinutes: 15 } });
        expect(result.get(5)).toMatchObject({ exceptions: [{ date: "2027-01-05", type: "day_off", startMinute: null, endMinute: null }], shortestType: null });
        expect(result.get(6)).toEqual({ weekly: [], exceptions: [], shortestType: null });
    });
});
