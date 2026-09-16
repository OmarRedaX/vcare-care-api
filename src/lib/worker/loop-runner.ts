import type { LoopRunnerDeps, WorkerLoop } from "./types";

const DEFAULT_HEARTBEAT_MS = 30_000;

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) {
        return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
            signal.removeEventListener("abort", onAbort);
            resolve();
        }, ms);
        const onAbort = (): void => {
            clearTimeout(timer);
            resolve();
        };
        signal.addEventListener("abort", onAbort, { once: true });
    });
}

/**
 * Runs the worker's loops (ADR 0008). Ticks never overlap for the same loop; a throwing tick is logged
 * and the loop continues after its interval. The runner's own heartbeat keeps an empty worker alive and
 * feeds `WorkerHeartbeatStale`.
 */
export class LoopRunner {
    private readonly heartbeatEveryMs: number;
    private readonly lastHeartbeat = new Map<string, number>();
    private controller = new AbortController();
    private running: Array<Promise<void>> = [];
    private runnerTimer?: NodeJS.Timeout;
    private started = false;

    constructor(
        private readonly loops: WorkerLoop[],
        private readonly deps: LoopRunnerDeps,
    ) {
        this.heartbeatEveryMs = deps.heartbeatEveryMs ?? DEFAULT_HEARTBEAT_MS;
    }

    start(): void {
        if (this.started) {
            return;
        }
        this.started = true;
        this.controller = new AbortController();

        this.runnerTimer = setInterval(() => {
            this.deps.logger.metric("worker_heartbeat", 1, { loop: "runner" });
        }, this.heartbeatEveryMs);

        this.running = this.loops.map((loop) => this.runLoop(loop));
    }

    async stop(): Promise<void> {
        if (!this.started) {
            return;
        }
        this.started = false;
        this.controller.abort();
        if (this.runnerTimer !== undefined) {
            clearInterval(this.runnerTimer);
            this.runnerTimer = undefined;
        }
        await Promise.all(this.running);
        this.running = [];
    }

    private async runLoop(loop: WorkerLoop): Promise<void> {
        const signal = this.controller.signal;
        while (!signal.aborted) {
            try {
                await loop.tick(signal);
                this.heartbeat(loop.name);
            } catch (error) {
                this.deps.logger.error("worker_tick_failed", { loop: loop.name, error });
            }
            if (signal.aborted) {
                return;
            }
            await abortableSleep(loop.intervalMs, signal);
        }
    }

    private heartbeat(loop: string): void {
        const now = Date.now();
        const last = this.lastHeartbeat.get(loop);
        if (last !== undefined && now - last < this.heartbeatEveryMs) {
            return;
        }
        this.lastHeartbeat.set(loop, now);
        this.deps.logger.metric("worker_heartbeat", 1, { loop });
    }
}
