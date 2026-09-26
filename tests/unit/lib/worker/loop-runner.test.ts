import { Logger } from "../../../../src/lib/logger/logger";
import { LoopRunner } from "../../../../src/lib/worker/loop-runner";
import type { WorkerLoop } from "../../../../src/lib/worker/types";

function collectingLogger() {
    const lines: Array<Record<string, unknown>> = [];
    const logger = new Logger({
        level: "warn",
        service: "care-service",
        write: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
    });
    return { logger, lines };
}

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

describe("lib/worker/LoopRunner", () => {
    beforeEach(() => {
        jest.useFakeTimers();
    });
    afterEach(() => {
        jest.useRealTimers();
    });

    it("should run a loop's tick on its interval when started", async () => {
        const { logger } = collectingLogger();
        const tick = jest.fn(() => Promise.resolve());
        const runner = new LoopRunner([{ name: "outbox", intervalMs: 1_000, tick }], { logger });

        runner.start();
        await jest.advanceTimersByTimeAsync(0);
        expect(tick).toHaveBeenCalledTimes(1);

        await jest.advanceTimersByTimeAsync(999);
        expect(tick).toHaveBeenCalledTimes(1);
        await jest.advanceTimersByTimeAsync(1);
        expect(tick).toHaveBeenCalledTimes(2);
        await jest.advanceTimersByTimeAsync(3_000);
        expect(tick).toHaveBeenCalledTimes(5);

        await runner.stop();
    });

    it("should be idempotent when start is called twice", async () => {
        const { logger } = collectingLogger();
        const tick = jest.fn(() => Promise.resolve());
        const runner = new LoopRunner([{ name: "a", intervalMs: 1_000, tick }], { logger });
        runner.start();
        runner.start();
        await jest.advanceTimersByTimeAsync(0);
        expect(tick).toHaveBeenCalledTimes(1);
        await runner.stop();
    });

    it("should never overlap ticks of the same loop when a tick is slower than the interval", async () => {
        const { logger } = collectingLogger();
        let running = 0;
        let maxConcurrent = 0;
        const loop: WorkerLoop = {
            name: "slow",
            intervalMs: 10,
            tick: async () => {
                running += 1;
                maxConcurrent = Math.max(maxConcurrent, running);
                await new Promise((resolve) => setTimeout(resolve, 100));
                running -= 1;
            },
        };
        const runner = new LoopRunner([loop], { logger });
        runner.start();
        await jest.advanceTimersByTimeAsync(1_000);
        const stopping = runner.stop();
        await jest.advanceTimersByTimeAsync(100); // let the tick in progress finish
        await stopping;
        expect(maxConcurrent).toBe(1);
    });

    it("should keep running when a tick throws and log worker_tick_failed", async () => {
        const { logger, lines } = collectingLogger();
        const tick = jest
            .fn<Promise<void>, [AbortSignal]>()
            .mockRejectedValueOnce(new Error("synthetic tick failure"))
            .mockResolvedValue(undefined);
        const runner = new LoopRunner([{ name: "reminders", intervalMs: 100, tick }], { logger });

        runner.start();
        await jest.advanceTimersByTimeAsync(0);
        await jest.advanceTimersByTimeAsync(100);
        expect(tick).toHaveBeenCalledTimes(2);

        const failure = lines.find((line) => line.message === "worker_tick_failed");
        expect(failure).toMatchObject({ level: "error", loop: "reminders" });
        expect((failure?.error as { message: string }).message).toBe("synthetic tick failure");
        await runner.stop();
    });

    it("should resolve stop only after the current tick finishes (F20)", async () => {
        const { logger } = collectingLogger();
        const gate = deferred();
        const signals: AbortSignal[] = [];
        const tick = jest.fn((signal: AbortSignal) => {
            signals.push(signal);
            return gate.promise;
        });
        const runner = new LoopRunner([{ name: "batch", intervalMs: 1_000, tick }], { logger });

        runner.start();
        await jest.advanceTimersByTimeAsync(0);

        let stopped = false;
        const stopping = runner.stop().then(() => {
            stopped = true;
        });
        await jest.advanceTimersByTimeAsync(5_000);
        expect(stopped).toBe(false);
        expect(signals[0]?.aborted).toBe(true); // the running tick is told to wrap up

        gate.resolve();
        await stopping;
        expect(stopped).toBe(true);
        expect(tick).toHaveBeenCalledTimes(1); // no new tick after stop
    });

    it("should wake a sleeping loop immediately when stop is called (F20)", async () => {
        const { logger } = collectingLogger();
        const tick = jest.fn(() => Promise.resolve());
        const runner = new LoopRunner([{ name: "idle", intervalMs: 60_000, tick }], { logger });

        runner.start();
        await jest.advanceTimersByTimeAsync(0);
        expect(tick).toHaveBeenCalledTimes(1);

        let stopped = false;
        const stopping = runner.stop().then(() => {
            stopped = true;
        });
        await jest.advanceTimersByTimeAsync(0);
        await stopping;
        expect(stopped).toBe(true);
        expect(tick).toHaveBeenCalledTimes(1);
    });

    it("should emit a runner heartbeat when there are no loops", async () => {
        const { logger, lines } = collectingLogger();
        const runner = new LoopRunner([], { logger, heartbeatEveryMs: 1_000 });

        runner.start();
        await jest.advanceTimersByTimeAsync(3_000);
        await runner.stop();
        await jest.advanceTimersByTimeAsync(5_000);

        const heartbeats = lines.filter((line) => line.message === "metric" && line.metric === "worker_heartbeat");
        expect(heartbeats).toHaveLength(3);
        expect(heartbeats[0]).toMatchObject({ level: "info", value: 1, dims: { loop: "runner" } });
    });

    it("should emit a loop heartbeat at most once per heartbeatEveryMs after completed ticks", async () => {
        const { logger, lines } = collectingLogger();
        const runner = new LoopRunner([{ name: "fast", intervalMs: 100, tick: () => Promise.resolve() }], {
            logger,
            heartbeatEveryMs: 1_000,
        });

        runner.start();
        await jest.advanceTimersByTimeAsync(2_050);
        await runner.stop();

        const loopBeats = lines.filter(
            (line) => line.metric === "worker_heartbeat" && (line.dims as { loop: string }).loop === "fast",
        );
        expect(loopBeats).toHaveLength(3); // t=0, t=1000, t=2000
    });

    it("should resolve stop immediately when the runner was never started", async () => {
        const { logger } = collectingLogger();
        await expect(new LoopRunner([], { logger }).stop()).resolves.toBeUndefined();
    });
});
