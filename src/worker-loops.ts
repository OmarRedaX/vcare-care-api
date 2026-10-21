import { SYSTEM_SYNC_TIMING } from "./app/identity-sync/constants";
import { IdentitySyncService } from "./app/identity-sync/service/identity-sync.service";
import { buildIdentitySyncLoop } from "./app/identity-sync/worker/identity-sync.loop";
import { ConsultationReminderService } from "./app/consultations/service/consultation-reminder.service";
import { SYSTEM_NOTIFICATION_TIMING } from "./app/notifications/constants";
import { NotificationsService } from "./app/notifications/service/notifications.service";
import { OutboxDeliveryService } from "./app/notifications/service/outbox-delivery.service";
import { OutboxPurgeService } from "./app/notifications/service/outbox-purge.service";
import { ReminderScanService } from "./app/notifications/service/reminder-scan.service";
import { buildConsultationRemindersLoop, buildNotificationOutboxLoop, buildNotificationOutboxPurgeLoop } from "./app/notifications/worker/notification.loops";
import { UploadIntentsService } from "./app/upload-intents/service/upload-intents.service";
import { buildUploadIntentPurgeLoop } from "./app/upload-intents/worker/upload-intent-purge.loop";
import { AuditRecorder } from "./lib/audit/audit";
import { buildAuditPartitionLoop } from "./lib/audit/partition-loop";
import { LogEmailAdapter } from "./lib/email/log-email.adapter";
import type { WorkerLoop, WorkerLoopDeps } from "./lib/worker/types";

/**
 * Every care-worker loop (ADR 0008). Each module with background work (outbox, reminders, sync retries) adds its loop
 * here, built from the worker's own pool — never the API's.
 */
export function buildWorkerLoops(deps: WorkerLoopDeps): WorkerLoop[] {
    const audit = new AuditRecorder({ logger: deps.logger });
    const identitySync = new IdentitySyncService(deps.db, audit, deps.identity, deps.env, SYSTEM_SYNC_TIMING);
    const uploadIntents = new UploadIntentsService(deps.db, deps.storage, deps.env);
    const consultations = new ConsultationReminderService();
    const outboxDelivery = new OutboxDeliveryService(deps.db, deps.identity, new LogEmailAdapter(deps.logger), consultations, deps.env, deps.logger, SYSTEM_NOTIFICATION_TIMING);
    const reminderScan = new ReminderScanService(deps.db, consultations, new NotificationsService(), deps.logger, SYSTEM_NOTIFICATION_TIMING);
    const outboxPurge = new OutboxPurgeService(deps.db, deps.env, deps.logger, SYSTEM_NOTIFICATION_TIMING);
    return [
        buildAuditPartitionLoop({
            db: deps.db,
            logger: deps.logger,
            monthsAhead: deps.env.AUDIT_PARTITION_MONTHS_AHEAD,
        }),
        buildIdentitySyncLoop({ service: identitySync, logger: deps.logger, pollSeconds: deps.env.IDENTITY_SYNC_POLL_SECONDS }),
        buildUploadIntentPurgeLoop({ service: uploadIntents, db: deps.db, logger: deps.logger, intervalSeconds: deps.env.UPLOAD_INTENT_PURGE_SECONDS }),
        buildNotificationOutboxLoop({ service: outboxDelivery, pollSeconds: deps.env.OUTBOX_POLL_SECONDS }),
        buildConsultationRemindersLoop({ service: reminderScan, intervalSeconds: deps.env.REMINDER_SCAN_SECONDS }),
        buildNotificationOutboxPurgeLoop({ service: outboxPurge, intervalSeconds: deps.env.OUTBOX_PURGE_SECONDS }),
    ];
}
