import { Router } from "express";
import { buildAdminDoctorsRouter } from "./app/admin-doctors/routes";
import { buildAuditRouter } from "./app/audit/routes";
import { buildConsultationsRouter } from "./app/consultations/routes";
import { buildDoctorsRouter } from "./app/doctors/routes";
import { buildPatientsRouter } from "./app/patients/routes";
import { buildSchedulesRouter } from "./app/schedules/routes";
import { buildSpecialtiesRouter } from "./app/specialties/routes";
import { buildVerificationRouter } from "./app/verification/routes";

/** Prefixes whose every response is `Cache-Control: no-store`; `app.ts` applies it before body parsing. */
export const NO_STORE_PREFIXES: readonly string[] = ["/api/patients", "/api/consultations", "/api/admin", "/api/audit-logs"];

/** Public module routers are mounted here (under `/api`). Health is mounted separately in `app.ts`. */
export function buildPublicRoutes(): Router {
    const router = Router();
    router.use(buildSpecialtiesRouter());
    router.use(buildDoctorsRouter());
    // Self-owned `/doctors/me/*` schedule routes: before any `GET /doctors/:doctorUserId` discovery router (availability).
    router.use(buildSchedulesRouter());
    router.use(buildVerificationRouter());
    // After the doctors/schedules routers and before any future `GET /doctors/:doctorUserId` discovery router.
    router.use(buildAdminDoctorsRouter());
    router.use(buildAuditRouter());
    // Self-owned `/patients/me`: before any future `GET /patients/:patientUserId` (consultations) so `me` is never captured.
    router.use(buildPatientsRouter());
    router.use(buildConsultationsRouter());
    return router;
}
