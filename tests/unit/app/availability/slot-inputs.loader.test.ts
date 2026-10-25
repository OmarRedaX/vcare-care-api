// Rules covered: AV-R19 (shortest type per doctor), AV-R4 (busy window), spec 12.1.3 (UTC date margin, four statements per batch, sequential).
import type { DoctorDiscoveryReader } from "../../../../src/app/doctors/service/doctor-discovery.reader";
import type { IndexDoctor } from "../../../../src/app/doctors/types";
import { SlotInputsLoader } from "../../../../src/app/availability/service/slot-inputs.loader";
import type { BusyIntervalsReader } from "../../../../src/app/consultations/service/busy-intervals.reader";
import type { SlotInputsReader } from "../../../../src/app/schedules/service/slot-inputs.reader";
import type { SlotScheduleInputs } from "../../../../src/app/schedules/types";

const doctor = (profileId: number, timezone = "UTC"): IndexDoctor => ({ profileId, userId: profileId + 1000, timezone });
const window = { fromMs: Date.UTC(2027, 0, 4, 8, 0, 0), toMs: Date.UTC(2027, 0, 18, 8, 0, 0) };
const known = (shortest: SlotScheduleInputs["shortestType"]): SlotScheduleInputs => ({ weekly: [{ weekday: 1, intervals: [{ startMinute: 540, endMinute: 600 }] }], exceptions: [], shortestType: shortest });

function setup() {
    const order: string[] = [];
    const loadSlotInputs = jest.fn((ids: readonly number[]) => { order.push("inputs"); return Promise.resolve(new Map(ids.map((id) => [id, known(id === 2 ? null : { id: id * 10, durationMinutes: 15 })]))); });
    const listBusy = jest.fn((ids: readonly number[]) => { order.push("busy"); return Promise.resolve(new Map(ids.map((id) => [id, id === 1001 ? [{ startMs: 1, endMs: 2 }] : []]))); });
    const loadHoursAndExceptions = jest.fn();
    const loader = new SlotInputsLoader({} as DoctorDiscoveryReader, { loadSlotInputs, loadHoursAndExceptions } as unknown as SlotInputsReader, { listBusy } as unknown as BusyIntervalsReader);
    return { loader, loadSlotInputs, listBusy, order };
}

describe("SlotInputsLoader.loadShortestType", () => {
    it("should load a whole batch with one schedule read and one busy read, in that order", async () => {
        const s = setup();
        await s.loader.loadShortestType([doctor(1), doctor(2), doctor(3)], window);
        expect(s.order).toEqual(["inputs", "busy"]);
        expect(s.loadSlotInputs).toHaveBeenCalledTimes(1);
        expect(s.listBusy).toHaveBeenCalledTimes(1);
        expect(s.loadSlotInputs.mock.calls[0]?.[0]).toEqual([1, 2, 3]);
        expect(s.listBusy.mock.calls[0]).toEqual([[1001, 1002, 1003], window.fromMs, window.toMs]);
    });

    it("should cover every doctor-local date with two UTC days of margin on each side", async () => {
        const s = setup();
        await s.loader.loadShortestType([doctor(1)], window);
        expect(s.loadSlotInputs.mock.calls[0]?.slice(1)).toEqual(["2027-01-02", "2027-01-20"]);
    });

    it("should key the result by user id with the doctor zone, the shortest type and the doctor busy intervals", async () => {
        const s = setup();
        const result = await s.loader.loadShortestType([doctor(1, "Africa/Cairo")], window);
        expect(result.get(1001)).toEqual({ timezone: "Africa/Cairo", weekly: known(null).weekly, exceptions: [], busy: [{ startMs: 1, endMs: 2 }], durationMinutes: 15, typeId: 10 });
    });

    it("should omit a doctor without a live active type", async () => {
        const s = setup();
        const result = await s.loader.loadShortestType([doctor(1), doctor(2)], window);
        expect([...result.keys()]).toEqual([1001]);
    });

    it("should not read anything for an empty batch", async () => {
        const s = setup();
        expect((await s.loader.loadShortestType([], window)).size).toBe(0);
        expect(s.loadSlotInputs).not.toHaveBeenCalled();
        expect(s.listBusy).not.toHaveBeenCalled();
    });
});
