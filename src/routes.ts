import { Router } from "express";
import { buildDoctorsRouter } from "./app/doctors/routes";
import { buildSpecialtiesRouter } from "./app/specialties/routes";

/** Public module routers are mounted here (under `/api`). Health is mounted separately in `app.ts`. */
export function buildPublicRoutes(): Router {
    const router = Router();
    router.use(buildSpecialtiesRouter());
    router.use(buildDoctorsRouter());
    return router;
}
