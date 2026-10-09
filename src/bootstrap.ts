import { AuditController } from "./app/audit/controller/audit.controller";
import { AuditService } from "./app/audit/service/audit.service";
import { AdminDoctorsController } from "./app/admin-doctors/controller/admin-doctors.controller";
import { AdminDoctorsService } from "./app/admin-doctors/service/admin-doctors.service";
import { NoopSuspensionImpactProvider } from "./app/admin-doctors/service/noop-suspension-impact.provider";
import { HealthController } from "./app/health/controller/health.controller";
import { DoctorsController } from "./app/doctors/controller/doctors.controller";
import { DoctorsService } from "./app/doctors/service/doctors.service";
import { buildScheduleOwnerResolver } from "./app/doctors/schedule-owner.resolver";
import { SchedulesController } from "./app/schedules/controller/schedules.controller";
import { NoopScheduleChangeListener } from "./app/schedules/service/noop-schedule-change-listener";
import { NoopScheduleImpactProvider } from "./app/schedules/service/noop-schedule-impact.provider";
import { SchedulesService } from "./app/schedules/service/schedules.service";
import { HealthService } from "./app/health/service/health.service";
import { SpecialtiesController } from "./app/specialties/controller/specialties.controller";
import { SpecialtiesService } from "./app/specialties/service/specialties.service";
import { SYSTEM_SYNC_TIMING } from "./app/identity-sync/constants";
import { IdentitySyncService } from "./app/identity-sync/service/identity-sync.service";
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
    // Schedules seams: default no-op ports (`consultations` / `availability` rebind them) and the lazy owner resolver
    // that breaks the doctors <-> schedules constructor cycle (DoctorsService is looked up at call time).
    container.registerSingleton(TOKENS.ScheduleImpactProvider, NoopScheduleImpactProvider);
    container.registerSingleton(TOKENS.ScheduleChangeListener, NoopScheduleChangeListener);
    container.register(TOKENS.ScheduleOwnerResolver, { useFactory: (c) => buildScheduleOwnerResolver(() => c.resolve<DoctorsService>(TOKENS.DoctorsService)) });
    container.registerSingleton(TOKENS.SchedulesService, SchedulesService);
    container.registerSingleton(TOKENS.SchedulesController, SchedulesController);
    container.registerSingleton(TOKENS.DoctorsService, DoctorsService);
    container.registerSingleton(TOKENS.DoctorsController, DoctorsController);
    container.registerInstance(TOKENS.SyncTiming, SYSTEM_SYNC_TIMING);
    container.registerSingleton(TOKENS.IdentitySyncService, IdentitySyncService);
    container.registerSingleton(TOKENS.VerificationService, VerificationService);
    container.registerSingleton(TOKENS.VerificationController, VerificationController);
    // Case 3/4 seam: default no-op port (`consultations` rebinds it); the service needs the sync engine registered above.
    container.registerSingleton(TOKENS.SuspensionImpactProvider, NoopSuspensionImpactProvider);
    container.registerSingleton(TOKENS.AdminDoctorsService, AdminDoctorsService);
    container.registerSingleton(TOKENS.AdminDoctorsController, AdminDoctorsController);
    container.registerInstance(TOKENS.AuditClock, { now: () => Date.now() });
    container.registerSingleton(TOKENS.AuditService, AuditService);
    container.registerSingleton(TOKENS.AuditController, AuditController);
}
