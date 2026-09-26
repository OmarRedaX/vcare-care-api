import type http from "node:http";
import { createGracefulShutdown } from "../../../../src/lib/lifecycle/graceful-shutdown";
import { InFlightCounter } from "../../../../src/lib/lifecycle/in-flight";
import { ShutdownState } from "../../../../src/lib/lifecycle/shutdown-state";
import { Logger } from "../../../../src/lib/logger/logger";

/** Records every lifecycle step in one ordered list so sequencing can be asserted. */
function setup(options: { closeDelayMs?: number; failDb?: boolean; timeoutMs?: number } = {}) {
    const events: string[] = [];
    const lines: Array<Record<string, unknown>> = [];
    const logger = new Logger({
        level: "debug",
        service: "care-service",
        write: (line) => {
            const parsed = JSON.parse(line) as Record<string, unknown>;
            lines.push(parsed);
            events.push(`log:${String(parsed.message)}`);
        },
    });

    const state = new ShutdownState();
    const originalMark = state.markShuttingDown.bind(state);
    jest.spyOn(state, "markShuttingDown").mockImplementation(() => {
        events.push("markShuttingDown");
        originalMark();
    });

    const server = (name: string) => ({
        close: jest.fn((callback: () => void) => {
            events.push(`${name}.close`);
            if (options.closeDelayMs === undefined) {
                callback();
            } else {
                setTimeout(callback, options.closeDelayMs);
            }
        }),
        closeIdleConnections: jest.fn(() => events.push(`${name}.closeIdle`)),
        closeAllConnections: jest.fn(() => events.push(`${name}.closeAll`)),
    });
    const publicServer = server("public");
    const internalServer = server("internal");

    const inFlight = new InFlightCounter();
    const exit = jest.fn((code: number) => events.push(`exit:${code}`));

    const shutdown = createGracefulShutdown({
        servers: [publicServer, internalServer] as unknown as http.Server[],
        state,
        inFlight,
        timeoutMs: options.timeoutMs ?? 2_000,
        closeResources: [
            () => {
                events.push("db.destroy");
                return options.failDb === true ? Promise.reject(new Error("synthetic destroy failure")) : Promise.resolve();
            },
            () => {
                events.push("redis.quit");
                return Promise.resolve();
            },
        ],
        logger,
        exit,
    });

    return { shutdown, events, lines, state, inFlight, exit, publicServer, internalServer };
}

describe("lib/lifecycle/createGracefulShutdown", () => {
    afterEach(() => {
        jest.useRealTimers();
        jest.restoreAllMocks();
    });

    it("should mark not-ready before closing listeners (F19)", async () => {
        const { shutdown, events, state } = setup();
        await shutdown("SIGTERM");
        expect(state.isShuttingDown()).toBe(true);
        expect(events.indexOf("markShuttingDown")).toBeLessThan(events.indexOf("public.close"));
        expect(events.indexOf("markShuttingDown")).toBeLessThan(events.indexOf("internal.close"));
    });

    it("should close both listeners before destroying Knex and quitting Redis (F19)", async () => {
        const { shutdown, events, publicServer, internalServer } = setup();
        await shutdown("SIGTERM");

        expect(publicServer.closeIdleConnections).toHaveBeenCalled();
        expect(internalServer.closeIdleConnections).toHaveBeenCalled();
        expect(events).toEqual([
            "markShuttingDown",
            "log:shutdown_started",
            "public.close",
            "public.closeIdle",
            "internal.close",
            "internal.closeIdle",
            "db.destroy",
            "redis.quit",
            "log:shutdown_complete",
            "exit:0",
        ]);
    });

    it("should wait for the in-flight counter to reach zero when requests are running (F19)", async () => {
        jest.useFakeTimers();
        const { shutdown, events, inFlight } = setup();
        inFlight.increment();

        const done = shutdown("SIGTERM");
        await jest.advanceTimersByTimeAsync(1_000);
        expect(events).not.toContain("db.destroy");

        inFlight.decrement();
        await jest.advanceTimersByTimeAsync(0);
        await done;
        expect(events).toContain("db.destroy");
        expect(events.at(-1)).toBe("exit:0");
    });

    it("should wait for both close callbacks when listeners close slowly", async () => {
        jest.useFakeTimers();
        const { shutdown, events } = setup({ closeDelayMs: 500 });
        const done = shutdown("SIGTERM");
        await jest.advanceTimersByTimeAsync(499);
        expect(events).not.toContain("db.destroy");
        await jest.advanceTimersByTimeAsync(1);
        await done;
        expect(events.at(-1)).toBe("exit:0");
    });

    it("should exit 0 when drained before the deadline (F19)", async () => {
        const { shutdown, exit, lines } = setup();
        await shutdown("SIGINT");
        expect(exit).toHaveBeenCalledTimes(1);
        expect(exit).toHaveBeenCalledWith(0);
        expect(lines.find((line) => line.message === "shutdown_started")?.reason).toBe("SIGINT");
        expect(lines.some((line) => line.message === "shutdown_timeout")).toBe(false);
    });

    it("should exit 1 when the caller passes exitCode 1 (uncaught error)", async () => {
        const { shutdown, exit } = setup();
        await shutdown("uncaught_error", 1);
        expect(exit).toHaveBeenCalledWith(1);
    });

    it("should log unfinishedRequests, force-close connections, and exit 1 when the deadline passes (F19)", async () => {
        jest.useFakeTimers();
        const { shutdown, events, lines, inFlight, exit, publicServer, internalServer } = setup({ timeoutMs: 2_000 });
        inFlight.increment();
        inFlight.increment();

        const done = shutdown("SIGTERM");
        await jest.advanceTimersByTimeAsync(2_000);
        await done;

        const timeoutLine = lines.find((line) => line.message === "shutdown_timeout");
        expect(timeoutLine).toMatchObject({ level: "error", unfinishedRequests: 2 });
        expect(publicServer.closeAllConnections).toHaveBeenCalled();
        expect(internalServer.closeAllConnections).toHaveBeenCalled();
        expect(events.indexOf("public.closeAll")).toBeLessThan(events.indexOf("db.destroy"));
        expect(exit).toHaveBeenCalledWith(1);
    });

    it("should return the same promise when called twice", async () => {
        const { shutdown, exit, events } = setup();
        const first = shutdown("SIGTERM");
        const second = shutdown("SIGINT", 1);
        expect(second).toBe(first);
        await first;
        expect(exit).toHaveBeenCalledTimes(1);
        expect(exit).toHaveBeenCalledWith(0);
        expect(events.filter((event) => event === "db.destroy")).toHaveLength(1);
    });

    it("should continue closing resources when one fails", async () => {
        const { shutdown, events, lines, exit } = setup({ failDb: true });
        await shutdown("SIGTERM");
        expect(events).toContain("redis.quit");
        const failure = lines.find((line) => line.message === "shutdown_resource_failed");
        expect(failure?.level).toBe("error");
        expect((failure?.error as { message: string }).message).toBe("synthetic destroy failure");
        expect(exit).toHaveBeenCalledWith(0);
    });
});
