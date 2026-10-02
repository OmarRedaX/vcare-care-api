import { Router } from "express";
import { container } from "../../lib/di/container";
import { TOKENS } from "../../lib/di/tokens";
import { sealRouter } from "../../lib/http/route-pattern";
import { markProbeExempt } from "../../lib/rbac/markers";
import type { HealthController } from "./controller/health.controller";

/**
 * DOCUMENTED EXCEPTION (foundation spec §3.1): health routes are the only routes mounted without a guard and
 * without `authorize(...)`. They are infrastructure probes and expose nothing but dependency up/down. The exemption is
 * explicit (`markProbeExempt`), so the boot-time route assertion skips them deliberately; every other route in this
 * service must declare `userGuard() → authorize(policy)`.
 */
export function buildHealthRouter(): Router {
    const router = Router();
    const controller = container.resolve<HealthController>(TOKENS.HealthController);

    router.get("/live", controller.live);
    router.get("/ready", controller.ready);

    return markProbeExempt(sealRouter(router));
}
