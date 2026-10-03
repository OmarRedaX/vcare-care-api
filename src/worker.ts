import "reflect-metadata";
import type { Knex } from "knex";
import { getEnv } from "./lib/config/env";
import { createKnex } from "./lib/knex/knex";
import { runMain } from "./lib/lifecycle/run-main";
import { logger } from "./lib/logger/logger";
import { LoopRunner } from "./lib/worker/loop-runner";
import type { WorkerLoop } from "./lib/worker/types";
import { buildWorkerLoops } from "./worker-loops";

const WORKER_POOL_MAX = 2;
const WORKER_STATEMENT_TIMEOUT_MS = 5_000;

/**
 * `node dist/worker.js --once <loop>` (runbook): exactly one tick of the named loop with a fresh AbortController, then
 * the pool is closed and the process exits — 0 on success, 1 for an unknown loop, a tick that throws, or a tick that
 * reports `"incomplete"` (e.g. audit partitions not ensured, or the lock held by another worker).
 */
async function runOnce(name: string | undefined, loops: WorkerLoop[], workerDb: Knex): Promise<never> {
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
    await workerDb.destroy();
    process.exit(code);
}

/** `care-worker` (ADR 0008): all background work runs here, never in `care-api`. */
function main(): void | Promise<void> {
    const env = getEnv();
    // Its own pool as the app login (care_app), never the API's; 1 s acquire timeout (createKnex) like every
    // request-serving component. No Redis yet.
    const workerDb = createKnex({
        url: env.DATABASE_URL,
        poolMax: WORKER_POOL_MAX,
        statementTimeoutMs: WORKER_STATEMENT_TIMEOUT_MS,
        applicationName: "care-worker",
    });
    const loops = buildWorkerLoops({ env, db: workerDb, logger });

    const onceAt = process.argv.indexOf("--once");
    if (onceAt !== -1) {
        return runOnce(process.argv[onceAt + 1], loops, workerDb).then(() => undefined);
    }

    const runner = new LoopRunner(loops, { logger });

    runner.start();
    logger.info("worker_started", { loops: loops.map((loop) => loop.name) });

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
            .then(() => workerDb.destroy())
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
}

runMain(main);
