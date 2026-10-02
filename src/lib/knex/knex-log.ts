import type { Knex } from "knex";
import type { Logger } from "../logger/logger";

const MAX_SUMMARY_LENGTH = 200;

/** Knex embeds multi-line stacks in its text: only the first line is kept, bounded. */
function summarize(message: unknown): string {
    const text = message instanceof Error ? message.name : typeof message === "string" ? message : "non-string message";
    return (text.split("\n", 1)[0] ?? "").slice(0, MAX_SUMMARY_LENGTH);
}

/**
 * Routes Knex's own messages (pool acquire errors, deprecations) through `Logger`, so no raw, ANSI-coloured
 * `console.log` line ever breaks the one-JSON-line log format (spec §3.4.4, ADR 0007). Knex's debug output is raw
 * SQL, so only the event is logged, never the text.
 */
export function buildKnexLog(logger: Logger): Knex.Logger {
    return {
        warn: (message: unknown) => {
            logger.warn("knex_warn", { summary: summarize(message) });
        },
        error: (message: unknown) => {
            logger.error("knex_error", { summary: summarize(message) });
        },
        debug: () => {
            logger.debug("knex_debug");
        },
        deprecate: (method: string, alternative: string) => {
            logger.warn("knex_deprecated", { method, alternative });
        },
        enableColors: false,
    };
}
