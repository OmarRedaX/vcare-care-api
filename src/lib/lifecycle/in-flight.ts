import type { RequestHandler, Response } from "express";
import { container } from "../di/container";
import { TOKENS } from "../di/tokens";
import type { ShutdownState } from "./shutdown-state";
import { markPreAuth } from "../rbac/markers";

export class InFlightCounter {
    private current = 0;
    private waiters: Array<() => void> = [];

    get count(): number {
        return this.current;
    }

    increment(): void {
        this.current += 1;
    }

    decrement(): void {
        this.current = Math.max(0, this.current - 1);
        if (this.current === 0) {
            const waiters = this.waiters;
            this.waiters = [];
            for (const resolve of waiters) {
                resolve();
            }
        }
    }

    whenIdle(): Promise<void> {
        if (this.current === 0) {
            return Promise.resolve();
        }
        return new Promise<void>((resolve) => {
            this.waiters.push(resolve);
        });
    }
}

/**
 * While shutting down, every response is written with `Connection: close`, so Node closes a keep-alive socket after
 * its last response instead of leaving it idle and open (which would hold `server.close()` until keepAliveTimeout).
 * The header is decided when the headers are written, so a request that was already in flight at SIGTERM gets it too.
 */
function closeConnectionWhenDraining(res: Response, state: ShutdownState): void {
    if (typeof res.writeHead !== "function") {
        return;
    }
    const originalWriteHead = res.writeHead.bind(res) as (...args: unknown[]) => Response;
    res.writeHead = ((...args: unknown[]) => {
        if (state.isShuttingDown() && !res.headersSent) {
            res.setHeader("Connection", "close");
        }
        return originalWriteHead(...args);
    }) as Response["writeHead"];
}

/**
 * Counts live requests so shutdown can drain them. Decrements exactly once per request, when the HANDLER is done:
 * `finish` on the normal path, or the handler's own `res.end()` after the client already went away. A client abort emits
 * `close` while the handler keeps running (Node never emits `finish` for it), so releasing on `close` alone would let shutdown
 * destroy the pools and quit Redis under a write that is still in progress (#12).
 */
export function inFlight(counter?: InFlightCounter, state?: ShutdownState): RequestHandler {
    return markPreAuth((_req, res, next) => {
        const target =
            counter ??
            (container.isRegistered(TOKENS.InFlightCounter)
                ? container.resolve<InFlightCounter>(TOKENS.InFlightCounter)
                : undefined);
        const shutdownState =
            state ??
            (container.isRegistered(TOKENS.ShutdownState) ? container.resolve<ShutdownState>(TOKENS.ShutdownState) : undefined);
        if (shutdownState !== undefined) {
            closeConnectionWhenDraining(res, shutdownState);
        }
        if (target === undefined) {
            next();
            return;
        }

        target.increment();
        let released = false;
        const release = (): void => {
            if (released) {
                return;
            }
            released = true;
            target.decrement();
        };
        res.on("finish", release);
        if (typeof res.end !== "function") {
            res.on("close", release);
            next();
            return;
        }
        let closed = false;
        res.on("close", () => {
            closed = true;
            if (res.writableEnded) {
                release();
            }
        });
        const originalEnd = res.end.bind(res) as (...args: unknown[]) => Response;
        res.end = ((...args: unknown[]) => {
            const result = originalEnd(...args);
            if (closed) {
                release();
            }
            return result;
        }) as Response["end"];

        next();
    });
}
