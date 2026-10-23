// Rules covered: AV-R23/AV-R24/AV-R25 (loop names and intervals, worker Redis in the loop deps).
import type { Knex } from "knex";
import type Redis from "ioredis";
import { buildAvailabilityRefreshLoop, buildAvailabilitySweepLoop } from "../../../../src/app/availability/worker/availability.loops";
import { getEnv } from "../../../../src/lib/config/env";
import type { IdentityClient } from "../../../../src/lib/identity-client/identity-client";
import type { Logger } from "../../../../src/lib/logger/logger";
import type { ObjectStorage } from "../../../../src/lib/storage/object-storage";
import type { WorkerLoopDeps } from "../../../../src/lib/worker/types";
import { buildWorkerLoops } from "../../../../src/worker-loops";

describe("availability loop builders", () => {
    it("should build availability-refresh at a 2000 ms interval that delegates its tick", async () => {
        const tick = jest.fn().mockResolvedValue("done");
        const loop = buildAvailabilityRefreshLoop({ service: { tick } });
        const signal = new AbortController().signal;
        expect(loop).toMatchObject({ name: "availability-refresh", intervalMs: 2000 });
        await expect(loop.tick(signal)).resolves.toBe("done");
        expect(tick).toHaveBeenCalledWith(signal);
    });

    it("should build availability-sweep at the configured number of seconds and pass an incomplete outcome through", async () => {
        const loop = buildAvailabilitySweepLoop({ service: { tick: jest.fn().mockResolvedValue("incomplete") }, intervalSeconds: 120 });
        expect(loop).toMatchObject({ name: "availability-sweep", intervalMs: 120_000 });
        await expect(loop.tick(new AbortController().signal)).resolves.toBe("incomplete");
    });
});

describe("buildWorkerLoops with the worker Redis client (AV-R25)", () => {
    const env = { ...getEnv(), AVAILABILITY_SWEEP_INTERVAL_SECONDS: 45 };
    const deps: WorkerLoopDeps = { env, db: {} as Knex, redis: {} as Redis, logger: {} as Logger, storage: {} as ObjectStorage, identity: {} as IdentityClient };

    it("should register both availability loops after the existing ones, with the env sweep interval", () => {
        const loops = buildWorkerLoops(deps);
        const names = loops.map((loop) => loop.name);
        expect(names).toEqual(expect.arrayContaining(["availability-refresh", "availability-sweep"]));
        expect(names.slice(-2)).toEqual(["availability-refresh", "availability-sweep"]);
        expect(new Set(names).size).toBe(names.length);
        expect(loops.find((loop) => loop.name === "availability-refresh")?.intervalMs).toBe(2000);
        expect(loops.find((loop) => loop.name === "availability-sweep")?.intervalMs).toBe(45_000);
    });
});
