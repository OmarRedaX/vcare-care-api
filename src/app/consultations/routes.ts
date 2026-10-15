import { Router } from "express";
import { userGuard } from "../../lib/auth/user-guard";
import { container } from "../../lib/di/container";
import { TOKENS } from "../../lib/di/tokens";
import { sealRouter } from "../../lib/http/route-pattern";
import { idempotency } from "../../lib/idempotency/idempotency";
import { authorize } from "../../lib/rbac/authorize";
import type { DoctorsService } from "../doctors/service/doctors.service";
import type { ConsultationsController } from "./controller/consultations.controller";
import { buildConsultationsPolicies } from "./policies";
import { readLimit, writeLimits } from "./rate-limits";

export function buildConsultationsRouter(): Router {
    const router = Router();
    const controller = container.resolve<ConsultationsController>(TOKENS.ConsultationsController);
    const p = buildConsultationsPolicies(container.resolve<DoctorsService>(TOKENS.DoctorsService));

    router.post("/consultations", userGuard(), authorize(p.book), ...writeLimits(), idempotency({ required: true }), controller.book);
    router.get("/consultations", userGuard(), authorize(p.list), readLimit(), controller.list);
    // The sessions router (mounted before this one in `src/routes.ts`) owns the literals `/consultations/waiting-room` and
    // `/consultations/calendar`, so the id route below never captures them.
    router.get("/consultations/:id", userGuard(), authorize(p.get), readLimit(), controller.get);
    router.patch("/consultations/:id/reschedule", userGuard(), authorize(p.reschedule), ...writeLimits(), idempotency({ required: true }), controller.reschedule);
    router.patch("/consultations/:id/cancel", userGuard(), authorize(p.cancel), ...writeLimits(), idempotency({ required: true }), controller.cancel);
    return sealRouter(router);
}
