import express from "express";
import helmet from "helmet";
import { buildHealthRouter } from "./app/health/routes";
import { getEnv } from "./lib/config/env";
import { errorHandler } from "./lib/error/errorHandler";
import { notFound, optionsNotFound } from "./lib/error/not-found";
import { cors } from "./lib/http/cors";
import type { AppOptions } from "./lib/http/types";
import { inFlight } from "./lib/lifecycle/in-flight";
import { requestLogger } from "./lib/logger/request-logger";
import { assertRoutesAuthorized } from "./lib/rbac/assert-routes-authorized";
import { markPreAuth } from "./lib/rbac/markers";
import { requestId } from "./lib/request-id/request-id";
import { buildPublicRoutes } from "./routes";

/** The public listener (`/api/*` on PORT). */
export function createPublicApp(options?: AppOptions): express.Express {
    const env = getEnv();
    const app = express();

    app.disable("x-powered-by");
    // Express `trust proxy` stays OFF on purpose: client IPs come only from `clientIp(req)`, so there is one IP rule.

    app.use(requestId());
    app.use(inFlight());
    app.use(requestLogger());
    app.use(markPreAuth(helmet()));

    if (env.NODE_ENV === "development" && env.CORS_ORIGINS.length > 0) {
        app.use(cors({ origins: env.CORS_ORIGINS }));
    }
    app.use(optionsNotFound);

    app.use(markPreAuth(express.json({ limit: "100kb", strict: true, type: "application/json" })));

    app.use("/api/health", buildHealthRouter());
    app.use("/api", buildPublicRoutes());
    // Fail closed at boot: every route needs a guard before authorize(policy); health is exempt by marker. Test-only
    // routers (extraRouters) are mounted after the check and never exist in production (access spec §3.2).
    assertRoutesAuthorized(app.router);
    for (const mounted of options?.extraRouters ?? []) {
        app.use(mounted.path, mounted.router);
    }

    app.use(notFound);
    app.use(errorHandler);

    return app;
}
