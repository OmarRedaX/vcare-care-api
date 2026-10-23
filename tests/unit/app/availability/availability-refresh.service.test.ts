// Rules covered: AV-R24 (refresh drain, requeue on failure, bookable filter), spec 7.2 / 12.2.7 (queue depth and sweep age gauges, throttled).
import { AvailabilityRefreshService } from "../../../../src/app/availability/service/availability-refresh.service";
import type { NextAvailableComputer } from "../../../../src/app/availability/service/next-available.computer";
import type { NextAvailableIndex } from "../../../../src/app/availability/service/next-available.index";
import type { DoctorDiscoveryReader } from "../../../../src/app/doctors/service/doctor-discovery.reader";
import type { Logger } from "../../../../src/lib/logger/logger";

function setup(now = { value: 1_800_000_000_000 }) {
    const index = {
        isUsable: jest.fn(() => true),
        popRefresh: jest.fn(),
        requeue: jest.fn().mockResolvedValue(true),
        refreshDepth: jest.fn().mockResolvedValue(3),
        readSweptAt: jest.fn().mockResolvedValue(now.value - 90_000),
    };
    const reader = { listBookableForIndex: jest.fn((ids: readonly number[]) => Promise.resolve({ items: ids.map((userId) => ({ profileId: userId, userId, timezone: "UTC" })), truncated: false })) };
    const computer = { refresh: jest.fn().mockResolvedValue({ entries: [], removed: [], stored: 0, failed: [] }) };
    const logger = { info: jest.fn(), metric: jest.fn(), warn: jest.fn() };
    const service = new AvailabilityRefreshService(reader as unknown as DoctorDiscoveryReader, computer as unknown as NextAvailableComputer,
        index as unknown as NextAvailableIndex, logger as unknown as Logger, { now: () => now.value });
    return { service, index, reader, computer, logger, now };
}
const signal = (): AbortSignal => new AbortController().signal;

describe("AvailabilityRefreshService.tick (AV-R24)", () => {
    it("should do nothing and report incomplete when Redis is unusable", async () => {
        const s = setup();
        s.index.isUsable.mockReturnValue(false);
        expect(await s.service.tick(signal())).toBe("incomplete");
        expect(s.index.popRefresh).not.toHaveBeenCalled();
    });

    it("should pop 50 at a time, recompute only the still-bookable doctors and stop at an empty pop", async () => {
        const s = setup();
        s.index.popRefresh.mockResolvedValueOnce([1, 2]).mockResolvedValueOnce([]);
        expect(await s.service.tick(signal())).toBe("done");
        expect(s.index.popRefresh).toHaveBeenNthCalledWith(1, 50);
        expect(s.reader.listBookableForIndex).toHaveBeenCalledWith([1, 2]);
        expect(s.computer.refresh).toHaveBeenCalledTimes(1);
        expect(s.logger.info).toHaveBeenCalledWith("availability_refresh_done", { doctors: 2 });
    });

    it("should drain at most ten batches per tick", async () => {
        const s = setup();
        s.index.popRefresh.mockResolvedValue([1]);
        await s.service.tick(signal());
        expect(s.index.popRefresh).toHaveBeenCalledTimes(10);
    });

    it("should stay quiet when there was nothing to refresh", async () => {
        const s = setup();
        s.index.popRefresh.mockResolvedValue([]);
        await s.service.tick(signal());
        expect(s.logger.info).not.toHaveBeenCalled();
        expect(s.computer.refresh).not.toHaveBeenCalled();
    });

    it("should drop a doctor who is no longer bookable instead of writing it", async () => {
        const s = setup();
        s.index.popRefresh.mockResolvedValueOnce([1, 2]).mockResolvedValueOnce([]);
        s.reader.listBookableForIndex.mockResolvedValue({ items: [{ profileId: 2, userId: 2, timezone: "UTC" }], truncated: false });
        await s.service.tick(signal());
        expect((s.computer.refresh.mock.calls[0]?.[0] as Array<{ userId: number }>).map((item) => item.userId)).toEqual([2]);
    });

    it("should put the ids that could not be written back into the refresh set and report incomplete", async () => {
        const s = setup();
        s.index.popRefresh.mockResolvedValueOnce([1, 2]).mockResolvedValueOnce([]);
        s.computer.refresh.mockResolvedValue({ entries: [], removed: [], stored: 1, failed: [2] });
        expect(await s.service.tick(signal())).toBe("incomplete");
        expect(s.index.requeue).toHaveBeenCalledWith([2]);
    });

    it("should requeue the popped ids and rethrow when the computation fails", async () => {
        const s = setup();
        s.index.popRefresh.mockResolvedValueOnce([1, 2]);
        s.computer.refresh.mockRejectedValue(new Error("postgres down"));
        await expect(s.service.tick(signal())).rejects.toThrow("postgres down");
        expect(s.index.requeue).toHaveBeenCalledWith([1, 2]);
    });

    it("should report incomplete when the pop itself fails", async () => {
        const s = setup();
        s.index.popRefresh.mockResolvedValue(undefined);
        expect(await s.service.tick(signal())).toBe("incomplete");
    });

    it("should stop between batches when aborted", async () => {
        const s = setup();
        const controller = new AbortController();
        s.index.popRefresh.mockImplementation(() => { controller.abort(); return Promise.resolve([1]); });
        await s.service.tick(controller.signal);
        expect(s.index.popRefresh).toHaveBeenCalledTimes(1);
    });

    it("should emit the queue depth and sweep age at most every 30 seconds, omitting the age when never stamped", async () => {
        const s = setup();
        s.index.popRefresh.mockResolvedValue([]);
        await s.service.tick(signal());
        expect(s.logger.metric).toHaveBeenCalledWith("availability_refresh_queue_depth", 3);
        expect(s.logger.metric).toHaveBeenCalledWith("availability_sweep_age_s", 90);
        s.logger.metric.mockClear();
        s.now.value += 29_000;
        await s.service.tick(signal());
        expect(s.logger.metric).not.toHaveBeenCalled();
        s.now.value += 2_000;
        s.index.readSweptAt.mockResolvedValue(null);
        await s.service.tick(signal());
        expect(s.logger.metric).toHaveBeenCalledWith("availability_refresh_queue_depth", 3);
        expect(s.logger.metric).not.toHaveBeenCalledWith("availability_sweep_age_s", expect.anything());
    });
});
