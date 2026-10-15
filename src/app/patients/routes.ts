import { Router } from "express";
import { userGuard } from "../../lib/auth/user-guard";
import { container } from "../../lib/di/container";
import { TOKENS } from "../../lib/di/tokens";
import { sealRouter } from "../../lib/http/route-pattern";
import { rateLimit } from "../../lib/rate-limit/rate-limit";
import { byUser } from "../../lib/rate-limit/subjects";
import { authorize } from "../../lib/rbac/authorize";
import { PATIENTS_RATE_WINDOW_MS, PATIENTS_READ_USER_LIMIT, PATIENTS_WRITE_USER_LIMIT } from "./constants";
import type { PatientsController } from "./controller/patients.controller";
import type { DoctorsService } from "../doctors/service/doctors.service";
import { buildPatientByIdPolicy, PATIENTS_POLICIES } from "./policies";
import type { PatientRelationshipChecker } from "./types";

export function buildPatientsRouter(): Router {
    const router = Router();
    const controller = container.resolve<PatientsController>(TOKENS.PatientsController);
    const p = PATIENTS_POLICIES;
    const writeLimit = () => rateLimit({ name: "patients-write-user", limit: PATIENTS_WRITE_USER_LIMIT, windowMs: PATIENTS_RATE_WINDOW_MS, subject: byUser });
    const readLimit = () => rateLimit({ name: "patients-read-user", limit: PATIENTS_READ_USER_LIMIT, windowMs: PATIENTS_RATE_WINDOW_MS, subject: byUser });
    router.get("/patients/me", userGuard(), authorize(p.getMe), readLimit(), controller.getMe);
    router.patch("/patients/me", userGuard(), authorize(p.updateMe), writeLimit(), controller.updateMe);
    // Registered AFTER the literal `/patients/me` routes so `me` is never captured as a patientUserId.
    const byId = buildPatientByIdPolicy(container.resolve<PatientRelationshipChecker>(TOKENS.PatientRelationship), container.resolve<DoctorsService>(TOKENS.DoctorsService));
    router.get("/patients/:patientUserId", userGuard(), authorize(byId), readLimit(), controller.getById);
    return sealRouter(router);
}
