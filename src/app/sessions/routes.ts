import { Router } from "express";
import { userGuard } from "../../lib/auth/user-guard";
import { container } from "../../lib/di/container";
import { TOKENS } from "../../lib/di/tokens";
import { sealRouter } from "../../lib/http/route-pattern";
import { rateLimit } from "../../lib/rate-limit/rate-limit";
import { byUserOfRoles } from "../../lib/rate-limit/subjects";
import { authorize } from "../../lib/rbac/authorize";
import { CONSULTATIONS_RATE_WINDOW_MS } from "../consultations/constants";
import { readLimit, writeLimits } from "../consultations/rate-limits";
import type { ConsultationRowsService } from "../consultations/service/consultation-rows.service";
import type { DoctorsService } from "../doctors/service/doctors.service";
import { SESSION_RATE_NAME, SESSION_USER_LIMIT } from "./constants";
import type { SessionsController } from "./controller/sessions.controller";
import { buildSessionsPolicies } from "./policies";

/**
 * Mounted BEFORE the consultations router: the literals `/consultations/waiting-room` and `/consultations/calendar` must be
 * registered ahead of `GET /consultations/:id`. None of the six routes takes an `Idempotency-Key` (the status guard makes a retry safe).
 */
export function buildSessionsRouter(): Router {
    const router = Router();
    const controller = container.resolve<SessionsController>(TOKENS.SessionsController);
    const p = buildSessionsPolicies(container.resolve<DoctorsService>(TOKENS.DoctorsService), container.resolve<ConsultationRowsService>(TOKENS.ConsultationRowsService));
    // Join and start share their own bucket: reconnecting never consumes booking writes, and token minting stays bounded.
    const sessionLimit = () => rateLimit({ name: SESSION_RATE_NAME, limit: SESSION_USER_LIMIT, windowMs: CONSULTATIONS_RATE_WINDOW_MS, subject: byUserOfRoles(["patient", "doctor"]) });

    router.get("/consultations/waiting-room", userGuard(), authorize(p.waitingRoom), readLimit(), controller.waitingRoom);
    router.get("/consultations/calendar", userGuard(), authorize(p.calendar), readLimit(), controller.calendar);
    router.patch("/consultations/:id/join", userGuard(), authorize(p.join), sessionLimit(), controller.join);
    router.patch("/consultations/:id/start", userGuard(), authorize(p.start), sessionLimit(), controller.start);
    router.patch("/consultations/:id/complete", userGuard(), authorize(p.complete), ...writeLimits(), controller.complete);
    router.patch("/consultations/:id/no-show", userGuard(), authorize(p.noShow), ...writeLimits(), controller.noShow);
    return sealRouter(router);
}
