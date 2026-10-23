import { Router } from "express";
import { userGuard } from "../../lib/auth/user-guard";
import { container } from "../../lib/di/container";
import { TOKENS } from "../../lib/di/tokens";
import { sealRouter } from "../../lib/http/route-pattern";
import { rateLimit } from "../../lib/rate-limit/rate-limit";
import { byIp, byUser } from "../../lib/rate-limit/subjects";
import { authorize } from "../../lib/rbac/authorize";
import { DISCOVERY_IP_LIMIT, DISCOVERY_RATE_WINDOW_MS, DISCOVERY_USER_LIMIT, DOCTORS_SLOTS_IP_RATE_NAME, DOCTORS_SLOTS_USER_RATE_NAME } from "./constants";
import type { AvailabilityController } from "./controller/availability.controller";
import { AVAILABILITY_POLICIES } from "./policies";

export function buildAvailabilityRouter(): Router {
    const router = Router();
    const controller = container.resolve<AvailabilityController>(TOKENS.AvailabilityController);
    router.get("/doctors/:doctorUserId/slots",
        rateLimit({ name: DOCTORS_SLOTS_IP_RATE_NAME, limit: DISCOVERY_IP_LIMIT, windowMs: DISCOVERY_RATE_WINDOW_MS, subject: byIp }),
        userGuard(), authorize(AVAILABILITY_POLICIES.slots),
        rateLimit({ name: DOCTORS_SLOTS_USER_RATE_NAME, limit: DISCOVERY_USER_LIMIT, windowMs: DISCOVERY_RATE_WINDOW_MS, subject: byUser }),
        controller.slots);
    return sealRouter(router);
}
