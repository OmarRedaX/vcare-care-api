import type { Knex } from "knex";
import type { Env } from "../config/types";
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

/** What `buildWorkerLoops` hands every loop: the worker's own Postgres pool (`care-worker`), never the API's. */
export interface WorkerLoopDeps {
    env: Env;
    db: Knex;
    logger: Logger;
}
