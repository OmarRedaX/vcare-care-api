import { Router } from "express";

/** Public module routers are mounted here (under `/api`). Health is mounted separately in `app.ts`. */
export function buildPublicRoutes(): Router {
    const router = Router();
    return router;
}
