import { Router } from "express";
import { buildSpecialtiesRouter } from "./app/specialties/routes";

/** Public module routers are mounted here (under `/api`). Health is mounted separately in `app.ts`. */
export function buildPublicRoutes(): Router {
    const router = Router();
    router.use(buildSpecialtiesRouter());
    return router;
}
