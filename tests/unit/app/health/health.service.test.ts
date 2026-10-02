import type Redis from "ioredis";
import type { Knex } from "knex";
import { HealthController } from "../../../../src/app/health/controller/health.controller";
import { LiveResponseDto, ReadyResponseDto } from "../../../../src/app/health/dto/health.response.dto";
import { HealthStatus, ProbeStatus } from "../../../../src/app/health/enums";
import { HealthService } from "../../../../src/app/health/service/health.service";
import { ShutdownState } from "../../../../src/lib/lifecycle/shutdown-state";

type ProbeBehaviour = "up" | "down" | "hang";

function fakeDb(behaviour: ProbeBehaviour): Knex {
    const raw = jest.fn(() => {
        if (behaviour === "up") {
            return Promise.resolve({ rows: [] });
        }
        if (behaviour === "down") {
            return Promise.reject(new Error("ECONNREFUSED"));
        }
        return new Promise(() => undefined);
    });
    return { raw } as unknown as Knex;
}

function fakeRedis(behaviour: ProbeBehaviour | "not-ready"): Redis {
    return {
        status: behaviour === "not-ready" ? "reconnecting" : "ready",
        ping: jest.fn(() => {
            if (behaviour === "up") {
                return Promise.resolve("PONG");
            }
            if (behaviour === "down") {
                return Promise.reject(new Error("down"));
            }
            return new Promise(() => undefined);
        }),
    } as unknown as Redis;
}

function service(db: ProbeBehaviour, redis: ProbeBehaviour | "not-ready", shuttingDown = false): HealthService {
    const state = new ShutdownState();
    if (shuttingDown) {
        state.markShuttingDown();
    }
    return new HealthService(fakeDb(db), fakeRedis(redis), state);
}

describe("app/health/HealthService", () => {
    afterEach(() => {
        jest.useRealTimers();
    });

    it("should return ok and 200 when both probes are up (F10)", async () => {
        await expect(service("up", "up").ready()).resolves.toEqual({
            httpStatus: 200,
            report: { status: "ok", checks: { database: "up", redis: "up" } },
        });
    });

    it.each(["down", "not-ready"] as const)("should return degraded and 200 when Redis is %s (F10)", async (redis) => {
        await expect(service("up", redis).ready()).resolves.toEqual({
            httpStatus: 200,
            report: { status: "degraded", checks: { database: "up", redis: "down" } },
        });
    });

    it("should return down and 503 when Postgres is down (F10)", async () => {
        await expect(service("down", "up").ready()).resolves.toEqual({
            httpStatus: 503,
            report: { status: "down", checks: { database: "down", redis: "up" } },
        });
    });

    it("should return down and 503 with both checks down when both dependencies are down", async () => {
        await expect(service("down", "down").ready()).resolves.toEqual({
            httpStatus: 503,
            report: { status: "down", checks: { database: "down", redis: "down" } },
        });
    });

    it("should return down and 503 when shutting down even if both are up (F10)", async () => {
        await expect(service("up", "up", true).ready()).resolves.toEqual({
            httpStatus: 503,
            report: { status: "down", checks: { database: "up", redis: "up" } },
        });
    });

    it("should count a probe as down when it exceeds 500 ms", async () => {
        jest.useFakeTimers();
        const pending = service("hang", "hang").ready();

        await jest.advanceTimersByTimeAsync(499);
        let settled = false;
        void pending.then(() => {
            settled = true;
        });
        await Promise.resolve();
        expect(settled).toBe(false);

        await jest.advanceTimersByTimeAsync(1);
        await expect(pending).resolves.toEqual({
            httpStatus: 503,
            report: { status: "down", checks: { database: "down", redis: "down" } },
        });
    });

    it("should run both probes concurrently so a hanging dependency costs at most one timeout", async () => {
        jest.useFakeTimers();
        const pending = service("hang", "up").ready();
        await jest.advanceTimersByTimeAsync(500);
        await expect(pending).resolves.toMatchObject({ httpStatus: 503, report: { checks: { redis: "up" } } });
    });

    it("should return ok for live when shutting down (F9)", () => {
        expect(service("down", "down", true).live()).toEqual({ status: "ok" });
    });
});

describe("app/health DTOs and controller", () => {
    it("should copy only status and checks when building the ready DTO", () => {
        const report = {
            status: HealthStatus.Ok,
            checks: { database: ProbeStatus.Up, redis: ProbeStatus.Up, extra: "leak" },
            internal: "leak",
        };
        const dto = ReadyResponseDto.from(report);
        expect(JSON.parse(JSON.stringify(dto))).toEqual({ status: "ok", checks: { database: "up", redis: "up" } });
        expect(JSON.parse(JSON.stringify(LiveResponseDto.from({ status: HealthStatus.Ok })))).toEqual({ status: "ok" });
    });

    it("should send the readiness status code and no-store when ready is called", async () => {
        const controller = new HealthController(service("down", "up"));
        const res = { setHeader: jest.fn(), status: jest.fn(), json: jest.fn() };
        res.status.mockReturnValue(res);

        await controller.ready({} as never, res as never);

        expect(res.setHeader).toHaveBeenCalledWith("Cache-Control", "no-store");
        expect(res.status).toHaveBeenCalledWith(503);
        expect(JSON.parse(JSON.stringify(res.json.mock.calls[0]?.[0]))).toEqual({
            status: "down",
            checks: { database: "down", redis: "up" },
        });
    });
});
