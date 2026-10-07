import { Router } from "express";
import { userGuard } from "../../lib/auth/user-guard";
import { container } from "../../lib/di/container";
import { TOKENS } from "../../lib/di/tokens";
import { sealRouter } from "../../lib/http/route-pattern";
import { idempotency } from "../../lib/idempotency/idempotency";
import { noStore } from "../../lib/http/no-store";
import { rateLimit } from "../../lib/rate-limit/rate-limit";
import { byUser } from "../../lib/rate-limit/subjects";
import { authorize } from "../../lib/rbac/authorize";
import { DOCTORS_RATE_WINDOW_MS, DOCTORS_READ_USER_LIMIT, DOCTORS_WRITE_USER_LIMIT } from "./constants";
import type { DoctorsController } from "./controller/doctors.controller";
import { buildDoctorsPolicies } from "./policies";
import type { DoctorsService } from "./service/doctors.service";

export function buildDoctorsRouter(): Router {
    const router = Router();
    const controller = container.resolve<DoctorsController>(TOKENS.DoctorsController);
    const service = container.resolve<DoctorsService>(TOKENS.DoctorsService);
    const p = buildDoctorsPolicies(service);
    const writeLimit = () => rateLimit({ name: "doctors-write-user", limit: DOCTORS_WRITE_USER_LIMIT, windowMs: DOCTORS_RATE_WINDOW_MS, subject: byUser });
    const readLimit = () => rateLimit({ name: "doctors-read-user", limit: DOCTORS_READ_USER_LIMIT, windowMs: DOCTORS_RATE_WINDOW_MS, subject: byUser });
    router.use("/doctors/apply", noStore());
    router.use("/doctors/me", noStore());
    router.post("/doctors/apply", userGuard(), authorize(p.apply), writeLimit(), idempotency({ required: false }), controller.apply);
    router.get("/doctors/me", userGuard(), authorize(p.getMe), readLimit(), controller.getMe);
    router.patch("/doctors/me", userGuard(), authorize(p.updateMe), writeLimit(), controller.updateMe);
    router.get("/doctors/me/application", userGuard(), authorize(p.getApplication), readLimit(), controller.getApplication);
    return sealRouter(router);
}
