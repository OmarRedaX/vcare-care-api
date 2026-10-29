// Rules covered: AV-R23 (singleton by advisory lock, batches of 100, stale removal, swept-at only on a full pass, incomplete cases),
// AV-R28 (name-index rebuild when the stamp is absent or older than the refresh period; a failed rebuild never fails the sweep).
import type { Knex } from "knex";
import { AvailabilitySweepService } from "../../../../src/app/availability/service/availability-sweep.service";
import { NameIndexOutcome } from "../../../../src/app/availability/enums";
import type { NameIndexBuilder } from "../../../../src/app/availability/service/name-index.builder";
import type { NextAvailableComputer } from "../../../../src/app/availability/service/next-available.computer";
import type { NextAvailableIndex } from "../../../../src/app/availability/service/next-available.index";
import type { DoctorDiscoveryReader } from "../../../../src/app/doctors/service/doctor-discovery.reader";
import type { IndexDoctor } from "../../../../src/app/doctors/types";
import type { Logger } from "../../../../src/lib/logger/logger";

const doctors = (count: number): IndexDoctor[] => Array.from({ length: count }, (_, position) => ({ profileId: position + 1, userId: position + 1001, timezone: "UTC" }));

/** A pool whose session advisory lock is acquired (or not) by one scripted answer. */
function lockedDb(acquired: boolean): { db: Knex; unlocked: jest.Mock; released: jest.Mock } {
    const unlocked = jest.fn();
    const released = jest.fn();
    const raw = jest.fn((sql: string) => {
        const result = sql.includes("pg_try_advisory_lock") ? { rows: [{ acquired }] } : (unlocked(), { rows: [] });
        return { connection: () => Promise.resolve(result) };
    });
    const client = { config: { pool: { max: 6 } }, acquireConnection: jest.fn().mockResolvedValue({ id: "c" }), releaseConnection: released };
    return { db: { client, raw } as unknown as Knex, unlocked, released };
}

function setup(options: { acquired?: boolean; list?: IndexDoctor[]; truncated?: boolean; recheck?: IndexDoctor[] } = {}) {
    const { db, unlocked, released } = lockedDb(options.acquired ?? true);
    // The full list answers the argument-less call; the re-check of stale ids (`listBookableForIndex(ids)`) answers with `recheck` (default none).
    const reader = { listBookableForIndex: jest.fn((ids?: number[]) => Promise.resolve(ids === undefined
        ? { items: options.list ?? doctors(3), truncated: options.truncated ?? false }
        : { items: (options.recheck ?? []).filter((doctor) => ids.includes(doctor.userId)), truncated: false })) };
    const computer = { refresh: jest.fn().mockResolvedValue({ entries: [], removed: [], stored: 0, failed: [] }) };
    const index = {
        isUsable: jest.fn(() => true), members: jest.fn().mockResolvedValue([1001, 1002, 1003]), remove: jest.fn().mockResolvedValue(true),
        markSwept: jest.fn().mockResolvedValue(true), readNameBuiltAt: jest.fn().mockResolvedValue(null),
    };
    const names = { rebuild: jest.fn().mockResolvedValue(NameIndexOutcome.Built) };
    const logger = { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), metric: jest.fn() };
    let tickNow = 1_800_000_000_000;
    const service = new AvailabilitySweepService(db, reader as unknown as DoctorDiscoveryReader, computer as unknown as NextAvailableComputer,
        index as unknown as NextAvailableIndex, logger as unknown as Logger, { now: () => (tickNow += 500) }, names as unknown as NameIndexBuilder, 300);
    return { service, reader, computer, index, names, logger, unlocked, released, now: () => tickNow };
}
const signal = (): AbortSignal => new AbortController().signal;

describe("AvailabilitySweepService.tick (AV-R23)", () => {
    it("should recompute every bookable doctor in batches of 100 and stamp the sweep on a full pass", async () => {
        const s = setup({ list: doctors(250), });
        s.index.members.mockResolvedValue(doctors(250).map((item) => item.userId));
        expect(await s.service.tick(signal())).toBe("done");
        expect(s.computer.refresh).toHaveBeenCalledTimes(3);
        expect(s.computer.refresh.mock.calls.map((call) => (call[0] as unknown[]).length)).toEqual([100, 100, 50]);
        expect(s.index.markSwept).toHaveBeenCalledTimes(1);
        expect(s.logger.metric).toHaveBeenCalledWith("availability_sweep_duration_ms", expect.any(Number));
        expect(s.logger.info).toHaveBeenCalledWith("availability_sweep_done", { doctors: 250, batches: 3, durationMs: expect.any(Number) });
        expect(s.unlocked).toHaveBeenCalledTimes(1);
        expect(s.released).toHaveBeenCalledTimes(1);
    });

    it("should remove index members that are no longer bookable before stamping", async () => {
        const s = setup({ list: doctors(2) });
        s.index.members.mockResolvedValue([1001, 1002, 9999, 8888]);
        expect(await s.service.tick(signal())).toBe("done");
        expect(s.index.remove).toHaveBeenCalledWith([9999, 8888]);
        expect(s.reader.listBookableForIndex).toHaveBeenLastCalledWith([9999, 8888]);
        expect(s.index.remove.mock.invocationCallOrder[0]).toBeLessThan(s.index.markSwept.mock.invocationCallOrder[0] ?? 0);
    });

    it("should not call remove nor re-check when every member is still bookable", async () => {
        const s = setup({ list: doctors(3) });
        await s.service.tick(signal());
        expect(s.index.remove).not.toHaveBeenCalled();
        expect(s.reader.listBookableForIndex).toHaveBeenCalledTimes(1);
    });

    it("should keep a member that became bookable during the pass and remove only those the re-check still finds not bookable", async () => {
        const s = setup({ list: doctors(2), recheck: [{ profileId: 77, userId: 9999, timezone: "UTC" }] });
        s.index.members.mockResolvedValue([1001, 1002, 9999, 8888]);
        expect(await s.service.tick(signal())).toBe("done");
        expect(s.index.remove).toHaveBeenCalledTimes(1);
        expect(s.index.remove).toHaveBeenCalledWith([8888]);
    });

    it("should skip the removal entirely when the re-check finds every candidate bookable again", async () => {
        const s = setup({ list: doctors(1), recheck: [{ profileId: 77, userId: 9999, timezone: "UTC" }] });
        s.index.members.mockResolvedValue([1001, 9999]);
        expect(await s.service.tick(signal())).toBe("done");
        expect(s.index.remove).not.toHaveBeenCalled();
        expect(s.index.markSwept).toHaveBeenCalledTimes(1);
    });

    it("should report incomplete without touching Redis or Postgres reads when the lock is held elsewhere", async () => {
        const s = setup({ acquired: false });
        expect(await s.service.tick(signal())).toBe("incomplete");
        expect(s.reader.listBookableForIndex).not.toHaveBeenCalled();
        expect(s.index.markSwept).not.toHaveBeenCalled();
        expect(s.logger.debug).toHaveBeenCalledWith("availability_sweep_skipped");
    });

    it("should report incomplete and not stamp when Redis is unusable", async () => {
        const s = setup();
        s.index.isUsable.mockReturnValue(false);
        expect(await s.service.tick(signal())).toBe("incomplete");
        expect(s.reader.listBookableForIndex).not.toHaveBeenCalled();
        expect(s.index.markSwept).not.toHaveBeenCalled();
    });

    it("should stop between batches when aborted, report incomplete and not stamp", async () => {
        const s = setup({ list: doctors(250) });
        const controller = new AbortController();
        s.computer.refresh.mockImplementation(() => { controller.abort(); return Promise.resolve({ entries: [], removed: [], stored: 0, failed: [] }); });
        expect(await s.service.tick(controller.signal)).toBe("incomplete");
        expect(s.computer.refresh).toHaveBeenCalledTimes(1);
        expect(s.index.markSwept).not.toHaveBeenCalled();
    });

    it("should report incomplete and not stamp when a batch could not be written", async () => {
        const s = setup({ list: doctors(250) });
        s.computer.refresh.mockResolvedValueOnce({ entries: [], removed: [], stored: 99, failed: [1001] });
        expect(await s.service.tick(signal())).toBe("incomplete");
        expect(s.computer.refresh).toHaveBeenCalledTimes(1);
        expect(s.index.markSwept).not.toHaveBeenCalled();
    });

    it("should report incomplete and not stamp when the member list, the removal or the stamp fails", async () => {
        const members = setup();
        members.index.members.mockResolvedValue(undefined);
        expect(await members.service.tick(signal())).toBe("incomplete");
        expect(members.index.markSwept).not.toHaveBeenCalled();
        const removal = setup();
        removal.index.members.mockResolvedValue([9999]);
        removal.index.remove.mockResolvedValue(false);
        expect(await removal.service.tick(signal())).toBe("incomplete");
        expect(removal.index.markSwept).not.toHaveBeenCalled();
        const stamp = setup();
        stamp.index.markSwept.mockResolvedValue(false);
        expect(await stamp.service.tick(signal())).toBe("incomplete");
    });

    it("should treat a truncated doctor list as incomplete: no stale removal and no stamp", async () => {
        const s = setup({ truncated: true });
        expect(await s.service.tick(signal())).toBe("incomplete");
        expect(s.index.remove).not.toHaveBeenCalled();
        expect(s.index.markSwept).not.toHaveBeenCalled();
        expect(s.logger.warn).toHaveBeenCalledWith("availability_candidates_truncated");
    });

    it("should release the lock and propagate when the database fails mid-sweep", async () => {
        const s = setup();
        s.reader.listBookableForIndex.mockRejectedValue(new Error("postgres down"));
        await expect(s.service.tick(signal())).rejects.toThrow("postgres down");
        expect(s.unlocked).toHaveBeenCalledTimes(1);
        expect(s.released).toHaveBeenCalledTimes(1);
    });
});

describe("AvailabilitySweepService name-index step (AV-R28)", () => {
    it("should rebuild the name index from the swept doctors when no build stamp exists, after stamping the sweep", async () => {
        const s = setup({ list: doctors(3) });
        expect(await s.service.tick(signal())).toBe("done");
        expect(s.names.rebuild).toHaveBeenCalledTimes(1);
        expect(s.names.rebuild).toHaveBeenCalledWith(doctors(3), expect.any(AbortSignal));
        expect(s.index.markSwept.mock.invocationCallOrder[0]).toBeLessThan(s.names.rebuild.mock.invocationCallOrder[0] ?? 0);
    });

    it("should rebuild when the stamp is exactly as old as the refresh period or older, and skip it when younger", async () => {
        const old = setup();
        old.index.readNameBuiltAt.mockImplementation(() => Promise.resolve(old.now() - 300_000));
        await old.service.tick(signal());
        expect(old.names.rebuild).toHaveBeenCalledTimes(1);
        const fresh = setup();
        fresh.index.readNameBuiltAt.mockImplementation(() => Promise.resolve(fresh.now() - 100_000));
        await fresh.service.tick(signal());
        expect(fresh.names.rebuild).not.toHaveBeenCalled();
    });

    it("should not fail the sweep when the rebuild throws: it logs availability_name_index_failed with the error class only", async () => {
        const s = setup();
        s.names.rebuild.mockRejectedValue(new TypeError("message that must not be logged"));
        expect(await s.service.tick(signal())).toBe("done");
        expect(s.logger.warn).toHaveBeenCalledWith("availability_name_index_failed", { reason: "TypeError" });
        expect(JSON.stringify(s.logger.warn.mock.calls)).not.toContain("must not be logged");
        expect(s.logger.info).toHaveBeenCalledWith("availability_sweep_done", expect.any(Object));
    });

    it("should log a failed rebuild that could not be written and still finish the sweep", async () => {
        const s = setup();
        s.names.rebuild.mockResolvedValue(NameIndexOutcome.Failed);
        expect(await s.service.tick(signal())).toBe("done");
        expect(s.logger.warn).toHaveBeenCalledWith("availability_name_index_failed", { reason: "RedisWriteFailed" });
    });

    it("should skip the rebuild and log when the stamp cannot be read, without failing the sweep", async () => {
        const s = setup();
        s.index.readNameBuiltAt.mockResolvedValue(undefined);
        expect(await s.service.tick(signal())).toBe("done");
        expect(s.names.rebuild).not.toHaveBeenCalled();
        expect(s.logger.warn).toHaveBeenCalledWith("availability_name_index_failed", { reason: "RedisUnavailable" });
    });

    it("should not touch the name index when the sweep itself is incomplete", async () => {
        const s = setup({ truncated: true });
        expect(await s.service.tick(signal())).toBe("incomplete");
        expect(s.index.readNameBuiltAt).not.toHaveBeenCalled();
        expect(s.names.rebuild).not.toHaveBeenCalled();
    });
});
