import { logger as rootLogger } from "../logger/logger";
import type { RunMainDeps } from "./types";

/**
 * Runs an entrypoint's `main` (server, worker, migrate). A synchronous throw or a rejection during boot becomes ONE
 * JSON line `error boot_failed` (serialized error) and exit 1 — never Node's default multi-line stack on stderr.
 */
export function runMain(main: () => void | Promise<void>, deps: RunMainDeps = {}): void {
    const logger = deps.logger ?? rootLogger;
    const exit = deps.exit ?? ((code: number) => process.exit(code));
    const fail = (error: unknown): void => {
        logger.error("boot_failed", { error });
        exit(1);
    };

    try {
        const result = main();
        if (result instanceof Promise) {
            result.catch(fail);
        }
    } catch (error) {
        fail(error);
    }
}
