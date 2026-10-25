import { instanceCachingFactory } from "tsyringe";
import { AvailabilityController } from "./app/availability/controller/availability.controller";
import { AvailabilityChangeListener } from "./app/availability/service/availability-change.listener";
import { AvailabilityService } from "./app/availability/service/availability.service";
import { DiscoveryService } from "./app/availability/service/discovery.service";
import { NextAvailableComputer } from "./app/availability/service/next-available.computer";
import { NextAvailableIndex } from "./app/availability/service/next-available.index";
import { SlotInputsLoader } from "./app/availability/service/slot-inputs.loader";
import { BusyIntervalsReader } from "./app/consultations/service/busy-intervals.reader";
import { DoctorDiscoveryReader } from "./app/doctors/service/doctor-discovery.reader";
import { SlotInputsReader } from "./app/schedules/service/slot-inputs.reader";
import { AuditController } from "./app/audit/controller/audit.controller";
import { AuditService } from "./app/audit/service/audit.service";
import { AdminDoctorsController } from "./app/admin-doctors/controller/admin-doctors.controller";
import { AdminDoctorsService } from "./app/admin-doctors/service/admin-doctors.service";
import { ConsultationsController } from "./app/consultations/controller/consultations.controller";
import { ConsultationRowsService } from "./app/consultations/service/consultation-rows.service";
import { ConsultationQueriesService } from "./app/consultations/service/consultation-queries.service";
import { ConsultationsService } from "./app/consultations/service/consultations.service";
import { buildScheduleImpactProvider } from "./app/consultations/service/schedule-impact.provider";
import { ConsultationSuspensionImpactProvider } from "./app/consultations/service/suspension-impact.provider";
import { RecordAttachmentsController } from "./app/record-attachments/controller/record-attachments.controller";
import { RecordAttachmentLinksService } from "./app/record-attachments/service/record-attachment-links.service";
import { RecordAttachmentsService } from "./app/record-attachments/service/record-attachments.service";
import { RecordsController } from "./app/records/controller/records.controller";
import { RecordLinksService } from "./app/records/service/record-links.service";
import { RecordQueriesService } from "./app/records/service/record-queries.service";
import { RecordsService } from "./app/records/service/records.service";
import { SessionsController } from "./app/sessions/controller/sessions.controller";
import { SessionQueriesService } from "./app/sessions/service/session-queries.service";
import { SessionsService } from "./app/sessions/service/sessions.service";
import { NotificationsService } from "./app/notifications/service/notifications.service";
import { HealthController } from "./app/health/controller/health.controller";
import { PatientsController } from "./app/patients/controller/patients.controller";
import { PatientsService } from "./app/patients/service/patients.service";
import { DoctorsController } from "./app/doctors/controller/doctors.controller";
import { DoctorsService } from "./app/doctors/service/doctors.service";
import { buildScheduleOwnerResolver } from "./app/doctors/schedule-owner.resolver";
import { SchedulesController } from "./app/schedules/controller/schedules.controller";
import { SchedulesService } from "./app/schedules/service/schedules.service";
import { HealthService } from "./app/health/service/health.service";
import { SpecialtiesController } from "./app/specialties/controller/specialties.controller";
import { SpecialtiesService } from "./app/specialties/service/specialties.service";
import { SYSTEM_SYNC_TIMING } from "./app/identity-sync/constants";
import { IdentitySyncService } from "./app/identity-sync/service/identity-sync.service";
import { UploadIntentsService } from "./app/upload-intents/service/upload-intents.service";
import { VerificationController } from "./app/verification/controller/verification.controller";
import { VerificationService } from "./app/verification/service/verification.service";
import { IdentityClient } from "./lib/identity-client/identity-client";
import { createVideoProvider } from "./lib/video/create-video-provider";
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
    container.registerSingleton(TOKENS.DoctorDiscoveryReader, DoctorDiscoveryReader);
    container.registerSingleton(TOKENS.SlotInputsReader, SlotInputsReader);
    container.registerSingleton(TOKENS.BusyIntervalsReader, BusyIntervalsReader);
    container.registerSingleton(TOKENS.SlotInputsLoader, SlotInputsLoader);
    container.registerSingleton(TOKENS.NextAvailableIndex, NextAvailableIndex);
    container.registerSingleton(TOKENS.AvailabilityChangeListener, AvailabilityChangeListener);
    container.register(TOKENS.ScheduleChangeListener, { useToken: TOKENS.AvailabilityChangeListener });
    container.register(TOKENS.ConsultationChangeListener, { useToken: TOKENS.AvailabilityChangeListener });
    container.register(TOKENS.DoctorChangeListener, { useToken: TOKENS.AvailabilityChangeListener });
    container.registerSingleton(TOKENS.NextAvailableComputer, NextAvailableComputer);
    container.registerSingleton(TOKENS.AvailabilityService, AvailabilityService);
    container.registerSingleton(TOKENS.DiscoveryService, DiscoveryService);
    container.registerSingleton(TOKENS.AvailabilityController, AvailabilityController);
    // Consultations seams, registered before their consumers: the outbox writer and the (no-op) cache-invalidation listener.
    container.registerSingleton(TOKENS.NotificationsService, NotificationsService);
    // Schedules seams: the real impact provider from `consultations` (SchedulesService is looked up at call time because it
    // injects the provider), the no-op `availability` listener, and the lazy owner resolver that breaks the doctors <->
    // schedules constructor cycle (DoctorsService is looked up at call time).
    container.register(TOKENS.ScheduleImpactProvider, { useFactory: instanceCachingFactory((c) => buildScheduleImpactProvider({
        getSchedules: () => c.resolve<SchedulesService>(TOKENS.SchedulesService), notifications: c.resolve<NotificationsService>(TOKENS.NotificationsService) })) });
    container.register(TOKENS.ScheduleOwnerResolver, { useFactory: (c) => buildScheduleOwnerResolver(() => c.resolve<DoctorsService>(TOKENS.DoctorsService)) });
    container.registerSingleton(TOKENS.SchedulesService, SchedulesService);
    container.registerSingleton(TOKENS.SchedulesController, SchedulesController);
    container.registerSingleton(TOKENS.DoctorsService, DoctorsService);
    container.registerSingleton(TOKENS.DoctorsController, DoctorsController);
    container.registerInstance(TOKENS.SyncTiming, SYSTEM_SYNC_TIMING);
    container.registerSingleton(TOKENS.IdentitySyncService, IdentitySyncService);
    container.registerSingleton(TOKENS.UploadIntentsService, UploadIntentsService);
    container.registerSingleton(TOKENS.VerificationService, VerificationService);
    container.registerSingleton(TOKENS.VerificationController, VerificationController);
    // Case 3/4 seam: the real flagging port from `consultations`; the service needs the sync engine registered above.
    container.registerSingleton(TOKENS.SuspensionImpactProvider, ConsultationSuspensionImpactProvider);
    container.registerSingleton(TOKENS.AdminDoctorsService, AdminDoctorsService);
    container.registerSingleton(TOKENS.AdminDoctorsController, AdminDoctorsController);
    container.registerInstance(TOKENS.AuditClock, { now: () => Date.now() });
    container.registerSingleton(TOKENS.AuditService, AuditService);
    container.registerSingleton(TOKENS.AuditController, AuditController);
    container.registerSingleton(TOKENS.PatientsService, PatientsService);
    container.registerSingleton(TOKENS.PatientsController, PatientsController);
    container.registerSingleton(TOKENS.ConsultationRowsService, ConsultationRowsService);
    // Records: the links service reads only the database, so it is registered before `consultations` and `sessions` (which inject it) and
    // before the records services (which inject ConsultationRowsService and PatientsService, both registered above).
    container.registerSingleton(TOKENS.RecordLinksService, RecordLinksService);
    // Record attachments: the links service (database only) precedes the records services that inject it; the commands need the links
    // service, `UploadIntentsService` (registered above) and the storage port, none of which depends on a records service.
    container.registerSingleton(TOKENS.RecordAttachmentLinksService, RecordAttachmentLinksService);
    container.registerSingleton(TOKENS.RecordAttachmentsService, RecordAttachmentsService);
    container.registerSingleton(TOKENS.RecordsService, RecordsService);
    container.registerSingleton(TOKENS.RecordQueriesService, RecordQueriesService);
    container.registerSingleton(TOKENS.RecordsController, RecordsController);
    container.registerSingleton(TOKENS.RecordAttachmentsController, RecordAttachmentsController);
    container.registerSingleton(TOKENS.ConsultationsService, ConsultationsService);
    container.registerSingleton(TOKENS.ConsultationQueriesService, ConsultationQueriesService);
    container.registerSingleton(TOKENS.ConsultationsController, ConsultationsController);
    // Sessions: the provider is built lazily (first resolve is the router build at boot, so a production boot with the fake fails there);
    // tests rebind `TOKENS.VideoProvider` to a stub.
    container.register(TOKENS.VideoProvider, { useFactory: instanceCachingFactory(() => createVideoProvider(env)) });
    container.registerSingleton(TOKENS.SessionsService, SessionsService);
    container.registerSingleton(TOKENS.SessionQueriesService, SessionQueriesService);
    container.registerSingleton(TOKENS.SessionsController, SessionsController);
    // Port for `patients`: the doctor-patient relationship is answered by the consultations service.
    container.register(TOKENS.PatientRelationship, { useFactory: (c) => c.resolve<ConsultationsService>(TOKENS.ConsultationsService) });
}
