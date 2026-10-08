import { Router } from "express";
import { buildDoctorsRouter } from "./app/doctors/routes";
import { buildSchedulesRouter } from "./app/schedules/routes";
import { buildSpecialtiesRouter } from "./app/specialties/routes";
import { buildVerificationRouter } from "./app/verification/routes";

/** Public module routers are mounted here (under `/api`). Health is mounted separately in `app.ts`. */
export function buildPublicRoutes(): Router {
    const router = Router();
    router.use(buildSpecialtiesRouter());
    router.use(buildDoctorsRouter());
    // Self-owned `/doctors/me/*` schedule routes: before any `GET /doctors/:doctorUserId` discovery router (availability).
    router.use(buildSchedulesRouter());
    router.use(buildVerificationRouter());
    return router;
}
