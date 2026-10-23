// Rules covered: AV-R19 (shortest type, none sentinel, removal), AV-R18 (single flight), spec 12.2.4 (version snapshot before inputs, guarded write).
import { NONE_SCORE } from "../../../../src/app/availability/constants";
import { NextAvailableComputer } from "../../../../src/app/availability/service/next-available.computer";
import type { NextAvailableIndex } from "../../../../src/app/availability/service/next-available.index";
import type { SlotInputsLoader } from "../../../../src/app/availability/service/slot-inputs.loader";
import type { ComputedEntry, DoctorSlotInputs, IndexWriteVerdict, SlotWindow } from "../../../../src/app/availability/types";
import type { IndexDoctor } from "../../../../src/app/doctors/types";
import { baseBucketOf, FREE_MAP_BUCKET_MS, FREE_MAP_BUCKETS, testFreeMap } from "../../../../src/pkg/slots/free-map";

const NOW = Date.UTC(2027, 0, 4, 8, 0, 0); // Monday
const doctor = (userId: number): IndexDoctor => ({ profileId: userId - 1000, userId, timezone: "UTC" });
const inputs = (overrides: Partial<DoctorSlotInputs> = {}): DoctorSlotInputs => ({
    timezone: "UTC", weekly: [{ weekday: 1, intervals: [{ startMinute: 540, endMinute: 600 }] }], exceptions: [], busy: [], durationMinutes: 30, typeId: 7, ...overrides,
});

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((res) => { resolve = res; });
    return { promise, resolve };
}

function setup() {
    const calls: string[] = [];
    const loadShortestType = jest.fn((doctors: readonly IndexDoctor[], _window?: SlotWindow) => {
        calls.push("load");
        return Promise.resolve(new Map(doctors.map((item) => [item.userId, inputs()])));
    });
    const versions = jest.fn((ids: readonly number[]) => { calls.push("versions"); return Promise.resolve<Map<number, string> | undefined>(new Map(ids.map((id) => [id, "3"]))); });
    const writeEntries = jest.fn((entries: readonly ComputedEntry[]): Promise<IndexWriteVerdict[] | undefined> => Promise.resolve(entries.map((): IndexWriteVerdict => "stored")));
    const remove = jest.fn().mockResolvedValue(true);
    const computer = new NextAvailableComputer({ loadShortestType } as unknown as SlotInputsLoader, { versions, writeEntries, remove } as unknown as NextAvailableIndex);
    return { computer, loadShortestType, versions, writeEntries, remove, calls };
}

describe("NextAvailableComputer.compute", () => {
    it("should score the earliest free start of the shortest type and mark its bucket in the map", async () => {
        const { computer } = setup();
        const result = await computer.compute([doctor(1001)], NOW);
        expect(result.removed).toEqual([]);
        const [entry] = result.entries;
        expect(entry?.score).toBe(Date.UTC(2027, 0, 4, 9, 0, 0));
        expect(testFreeMap(entry!.map, Date.UTC(2027, 0, 4, 9, 0, 0), Date.UTC(2027, 0, 4, 9, 0, 1))).toBe(true);
        expect(testFreeMap(entry!.map, Date.UTC(2027, 0, 4, 9, 30, 0), Date.UTC(2027, 0, 4, 9, 30, 1))).toBe(true);
        expect(testFreeMap(entry!.map, Date.UTC(2027, 0, 4, 10, 0, 0), Date.UTC(2027, 0, 4, 10, 0, 1))).toBe(false);
    });

    it("should load inputs for [now + 1 ms, (baseBucket + 1344) * 15 min) after snapshotting the versions", async () => {
        const { computer, loadShortestType, calls } = setup();
        await computer.compute([doctor(1001)], NOW);
        expect(calls).toEqual(["versions", "load"]);
        expect(loadShortestType.mock.calls[0]?.[1]).toEqual({ fromMs: NOW + 1, toMs: (baseBucketOf(NOW) + FREE_MAP_BUCKETS) * FREE_MAP_BUCKET_MS });
    });

    it("should carry the version snapshot of each doctor on its entry", async () => {
        const { computer, versions } = setup();
        versions.mockResolvedValue(new Map([[1001, "8"], [1002, "9"]]));
        const { entries } = await computer.compute([doctor(1001), doctor(1002)], NOW);
        expect(entries.map((entry) => entry.ver)).toEqual(["8", "9"]);
    });

    it("should store the none sentinel and an all-zero map for a doctor with no free slot in range", async () => {
        const { computer, loadShortestType } = setup();
        loadShortestType.mockResolvedValue(new Map([[1001, inputs({ weekly: [] })]]));
        const { entries } = await computer.compute([doctor(1001)], NOW);
        expect(entries[0]?.score).toBe(NONE_SCORE);
        expect([...entries[0]!.map.slice(5)].every((byte) => byte === 0)).toBe(true);
    });

    it("should report a doctor without an active type as removed and write nothing for it", async () => {
        const { computer, loadShortestType } = setup();
        loadShortestType.mockResolvedValue(new Map([[1002, inputs()]]));
        const result = await computer.compute([doctor(1001), doctor(1002)], NOW);
        expect(result.removed).toEqual([1001]);
        expect(result.entries.map((entry) => entry.userId)).toEqual([1002]);
    });

    it("should exclude a busy start from the earliest score", async () => {
        const { computer, loadShortestType } = setup();
        const nine = Date.UTC(2027, 0, 4, 9, 0, 0);
        loadShortestType.mockResolvedValue(new Map([[1001, inputs({ busy: [{ startMs: nine, endMs: nine + 1_800_000 }] })]]));
        expect((await computer.compute([doctor(1001)], NOW)).entries[0]?.score).toBe(nine + 1_800_000);
    });

    it("should leave the version unknown when the snapshot could not be read", async () => {
        const { computer, versions } = setup();
        versions.mockResolvedValue(undefined);
        expect((await computer.compute([doctor(1001)], NOW)).entries[0]?.ver).toBeNull();
    });

    it("should run one computation for concurrent calls on the same doctor (single flight)", async () => {
        const { computer, loadShortestType } = setup();
        const gate = deferred<Map<number, DoctorSlotInputs>>();
        loadShortestType.mockReturnValue(gate.promise);
        const first = computer.compute([doctor(1001)], NOW);
        const second = computer.compute([doctor(1001)], NOW);
        await Promise.resolve();
        gate.resolve(new Map([[1001, inputs()]]));
        const [a, b] = await Promise.all([first, second]);
        expect(loadShortestType).toHaveBeenCalledTimes(1);
        expect(a.entries[0]?.score).toBe(b.entries[0]?.score);
    });

    it("should recompute only the doctors not already in flight when batches overlap", async () => {
        const { computer, loadShortestType } = setup();
        const gate = deferred<Map<number, DoctorSlotInputs>>();
        loadShortestType.mockReturnValueOnce(gate.promise);
        const first = computer.compute([doctor(1001), doctor(1002)], NOW);
        const second = computer.compute([doctor(1002), doctor(1003)], NOW);
        await new Promise((resolve) => setImmediate(resolve));
        gate.resolve(new Map([[1001, inputs()], [1002, inputs()]]));
        const [a, b] = await Promise.all([first, second]);
        expect(loadShortestType).toHaveBeenCalledTimes(2);
        expect(loadShortestType.mock.calls[1]?.[0].map((item) => item.userId)).toEqual([1003]);
        expect(a.entries.map((entry) => entry.userId)).toEqual([1001, 1002]);
        expect(b.entries.map((entry) => entry.userId)).toEqual([1002, 1003]);
    });

    it("should release a key after a failure so the next call computes again", async () => {
        const { computer, loadShortestType } = setup();
        loadShortestType.mockRejectedValueOnce(new Error("postgres down"));
        await expect(computer.compute([doctor(1001)], NOW)).rejects.toThrow("postgres down");
        expect((await computer.compute([doctor(1001)], NOW)).entries).toHaveLength(1);
    });
});

describe("NextAvailableComputer.write and refresh", () => {
    const entry = (userId: number, ver: string | null = "3"): ComputedEntry => ({ userId, score: NOW + 1, map: new Uint8Array(173), ver });

    it("should count stored entries and treat a guard rejection as neither stored nor failed", async () => {
        const { computer, writeEntries } = setup();
        writeEntries.mockResolvedValue(["stored", "rejected", "failed"]);
        expect(await computer.write([entry(1), entry(2), entry(3)])).toEqual({ stored: 1, failed: [3] });
    });

    it("should fail an entry whose version is unknown without sending it", async () => {
        const { computer, writeEntries } = setup();
        expect(await computer.write([entry(1, null), entry(2)])).toEqual({ stored: 1, failed: [1] });
        expect(writeEntries.mock.calls[0]?.[0].map((item) => item.userId)).toEqual([2]);
    });

    it("should fail every writable entry when Redis is unreachable", async () => {
        const { computer, writeEntries } = setup();
        writeEntries.mockResolvedValue(undefined);
        expect(await computer.write([entry(1), entry(2, null)])).toEqual({ stored: 0, failed: [2, 1] });
    });

    it("should compute, write and drop doctors that lost their only active type from the index", async () => {
        const { computer, loadShortestType, remove, writeEntries } = setup();
        loadShortestType.mockResolvedValue(new Map([[1002, inputs()]]));
        const result = await computer.refresh([doctor(1001), doctor(1002)], NOW);
        expect(writeEntries).toHaveBeenCalledTimes(1);
        expect(remove).toHaveBeenCalledWith([1001]);
        expect(result).toMatchObject({ stored: 1, failed: [], removed: [1001] });
        expect(result.entries).toHaveLength(1);
    });

    it("should not touch the index removal when nothing was removed", async () => {
        const { computer, remove } = setup();
        await computer.refresh([doctor(1001)], NOW);
        expect(remove).not.toHaveBeenCalled();
    });
});
