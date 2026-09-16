import { Router } from "express";
import { container } from "../../lib/di/container";
import { TOKENS } from "../../lib/di/tokens";
import type { HealthController } from "./controller/health.controller";

/**
 * DOCUMENTED EXCEPTION (spec §3.1): health routes are the only routes mounted without a guard and
 * without `authorize(...)`. They are infrastructure probes and expose nothing but dependency up/down.
 * Every other route in this service must declare a policy.
 */
export function buildHealthRouter(): Router {
    const router = Router();
    const controller = container.resolve<HealthController>(TOKENS.HealthController);

    router.get("/live", controller.live);
    router.get("/ready", controller.ready);

    return router;
}
