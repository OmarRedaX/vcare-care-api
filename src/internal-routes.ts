import { Router } from "express";

/** Internal module routers are mounted here (under `/internal`), reachable only on INTERNAL_PORT. */
export function buildInternalRoutes(): Router {
    const router = Router();
    return router;
}
