import type { TickService, WorkerLoop } from "../../../lib/worker/types";
import { REFRESH_INTERVAL_MS, REFRESH_LOOP_NAME, SWEEP_LOOP_NAME } from "../constants";

/** care-worker loop `availability-refresh`: drains the refresh set every 2 s (AV-R24). */
export function buildAvailabilityRefreshLoop(deps: { service: TickService }): WorkerLoop {
    return { name: REFRESH_LOOP_NAME, intervalMs: REFRESH_INTERVAL_MS, tick: (signal) => deps.service.tick(signal) };
}

/** care-worker loop `availability-sweep`: the full rank-index recomputation, a singleton by advisory lock (AV-R23). */
export function buildAvailabilitySweepLoop(deps: { service: TickService; intervalSeconds: number }): WorkerLoop {
    return { name: SWEEP_LOOP_NAME, intervalMs: deps.intervalSeconds * 1000, tick: (signal) => deps.service.tick(signal) };
}
