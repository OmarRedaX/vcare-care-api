import { Router } from "express";
import { userGuard } from "../../lib/auth/user-guard";
import { container } from "../../lib/di/container";
import { TOKENS } from "../../lib/di/tokens";
import { sealRouter } from "../../lib/http/route-pattern";
import { idempotency } from "../../lib/idempotency/idempotency";
import { rateLimit } from "../../lib/rate-limit/rate-limit";
import { byIp, byUser } from "../../lib/rate-limit/subjects";
import { authorize } from "../../lib/rbac/authorize";
import {
    SPECIALTIES_LIST_IP_LIMIT,
    SPECIALTIES_LIST_USER_LIMIT,
    SPECIALTIES_LIST_WINDOW_MS,
} from "./constants";
import type { SpecialtiesController } from "./controller/specialties.controller";
import { SPECIALTIES_POLICIES } from "./policies";

export function buildSpecialtiesRouter(): Router {
    const router = Router();
    const controller = container.resolve<SpecialtiesController>(TOKENS.SpecialtiesController);
    const p = SPECIALTIES_POLICIES;

    router.get(
        "/specialties",
        rateLimit({ name: "specialties-list-ip", limit: SPECIALTIES_LIST_IP_LIMIT, windowMs: SPECIALTIES_LIST_WINDOW_MS, subject: byIp }),
        userGuard(),
        authorize(p.list),
        rateLimit({ name: "specialties-list-user", limit: SPECIALTIES_LIST_USER_LIMIT, windowMs: SPECIALTIES_LIST_WINDOW_MS, subject: byUser }),
        controller.list,
    );
    router.post("/specialties", userGuard(), authorize(p.create), idempotency({ required: false }), controller.create);
    router.patch("/specialties/:id", userGuard(), authorize(p.update), controller.update);

    return sealRouter(router);
}
