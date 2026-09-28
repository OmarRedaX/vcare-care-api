import type http from "node:http";
import type { Logger } from "../logger/logger";
import type { InFlightCounter } from "./in-flight";
import type { ShutdownState } from "./shutdown-state";

export interface GracefulShutdownDeps {
    servers: http.Server[];
    state: ShutdownState;
    inFlight: InFlightCounter;
    timeoutMs: number;
    /** Closed in order after the listeners drain (`db`, `probeDb`, then Redis), each bounded by the remaining deadline. */
    closeResources: Array<() => Promise<void>>;
    logger: Logger;
    exit: (code: number) => void;
    setTimer?: typeof setTimeout;
    /** Clock for the remaining-deadline budget of `closeResources` (default `Date.now`). */
    now?: () => number;
}

export type ResourceCloseOutcome = "closed" | "failed" | "timeout";

export interface RunMainDeps {
    /** Defaults to the root logger. */
    logger?: Logger;
    /** Defaults to `process.exit`. */
    exit?: (code: number) => void;
}
