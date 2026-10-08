import { HealthController } from "./app/health/controller/health.controller";
import { DoctorsController } from "./app/doctors/controller/doctors.controller";
import { DoctorsService } from "./app/doctors/service/doctors.service";
import { HealthService } from "./app/health/service/health.service";
import { SpecialtiesController } from "./app/specialties/controller/specialties.controller";
import { SpecialtiesService } from "./app/specialties/service/specialties.service";
import { VerificationController } from "./app/verification/controller/verification.controller";
import { VerificationService } from "./app/verification/service/verification.service";
import { IdentityClient } from "./lib/identity-client/identity-client";
import { S3Adapter } from "./lib/storage/s3.adapter";
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

    container.registerInstance(TOKENS.STORAGE, new S3Adapter({ bucket: env.STORAGE_BUCKET, region: env.STORAGE_REGION, endpoint: env.STORAGE_ENDPOINT, accessKeyId: env.STORAGE_ACCESS_KEY_ID, secretAccessKey: env.STORAGE_SECRET_ACCESS_KEY, forcePathStyle: env.STORAGE_FORCE_PATH_STYLE }));
    container.registerInstance(TOKENS.IDENTITY_CLIENT, new IdentityClient({ env }));

    container.registerSingleton(TOKENS.HealthService, HealthService);
    container.registerSingleton(TOKENS.HealthController, HealthController);
    container.registerSingleton(TOKENS.SpecialtiesService, SpecialtiesService);
    container.registerSingleton(TOKENS.SpecialtiesController, SpecialtiesController);
    container.registerSingleton(TOKENS.DoctorsService, DoctorsService);
    container.registerSingleton(TOKENS.DoctorsController, DoctorsController);
    container.registerSingleton(TOKENS.VerificationService, VerificationService);
    container.registerSingleton(TOKENS.VerificationController, VerificationController);
}
