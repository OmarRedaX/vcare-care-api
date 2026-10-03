import express from "express";
import helmet from "helmet";
import { buildHealthRouter } from "./app/health/routes";
import { errorHandler } from "./lib/error/errorHandler";
import { notFound, optionsNotFound } from "./lib/error/not-found";
import type { AppOptions } from "./lib/http/types";
import { inFlight } from "./lib/lifecycle/in-flight";
import { requestLogger } from "./lib/logger/request-logger";
import { assertRoutesAuthorized } from "./lib/rbac/assert-routes-authorized";
import { markPreAuth } from "./lib/rbac/markers";
import { requestId } from "./lib/request-id/request-id";
import { buildInternalRoutes } from "./internal-routes";

/** The internal listener (`/internal/*` on INTERNAL_PORT). Never CORS-enabled; never publicly routed. */
export function createInternalApp(options?: AppOptions): express.Express {
    const app = express();

    app.disable("x-powered-by");

    app.use(requestId());
    app.use(inFlight());
    app.use(requestLogger());
    app.use(markPreAuth(helmet()));
    app.use(optionsNotFound);

    app.use(markPreAuth(express.json({ limit: "100kb", strict: true, type: "application/json" })));

    app.use("/internal/health", buildHealthRouter());
    app.use("/internal", buildInternalRoutes());
    // Fail closed at boot (access spec §3.2): see createPublicApp.
    assertRoutesAuthorized(app.router);
    for (const mounted of options?.extraRouters ?? []) {
        app.use(mounted.path, mounted.router);
    }

    app.use(notFound);
    app.use(errorHandler);

    return app;
}
