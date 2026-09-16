import type { GracefulShutdownDeps } from "./types";

/**
 * Not-ready → close listeners → drain in-flight requests (bounded) → close resources → exit.
 * Repeated calls return the first call's promise.
 */
export function createGracefulShutdown(deps: GracefulShutdownDeps): (reason: string, exitCode?: 0 | 1) => Promise<void> {
    const setTimer = deps.setTimer ?? setTimeout;
    let running: Promise<void> | undefined;

    const run = async (reason: string, exitCode?: 0 | 1): Promise<void> => {
        deps.state.markShuttingDown();
        deps.logger.info("shutdown_started", { reason });

        const closed = deps.servers.map(
            (server) =>
                new Promise<void>((resolve) => {
                    server.close(() => resolve());
                    server.closeIdleConnections();
                }),
        );

        let timedOut = false;
        let timer: NodeJS.Timeout | undefined;
        const deadline = new Promise<void>((resolve) => {
            timer = setTimer(() => {
                timedOut = true;
                resolve();
            }, deps.timeoutMs);
        });

        await Promise.race([Promise.all([deps.inFlight.whenIdle(), ...closed]).then(() => undefined), deadline]);
        if (timer !== undefined) {
            clearTimeout(timer);
        }

        if (timedOut) {
            deps.logger.error("shutdown_timeout", { unfinishedRequests: deps.inFlight.count });
            for (const server of deps.servers) {
                server.closeAllConnections();
            }
        }

        for (const close of deps.closeResources) {
            try {
                await close();
            } catch (error) {
                deps.logger.error("shutdown_resource_failed", { error });
            }
        }

        deps.logger.info("shutdown_complete", { reason });
        deps.exit(timedOut || exitCode === 1 ? 1 : (exitCode ?? 0));
    };

    return (reason: string, exitCode?: 0 | 1): Promise<void> => {
        running ??= run(reason, exitCode);
        return running;
    };
}
