import { HealthController } from "./app/health/controller/health.controller";
import { HealthService } from "./app/health/service/health.service";
import type { Env } from "./lib/config/types";
import { container } from "./lib/di/container";
import { registerCore } from "./lib/di/register-core";
import { TOKENS } from "./lib/di/tokens";

/**
 * The only place that imports both `lib/di` and `app/*` classes — that is what keeps `lib/` free of
 * `app/` imports (CLAUDE.md → Folder structure and layering).
 */
export function registerDependencies(env: Env): void {
    registerCore(env);

    container.registerSingleton(TOKENS.HealthService, HealthService);
    container.registerSingleton(TOKENS.HealthController, HealthController);
}
