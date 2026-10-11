import { Router } from "express";
import { userGuard } from "../../lib/auth/user-guard";
import { container } from "../../lib/di/container";
import { TOKENS } from "../../lib/di/tokens";
import { sealRouter } from "../../lib/http/route-pattern";
import { idempotency } from "../../lib/idempotency/idempotency";
import { rateLimit } from "../../lib/rate-limit/rate-limit";
import { byUser, byUserOfRoles } from "../../lib/rate-limit/subjects";
import { authorize } from "../../lib/rbac/authorize";
import type { DoctorsService } from "../doctors/service/doctors.service";
import {
    CONSULTATIONS_RATE_WINDOW_MS, CONSULTATIONS_READ_RATE_NAME, CONSULTATIONS_READ_USER_LIMIT, CONSULTATIONS_WRITE_ADMIN_LIMIT,
    CONSULTATIONS_WRITE_ADMIN_RATE_NAME, CONSULTATIONS_WRITE_USER_LIMIT, CONSULTATIONS_WRITE_USER_RATE_NAME,
} from "./constants";
import type { ConsultationsController } from "./controller/consultations.controller";
import { buildConsultationsPolicies } from "./policies";

export function buildConsultationsRouter(): Router {
    const router = Router();
    const controller = container.resolve<ConsultationsController>(TOKENS.ConsultationsController);
    const p = buildConsultationsPolicies(container.resolve<DoctorsService>(TOKENS.DoctorsService));
    // Booking writes: 10/min per patient or doctor (one shared bucket) and 60/min per admin; each limiter skips the other roles.
    const writeLimits = () => [
        rateLimit({ name: CONSULTATIONS_WRITE_USER_RATE_NAME, limit: CONSULTATIONS_WRITE_USER_LIMIT, windowMs: CONSULTATIONS_RATE_WINDOW_MS, subject: byUserOfRoles(["patient", "doctor"]) }),
        rateLimit({ name: CONSULTATIONS_WRITE_ADMIN_RATE_NAME, limit: CONSULTATIONS_WRITE_ADMIN_LIMIT, windowMs: CONSULTATIONS_RATE_WINDOW_MS, subject: byUserOfRoles(["admin"]) }),
    ];
    const readLimit = () => rateLimit({ name: CONSULTATIONS_READ_RATE_NAME, limit: CONSULTATIONS_READ_USER_LIMIT, windowMs: CONSULTATIONS_RATE_WINDOW_MS, subject: byUser });

    router.post("/consultations", userGuard(), authorize(p.book), ...writeLimits(), idempotency({ required: true }), controller.book);
    router.get("/consultations", userGuard(), authorize(p.list), readLimit(), controller.list);
    // The literal siblings `/consultations/waiting-room` and `/consultations/calendar` (sessions unit) must be registered HERE,
    // before `/consultations/:id`, so the id route never captures them.
    router.get("/consultations/:id", userGuard(), authorize(p.get), readLimit(), controller.get);
    router.patch("/consultations/:id/reschedule", userGuard(), authorize(p.reschedule), ...writeLimits(), idempotency({ required: true }), controller.reschedule);
    router.patch("/consultations/:id/cancel", userGuard(), authorize(p.cancel), ...writeLimits(), idempotency({ required: true }), controller.cancel);
    return sealRouter(router);
}
