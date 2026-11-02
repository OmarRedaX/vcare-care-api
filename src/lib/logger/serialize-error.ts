import { AppError } from "../error/AppError";
import type { SerializedError } from "./types";

/** A Postgres SQLSTATE (`22P02`, `23514`, …): the error came from the database and its message may hold a value. */
const SQLSTATE_PATTERN = /^[0-9A-Z]{5}$/;
const STACK_FRAME_PATTERN = /^\s+at /;
/** Identifier-only pg fields that are safe to log (never `detail`, `where`, `hint`, `query`, `parameters`). */
const DATABASE_ERROR_FIELDS = ["severity", "constraint", "table", "column", "routine"] as const;

/**
 * `name` + the `at …` frame lines only. V8 formats `err.stack` lazily, so its header repeats a message that was
 * mutated after construction (Knex prefixes the SQL) and may span several lines — none of it is kept.
 */
function framesOnly(error: Error): string | undefined {
    if (typeof error.stack !== "string") {
        return undefined;
    }
    const frames = error.stack.split("\n").filter((line) => STACK_FRAME_PATTERN.test(line));
    return frames.join("\n");
}

/**
 * Non-AppError messages may contain secrets. Keep only a fixed category and safe identifiers.
 * Never pg `detail`, `where`, `hint`, `parameters`, `query`, or `bindings` (spec §3.4.4).
 */
export function serializeError(error: unknown): SerializedError {
    if (!(error instanceof Error)) {
        return { name: "NonError", message: "A non-Error value was thrown" };
    }
    const code = (error as { code?: unknown }).code;
    const stack = framesOnly(error);

    if (typeof code === "string" && SQLSTATE_PATTERN.test(code)) {
        const serialized: SerializedError = { name: error.name, message: `pg_error:${code}`, code };
        const source = error as unknown as Record<string, unknown>;
        for (const field of DATABASE_ERROR_FIELDS) {
            const value = source[field];
            if (typeof value === "string") {
                serialized[field] = value;
            }
        }
        if (stack !== undefined) {
            serialized.stack = stack;
        }
        return serialized;
    }

    return {
        name: error.name,
        message: error instanceof AppError ? error.message : `error:${error.name}`,
        ...(typeof code === "string" ? { code } : {}),
        ...(stack !== undefined ? { stack } : {}),
    };
}
