import type http from "node:http";
import type { Logger } from "../logger/logger";
import type { InFlightCounter } from "./in-flight";
import type { ShutdownState } from "./shutdown-state";

export interface GracefulShutdownDeps {
    servers: http.Server[];
    state: ShutdownState;
    inFlight: InFlightCounter;
    timeoutMs: number;
    /** Closed in order after the listeners drain: `db.destroy()`, then `redis.quit()`. */
    closeResources: Array<() => Promise<void>>;
    logger: Logger;
    exit: (code: number) => void;
    setTimer?: typeof setTimeout;
}
