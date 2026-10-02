import "reflect-metadata";
import type http from "node:http";
import { createPublicApp } from "./app";
import { registerDependencies } from "./bootstrap";
import { getEnv } from "./lib/config/env";
import { container } from "./lib/di/container";
import { TOKENS } from "./lib/di/tokens";
import { createInternalApp } from "./internal-app";
import { db, probeDb } from "./lib/knex/knex";
import { createGracefulShutdown } from "./lib/lifecycle/graceful-shutdown";
import type { InFlightCounter } from "./lib/lifecycle/in-flight";
import { runMain } from "./lib/lifecycle/run-main";
import type { ShutdownState } from "./lib/lifecycle/shutdown-state";
import { logger } from "./lib/logger/logger";
import { closeRedis, redis } from "./lib/redis/redis";

const KEEP_ALIVE_TIMEOUT_MS = 65_000;
const HEADERS_TIMEOUT_MS = 66_000;
const REQUEST_TIMEOUT_MS = 30_000;

function applyTimeouts(server: http.Server): http.Server {
    server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
    server.headersTimeout = HEADERS_TIMEOUT_MS;
    server.requestTimeout = REQUEST_TIMEOUT_MS;
    server.on("error", (error: Error) => {
        logger.error("server_listen_failed", { error });
        process.exit(1);
    });
    return server;
}

function main(): void {
    const env = getEnv();
    registerDependencies(env);

    // Redis is Tier 2: connect in the background, never block or fail boot on it.
    redis.connect().catch(() => {
        logger.warn("redis_unavailable");
    });
    // Postgres is deliberately NOT checked at boot — readiness reports it, so a blip cannot restart-loop tasks.

    const publicServer = applyTimeouts(createPublicApp().listen(env.PORT, "0.0.0.0"));
    const internalServer = applyTimeouts(createInternalApp().listen(env.INTERNAL_PORT, env.INTERNAL_HOST));

    logger.info("server_started", { port: env.PORT, internalPort: env.INTERNAL_PORT });

    const shutdown = createGracefulShutdown({
        servers: [publicServer, internalServer],
        state: container.resolve<ShutdownState>(TOKENS.ShutdownState),
        inFlight: container.resolve<InFlightCounter>(TOKENS.InFlightCounter),
        timeoutMs: env.SHUTDOWN_TIMEOUT_MS,
        closeResources: [
            () => db.destroy(),
            () => probeDb.destroy(),
            () => closeRedis(redis),
        ],
        logger,
        exit: (code: number) => process.exit(code),
    });

    let shuttingDown = false;
    for (const signal of ["SIGTERM", "SIGINT"] as const) {
        process.on(signal, () => {
            if (shuttingDown) {
                logger.warn("shutdown_forced", { signal });
                process.exit(1);
            }
            shuttingDown = true;
            void shutdown(signal);
        });
    }

    process.on("uncaughtException", (error: Error) => {
        logger.error("uncaught_error", { error });
        void shutdown("uncaught_error", 1);
    });
    process.on("unhandledRejection", (reason: unknown) => {
        logger.error("uncaught_error", { error: reason });
        void shutdown("uncaught_error", 1);
    });
}

runMain(main);
