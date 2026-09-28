import { settleWithin } from "../async/settle-within";
import type { GracefulShutdownDeps, ResourceCloseOutcome } from "./types";

/** Every resource gets at least this long, even when the drain used up the whole deadline. */
const MIN_RESOURCE_BUDGET_MS = 250;

/** Resolves on the next macrotask — after Node has returned the last response's socket to the idle set. */
function nextMacrotask(): Promise<void> {
    return new Promise<void>((resolve) => setImmediate(resolve));
}

/**
 * Not-ready → close listeners → drain in-flight requests (bounded) → close resources (bounded) → exit.
 * Repeated calls return the first call's promise.
 */
export function createGracefulShutdown(deps: GracefulShutdownDeps): (reason: string, exitCode?: 0 | 1) => Promise<void> {
    const setTimer = deps.setTimer ?? setTimeout;
    const now = deps.now ?? Date.now;
    let running: Promise<void> | undefined;

    const run = async (reason: string, exitCode?: 0 | 1): Promise<void> => {
        const startedAt = now();
        // From here on `inFlight()` marks every response `Connection: close`, so sockets close after their last response.
        deps.state.markShuttingDown();
        deps.logger.info("shutdown_started", { reason });

        const closed = deps.servers.map(
            (server) =>
                new Promise<void>((resolve) => {
                    server.close(() => resolve());
                    server.closeIdleConnections();
                }),
        );
        // A keep-alive socket that carried an in-flight request is not idle at close() time and would otherwise stay
        // open (keepAliveTimeout 65 s), so the close callback would never fire: close it once the last request ends.
        const drained = deps.inFlight
            .whenIdle()
            .then(nextMacrotask)
            .then(() => {
                for (const server of deps.servers) {
                    server.closeIdleConnections();
                }
            });

        let timedOut = false;
        let timer: NodeJS.Timeout | undefined;
        const deadline = new Promise<void>((resolve) => {
            timer = setTimer(() => {
                timedOut = true;
                resolve();
            }, deps.timeoutMs);
        });

        await Promise.race([Promise.all([drained, ...closed]).then(() => undefined), deadline]);
        if (timer !== undefined) {
            clearTimeout(timer);
        }

        if (timedOut) {
            deps.logger.error("shutdown_timeout", { unfinishedRequests: deps.inFlight.count });
            for (const server of deps.servers) {
                server.closeAllConnections();
            }
        }

        // Each resource is bounded by what remains of the deadline: a pool stuck on a dead primary must not hold
        // the process until the orchestrator kills it.
        let resourceTimedOut = false;
        for (const close of deps.closeResources) {
            const budgetMs = Math.max(MIN_RESOURCE_BUDGET_MS, deps.timeoutMs - (now() - startedAt));
            const outcome = await settleWithin<ResourceCloseOutcome>(
                close().then(
                    () => "closed",
                    (error: unknown) => {
                        deps.logger.error("shutdown_resource_failed", { error });
                        return "failed";
                    },
                ),
                budgetMs,
                "timeout",
            );
            if (outcome === "timeout") {
                resourceTimedOut = true;
                deps.logger.error("shutdown_resource_timeout", { budgetMs });
            }
        }

        deps.logger.info("shutdown_complete", { reason });
        deps.exit(timedOut || resourceTimedOut || exitCode === 1 ? 1 : (exitCode ?? 0));
    };

    return (reason: string, exitCode?: 0 | 1): Promise<void> => {
        running ??= run(reason, exitCode);
        return running;
    };
}
