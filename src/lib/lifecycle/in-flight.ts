import type { RequestHandler } from "express";
import { container } from "../di/container";
import { TOKENS } from "../di/tokens";

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

/** Counts live requests so shutdown can drain them. Decrements exactly once per request. */
export function inFlight(counter?: InFlightCounter): RequestHandler {
    return (_req, res, next) => {
        const target =
            counter ??
            (container.isRegistered(TOKENS.InFlightCounter)
                ? container.resolve<InFlightCounter>(TOKENS.InFlightCounter)
                : undefined);
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
        res.on("close", release);

        next();
    };
}
