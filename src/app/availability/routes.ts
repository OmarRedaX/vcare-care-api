import { Router } from "express";
import { userGuard } from "../../lib/auth/user-guard";
import { container } from "../../lib/di/container";
import { TOKENS } from "../../lib/di/tokens";
import { sealRouter } from "../../lib/http/route-pattern";
import { rateLimit } from "../../lib/rate-limit/rate-limit";
import { byIp, byUser } from "../../lib/rate-limit/subjects";
import { authorize } from "../../lib/rbac/authorize";
import {
    DISCOVERY_IP_LIMIT, DISCOVERY_RATE_WINDOW_MS, DISCOVERY_USER_LIMIT, DOCTORS_PROFILE_IP_RATE_NAME, DOCTORS_PROFILE_USER_RATE_NAME,
    DOCTORS_SEARCH_IP_RATE_NAME, DOCTORS_SEARCH_USER_RATE_NAME, DOCTORS_SLOTS_IP_RATE_NAME, DOCTORS_SLOTS_USER_RATE_NAME,
} from "./constants";
import type { AvailabilityController } from "./controller/availability.controller";
import { AVAILABILITY_POLICIES } from "./policies";

const ipLimit = (name: string) => rateLimit({ name, limit: DISCOVERY_IP_LIMIT, windowMs: DISCOVERY_RATE_WINDOW_MS, subject: byIp });
const userLimit = (name: string) => rateLimit({ name, limit: DISCOVERY_USER_LIMIT, windowMs: DISCOVERY_RATE_WINDOW_MS, subject: byUser });

/**
 * Discovery routes (all `GET`, patient and admin): IP limiter before the guard, user limiter after `authorize`. Mounted after the `doctors` and
 * `schedules` routers so `/doctors/me*` is matched first.
 */
export function buildAvailabilityRouter(): Router {
    const router = Router();
    const controller = container.resolve<AvailabilityController>(TOKENS.AvailabilityController);
    router.get("/doctors", ipLimit(DOCTORS_SEARCH_IP_RATE_NAME), userGuard(), authorize(AVAILABILITY_POLICIES.search),
        userLimit(DOCTORS_SEARCH_USER_RATE_NAME), controller.search);
    router.get("/doctors/:doctorUserId", ipLimit(DOCTORS_PROFILE_IP_RATE_NAME), userGuard(), authorize(AVAILABILITY_POLICIES.getDoctor),
        userLimit(DOCTORS_PROFILE_USER_RATE_NAME), controller.getDoctor);
    router.get("/doctors/:doctorUserId/slots", ipLimit(DOCTORS_SLOTS_IP_RATE_NAME), userGuard(), authorize(AVAILABILITY_POLICIES.slots),
        userLimit(DOCTORS_SLOTS_USER_RATE_NAME), controller.slots);
    return sealRouter(router);
}
