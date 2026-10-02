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
import { buildAccessTestRouter } from "../tests/helpers/test-routers";

function main(): void {
    const env = getEnv();
    if (env.NODE_ENV === "production") {
        logger.error("access_qa_server_refused", { reason: "NODE_ENV is production" });
        process.exit(1);
    }

    registerDependencies(env);
    container.resolve<JwksCache>(TOKENS.JwksCache).start();

    const app = createPublicApp({ extraRouters: [{ path: "/api", router: buildAccessTestRouter() }] });
    app.listen(env.PORT, "127.0.0.1", () => {
        logger.info("access_qa_server_started", { port: env.PORT });
    });
}

runMain(main);
