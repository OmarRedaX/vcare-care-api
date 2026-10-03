/**
 * DEV-ONLY manual-QA harness for the access unit (access spec §3.11, §9.7). Serves the real public app plus the
 * test-only `/api/__test/access/*` routes, verifying REAL Identity tokens against IDENTITY_JWKS_URL — without ever
 * mounting test routes in src/routes.ts. Refuses NODE_ENV=production. `scripts/` is excluded from the Docker image.
 *
 *   npx tsx --env-file-if-exists=.env scripts/access-qa-server.ts
 */
import "reflect-metadata";
import { createPublicApp } from "../src/app";
import { registerDependencies } from "../src/bootstrap";
import type { JwksCache } from "../src/lib/auth/jwks-cache";
import { getEnv } from "../src/lib/config/env";
import { container } from "../src/lib/di/container";
import { TOKENS } from "../src/lib/di/tokens";
import { runMain } from "../src/lib/lifecycle/run-main";
import { logger } from "../src/lib/logger/logger";
import { redis } from "../src/lib/redis/redis";
import {
    buildAccessTestRouter,
    buildAuditTestRouter,
    buildIdempotencyRouter,
    buildNestedRouter,
    buildParamRouter,
    buildRateLimitRouter,
} from "../tests/helpers/test-routers";

function main(): void {
    const env = getEnv();
    if (env.NODE_ENV === "production") {
        logger.error("access_qa_server_refused", { reason: "NODE_ENV is production" });
        process.exit(1);
    }

    registerDependencies(env);
    container.resolve<JwksCache>(TOKENS.JwksCache).start();
    // Same as server.ts: the client is lazyConnect, so connect in the background (Redis is Tier 2).
    redis.connect().catch(() => {
        logger.warn("redis_unavailable");
    });

    // Test-only routers of access spec §9.3 plus the §12 regression routers (#5 params, #6 nested, #10/#11
    // idempotency + rate limit) so scripts/curl-test-access.sh can reach every behaviour over real HTTP.
    const app = createPublicApp({
        extraRouters: [
            { path: "/api", router: buildAccessTestRouter() },
            { path: "/api", router: buildAuditTestRouter() },
            { path: "/api", router: buildParamRouter() },
            { path: "/api", router: buildNestedRouter() },
            { path: "/api", router: buildIdempotencyRouter() },
            { path: "/api", router: buildRateLimitRouter("qa-limited", 3, 1_000) },
        ],
    });
    app.listen(env.PORT, "127.0.0.1", () => {
        logger.info("access_qa_server_started", { port: env.PORT });
    });
}

runMain(main);
