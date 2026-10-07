import type { Knex } from "knex";
import type { Env } from "../config/types";
import type { Logger } from "../logger/logger";
import type { ObjectStorage } from "../storage/object-storage";
import type { IdentityClient } from "../identity-client/identity-client";

/**
 * What a tick may report besides throwing: `"incomplete"` = it ran without throwing but did not achieve its goal (e.g.
 * the partitions were not ensured). The long-running `LoopRunner` ignores it (the next tick retries);
 * `worker --once <loop>` exits 1 on it. `void` / `"done"` = success.
 */
export type TickOutcome = "done" | "incomplete";

export interface WorkerLoop {
    name: string;
    intervalMs: number;
    /** Receives an AbortSignal: on stop it aborts, and the tick should finish its current batch promptly. */
    tick(signal: AbortSignal): Promise<TickOutcome | void>;
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
    storage: ObjectStorage;
    identity: IdentityClient;
}
