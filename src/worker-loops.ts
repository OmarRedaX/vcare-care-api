import type { WorkerLoop } from "./lib/worker/types";

/** No loops yet. The first module with background work (outbox, reminders, sync retries) adds its loop here. */
export function buildWorkerLoops(): WorkerLoop[] {
    return [];
}
