import "reflect-metadata";
import { getEnv } from "./lib/config/env";
import { createKnex } from "./lib/knex/knex";
import { runMain } from "./lib/lifecycle/run-main";
import { logger } from "./lib/logger/logger";
import { closeRedis, connectWithin, createRedis } from "./lib/redis/redis";
import { IdentityClient } from "./lib/identity-client/identity-client";
import { S3Adapter } from "./lib/storage/s3.adapter";
import { LoopRunner } from "./lib/worker/loop-runner";
import type { WorkerLoop } from "./lib/worker/types";
import { buildWorkerLoops } from "./worker-loops";

// Session advisory locks pin connections (singleton purge + per-intent/per-doctor), so keep headroom for transactions.
const WORKER_POOL_MAX = 6;
const WORKER_STATEMENT_TIMEOUT_MS = 5_000;
const ONCE_DRAIN_TIMEOUT_MS = 5_000;
/**
 * How long to wait for the worker Redis connection before the first tick runs: `--once` (a tick that needs Redis reports "incomplete" without it)
 * and the daemon (so the boot-time availability sweep finds a ready client). The loops start anyway when Redis is down.
 */
const REDIS_CONNECT_TIMEOUT_MS = 3_000;

/**
 * `node dist/worker.js --once <loop>` (runbook): exactly one tick of the named loop with a fresh AbortController, then
 * the pool is closed and the process exits — 0 on success, 1 for an unknown loop, a tick that throws, or a tick that
 * reports `"incomplete"` (e.g. audit partitions not ensured, or the lock held by another worker).
 * The exit code is set and the event loop drains on its own: `process.exit()` while sockets are still closing aborts
 * libuv on Windows (`UV_HANDLE_CLOSING` assertion). The unref'd timer only forces the exit if a handle outlives the drain.
 */
async function runOnce(name: string | undefined, loops: WorkerLoop[], connected: Promise<void>, closeAll: () => Promise<void>): Promise<void> {
    await connected;
    const loop = loops.find((candidate) => candidate.name === name);
    let code: 0 | 1 = 0;
    if (loop === undefined) {
        logger.error("worker_loop_unknown", { loop: name ?? null, loops: loops.map((candidate) => candidate.name) });
        code = 1;
    } else {
        try {
            const outcome = await loop.tick(new AbortController().signal);
            if (outcome === "incomplete") {
                logger.error("worker_once_incomplete", { loop: loop.name });
                code = 1;
            } else {
                logger.info("worker_once_completed", { loop: loop.name });
            }
        } catch (error) {
            logger.error("worker_tick_failed", { loop: loop.name, error });
            code = 1;
        }
    }
    await closeAll();
    process.exitCode = code;
    setTimeout(() => process.exit(code), ONCE_DRAIN_TIMEOUT_MS).unref();
}

/** `care-worker` (ADR 0008): all background work runs here, never in `care-api`. */
function main(): void | Promise<void> {
    const env = getEnv();
    // Its own pool as the app login (care_app), never the API's; 1 s acquire timeout (createKnex) like every
    // request-serving component. Its own Redis client too (availability loops, Identity hydration cache), never the API's.
    const workerDb = createKnex({
        url: env.DATABASE_URL,
        poolMax: WORKER_POOL_MAX,
        statementTimeoutMs: WORKER_STATEMENT_TIMEOUT_MS,
        applicationName: "care-worker",
    });
    const redis = createRedis(env.REDIS_URL, { name: "care-worker" });
    const identity = new IdentityClient({ env, redis });
    const storage = new S3Adapter({ bucket: env.STORAGE_BUCKET, region: env.STORAGE_REGION, endpoint: env.STORAGE_ENDPOINT, accessKeyId: env.STORAGE_ACCESS_KEY_ID, secretAccessKey: env.STORAGE_SECRET_ACCESS_KEY, forcePathStyle: env.STORAGE_FORCE_PATH_STYLE });
    const closeAll = async (): Promise<void> => { await identity.close(); await closeRedis(redis); await workerDb.destroy(); };
    const loops = buildWorkerLoops({ env, db: workerDb, redis, logger, storage, identity });

    const onceAt = process.argv.indexOf("--once");
    if (onceAt !== -1) {
        // Bounded wait: `--once` must not hang when Redis is down; Redis-dependent ticks then report "incomplete" (exit 1).
        return runOnce(process.argv[onceAt + 1], loops, connectWithin(redis, REDIS_CONNECT_TIMEOUT_MS), closeAll);
    }
    // Bounded wait before the first tick (below): the boot-time sweep (AV-R23) must not race the Redis handshake.
    const connected = connectWithin(redis, REDIS_CONNECT_TIMEOUT_MS, () => logger.warn("redis_unavailable"));

    const runner = new LoopRunner(loops, { logger });

    let stopping = false;
    const stop = (reason: string, exitCode: 0 | 1): void => {
        if (stopping) {
            return;
        }
        stopping = true;
        logger.info("worker_stopping", { reason });

        const timer = setTimeout(() => {
            logger.error("worker_stop_timeout");
            process.exit(1);
        }, env.SHUTDOWN_TIMEOUT_MS);

        // Stop after the current tick, then close the pool — both inside the SHUTDOWN_TIMEOUT_MS deadline.
        runner
            .stop()
            .then(() => closeAll())
            .then(() => {
                clearTimeout(timer);
                process.exit(exitCode);
            })
            .catch((error: unknown) => {
                clearTimeout(timer);
                logger.error("worker_stop_failed", { error });
                process.exit(1);
            });
    };

    for (const signal of ["SIGTERM", "SIGINT"] as const) {
        process.on(signal, () => stop(signal, 0));
    }
    process.on("uncaughtException", (error: Error) => {
        logger.error("uncaught_error", { error });
        stop("uncaught_error", 1);
    });
    process.on("unhandledRejection", (reason: unknown) => {
        logger.error("uncaught_error", { error: reason });
        stop("uncaught_error", 1);
    });

    // Handlers are registered before `worker_started` is logged: a supervisor (or a test) that signals on seeing the
    // line must never hit the default SIGTERM action.
    return connected.then(() => {
        if (stopping) {
            return;
        }
        runner.start();
        logger.info("worker_started", { loops: loops.map((loop) => loop.name) });
    });
}

runMain(main);
