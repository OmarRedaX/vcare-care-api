import { Router } from "express";
import { userGuard } from "../../lib/auth/user-guard";
import { container } from "../../lib/di/container";
import { TOKENS } from "../../lib/di/tokens";
import { noStore } from "../../lib/http/no-store";
import { sealRouter } from "../../lib/http/route-pattern";
import { idempotency } from "../../lib/idempotency/idempotency";
import { rateLimit } from "../../lib/rate-limit/rate-limit";
import { byUser } from "../../lib/rate-limit/subjects";
import { authorize } from "../../lib/rbac/authorize";
import { ADMIN_DOCTORS_RATE_NAME, ADMIN_DOCTORS_RATE_WINDOW_MS, ADMIN_DOCTORS_WRITE_LIMIT } from "./constants";
import type { AdminDoctorsController } from "./controller/admin-doctors.controller";
import { buildAdminDoctorsPolicies } from "./policies";

export function buildAdminDoctorsRouter(): Router {
    const router = Router();
    const controller = container.resolve<AdminDoctorsController>(TOKENS.AdminDoctorsController);
    const p = buildAdminDoctorsPolicies();
    // One bucket for both routes: each can pin a connection for several seconds while it waits on Identity.
    const writeLimit = () => rateLimit({ name: ADMIN_DOCTORS_RATE_NAME, limit: ADMIN_DOCTORS_WRITE_LIMIT, windowMs: ADMIN_DOCTORS_RATE_WINDOW_MS, subject: byUser });
    // 5xx and 429 are not stored by the middleware, so a retry after `503` re-executes and finds the no-op state.
    const key = () => idempotency({ required: false });

    router.use("/admin/doctors", noStore());
    router.patch("/admin/doctors/:doctorUserId/suspend", userGuard(), authorize(p.suspend), writeLimit(), key(), controller.suspend);
    router.patch("/admin/doctors/:doctorUserId/reinstate", userGuard(), authorize(p.reinstate), writeLimit(), key(), controller.reinstate);
    return sealRouter(router);
}
