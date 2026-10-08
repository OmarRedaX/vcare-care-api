import { Router } from "express";
import { userGuard } from "../../lib/auth/user-guard";
import { container } from "../../lib/di/container";
import { TOKENS } from "../../lib/di/tokens";
import { sealRouter } from "../../lib/http/route-pattern";
import { idempotency } from "../../lib/idempotency/idempotency";
import { rateLimit } from "../../lib/rate-limit/rate-limit";
import { byUser } from "../../lib/rate-limit/subjects";
import { authorize } from "../../lib/rbac/authorize";
import type { DoctorsService } from "../doctors/service/doctors.service";
import { SCHEDULES_RATE_WINDOW_MS, SCHEDULES_READ_USER_LIMIT, SCHEDULES_WRITE_USER_LIMIT } from "./constants";
import type { SchedulesController } from "./controller/schedules.controller";
import { buildSchedulesPolicies } from "./policies";

export function buildSchedulesRouter(): Router {
    const router = Router();
    const controller = container.resolve<SchedulesController>(TOKENS.SchedulesController);
    const doctors = container.resolve<DoctorsService>(TOKENS.DoctorsService);
    const p = buildSchedulesPolicies(doctors);
    const writeLimit = () => rateLimit({ name: "schedules-write-user", limit: SCHEDULES_WRITE_USER_LIMIT, windowMs: SCHEDULES_RATE_WINDOW_MS, subject: byUser });
    const readLimit = () => rateLimit({ name: "schedules-read-user", limit: SCHEDULES_READ_USER_LIMIT, windowMs: SCHEDULES_RATE_WINDOW_MS, subject: byUser });

    router.get("/doctors/me/working-hours", userGuard(), authorize(p.getWorkingHours), readLimit(), controller.getWorkingHours);
    router.put("/doctors/me/working-hours", userGuard(), authorize(p.replaceWorkingHours), writeLimit(), controller.replaceWorkingHours);
    router.get("/doctors/me/exceptions", userGuard(), authorize(p.listExceptions), readLimit(), controller.listExceptions);
    router.post("/doctors/me/exceptions", userGuard(), authorize(p.createException), writeLimit(), idempotency({ required: false }), controller.createException);
    router.delete("/doctors/me/exceptions/:id", userGuard(), authorize(p.deleteException), writeLimit(), controller.deleteException);
    router.get("/doctors/me/consultation-types", userGuard(), authorize(p.listTypes), readLimit(), controller.listTypes);
    router.post("/doctors/me/consultation-types", userGuard(), authorize(p.createType), writeLimit(), idempotency({ required: false }), controller.createType);
    router.patch("/doctors/me/consultation-types/:id", userGuard(), authorize(p.updateType), writeLimit(), controller.updateType);
    return sealRouter(router);
}
