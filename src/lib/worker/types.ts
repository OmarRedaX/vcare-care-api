import type { Logger } from "../logger/logger";

export interface WorkerLoop {
    name: string;
    intervalMs: number;
    /** Receives an AbortSignal: on stop it aborts, and the tick should finish its current batch promptly. */
    tick(signal: AbortSignal): Promise<void>;
}

export interface LoopRunnerDeps {
    logger: Logger;
    heartbeatEveryMs?: number;
}
