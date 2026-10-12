import type { TickService, WorkerLoop } from "../../../lib/worker/types";
import { OUTBOX_LOOP_NAME, OUTBOX_PURGE_LOOP_NAME, REMINDER_LOOP_NAME } from "../constants";

function buildLoop(name: string, service: TickService, intervalSeconds: number): WorkerLoop {
    return { name, intervalMs: intervalSeconds * 1000, tick: (signal) => service.tick(signal) };
}

/** care-worker loop `notification-outbox`: claim due rows, look up contacts, send (spec 3.4). */
export function buildNotificationOutboxLoop(deps: { service: TickService; pollSeconds: number }): WorkerLoop {
    return buildLoop(OUTBOX_LOOP_NAME, deps.service, deps.pollSeconds);
}

/** care-worker loop `consultation-reminders`: the 24 h / 1 h reminder scan (spec 3.5). */
export function buildConsultationRemindersLoop(deps: { service: TickService; intervalSeconds: number }): WorkerLoop {
    return buildLoop(REMINDER_LOOP_NAME, deps.service, deps.intervalSeconds);
}

/** care-worker loop `notification-outbox-purge`: deletes old `sent` rows (spec 3.8). */
export function buildNotificationOutboxPurgeLoop(deps: { service: TickService; intervalSeconds: number }): WorkerLoop {
    return buildLoop(OUTBOX_PURGE_LOOP_NAME, deps.service, deps.intervalSeconds);
}
