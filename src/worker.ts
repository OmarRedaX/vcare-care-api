import "reflect-metadata";
import { getEnv } from "./lib/config/env";
import { runMain } from "./lib/lifecycle/run-main";
import { logger } from "./lib/logger/logger";
import { LoopRunner } from "./lib/worker/loop-runner";
import { buildWorkerLoops } from "./worker-loops";

/** `care-worker` (ADR 0008): all background work runs here, never in `care-api`. */
function main(): void {
    const env = getEnv();
    const loops = buildWorkerLoops();
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

        runner
            .stop()
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
