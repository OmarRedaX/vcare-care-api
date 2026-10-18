import { Router } from "express";
import { userGuard } from "../../lib/auth/user-guard";
import { container } from "../../lib/di/container";
import { TOKENS } from "../../lib/di/tokens";
import { sealRouter } from "../../lib/http/route-pattern";
import { authorize } from "../../lib/rbac/authorize";
import type { ConsultationRowsService } from "../consultations/service/consultation-rows.service";
import type { DoctorsService } from "../doctors/service/doctors.service";
import type { PatientRelationshipChecker } from "../patients/types";
import type { RecordsController } from "./controller/records.controller";
import { buildRecordsPolicies } from "./policies";
import { readLimit, timelineLimit, writeLimit } from "./rate-limits";
import type { RecordLinksService } from "./service/record-links.service";

/**
 * Mounted AFTER the consultations router. No path collides: `/consultations/:id/record` is distinct from `/consultations/:id` and the
 * sessions literals, and `/patients/:patientUserId/records` from `/patients/:patientUserId` and `/patients/me`. No route takes an
 * `Idempotency-Key`: a retried create is `409 Conflict` and no record text ever reaches Redis.
 */
export function buildRecordsRouter(): Router {
    const router = Router();
    const controller = container.resolve<RecordsController>(TOKENS.RecordsController);
    const p = buildRecordsPolicies(container.resolve<DoctorsService>(TOKENS.DoctorsService), container.resolve<ConsultationRowsService>(TOKENS.ConsultationRowsService),
        container.resolve<RecordLinksService>(TOKENS.RecordLinksService), container.resolve<PatientRelationshipChecker>(TOKENS.PatientRelationship));

    router.post("/consultations/:id/record", userGuard(), authorize(p.create), writeLimit(), controller.create);
    router.get("/records/:id", userGuard(), authorize(p.get), readLimit(), controller.get);
    router.patch("/records/:id", userGuard(), authorize(p.update), writeLimit(), controller.update);
    router.get("/patients/:patientUserId/records", userGuard(), authorize(p.timeline), timelineLimit(), controller.timeline);
    return sealRouter(router);
}
