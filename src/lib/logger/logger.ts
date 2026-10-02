import { getEnv } from "../config/env";
import type { LogLevel } from "../config/types";
import { redact } from "./redact";
import { requestContext } from "./request-context";
import type { LogFields, LoggerOptions, MetricDims, SerializedError } from "./types";

const LEVEL_WEIGHT: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Parity field order with identity-service (spec §1.4). Remaining fields follow in insertion order. */
const ORDERED_FIELDS = [
    "requestId",
    "userId",
    "role",
    "clientId",
    "route",
    "method",
    "status",
    "code",
    "durationMs",
] as const;

const METRIC_NAME_PATTERN = /^[a-z][a-z0-9_]*$/;

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
    return [error.name, ...frames].join("\n");
}

/**
 * Database errors → `{ name, code, severity?, constraint?, table?, column?, routine?, stack? }` with NO message;
 * other errors → `{ name, message, code?, stack? }`; non-Errors → a fixed placeholder (the value is never logged).
 * Never pg `detail`, `where`, `hint`, `parameters`, `query`, or `bindings` (spec §3.4.4).
 */
export function serializeError(error: unknown): SerializedError {
    if (!(error instanceof Error)) {
        return { name: "NonError", message: "A non-Error value was thrown" };
    }
    const code = (error as { code?: unknown }).code;
    const stack = framesOnly(error);

    if (typeof code === "string" && SQLSTATE_PATTERN.test(code)) {
        const serialized: SerializedError = { name: error.name, code };
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
        message: error.message,
        ...(typeof code === "string" ? { code } : {}),
        ...(stack !== undefined ? { stack } : {}),
    };
}

export class Logger {
    private readonly level: LogLevel;
    private readonly service: string;
    private readonly bindings: LogFields;
    private readonly write: (line: string) => void;
    private readonly now: () => Date;

    constructor(options: LoggerOptions) {
        this.level = options.level;
        this.service = options.service;
        this.bindings = options.bindings ?? {};
        this.write = options.write ?? ((line: string) => void process.stdout.write(line));
        this.now = options.now ?? (() => new Date());
    }

    debug(message: string, fields?: LogFields): void {
        this.emit("debug", message, fields);
    }

    info(message: string, fields?: LogFields): void {
        this.emit("info", message, fields);
    }

    warn(message: string, fields?: LogFields): void {
        this.emit("warn", message, fields);
    }

    error(message: string, fields?: LogFields): void {
        this.emit("error", message, fields);
    }

    /**
     * Log-derived metric (ADR 0007). Emitted at `info` regardless of LOG_LEVEL unless the level is `error`.
     * `dims` must hold bounded labels only — never user ids, IPs, or keys.
     */
    metric(name: string, value: number, dims?: MetricDims): void {
        if (!METRIC_NAME_PATTERN.test(name) || !Number.isFinite(value)) {
            const reason = METRIC_NAME_PATTERN.test(name) ? "value must be finite" : "name must be snake_case";
            if (getEnv().NODE_ENV === "production") {
                this.emit("warn", "invalid_metric", { metric: name, reason });
                return;
            }
            throw new Error(`Invalid metric: ${reason}`);
        }
        if (this.level === "error") {
            return;
        }
        this.emit("info", "metric", { metric: name, value, dims: dims ?? {} }, true);
    }

    child(bindings: LogFields): Logger {
        return new Logger({
            level: this.level,
            service: this.service,
            bindings: { ...this.bindings, ...bindings },
            write: this.write,
            now: this.now,
        });
    }

    private emit(level: LogLevel, message: string, fields?: LogFields, force = false): void {
        if (!force && LEVEL_WEIGHT[level] < LEVEL_WEIGHT[this.level]) {
            return;
        }

        // Precedence: request-context store < child bindings < explicit fields.
        const merged: LogFields = { ...requestContext.getStore(), ...this.bindings, ...fields };
        if (merged.error !== undefined) {
            merged.error = serializeError(merged.error);
        }
        const safe = redact(merged) as LogFields;

        const line: Record<string, unknown> = {
            level,
            message,
            timestamp: this.now().toISOString(),
            service: this.service,
        };
        for (const key of ORDERED_FIELDS) {
            if (safe[key] !== undefined) {
                line[key] = safe[key];
            }
        }
        for (const [key, value] of Object.entries(safe)) {
            if (!(key in line) && value !== undefined) {
                line[key] = value;
            }
        }
        this.write(`${JSON.stringify(line)}\n`);
    }
}

/** Root logger. Module-scoped so `lib/` code can log without a container lookup. */
export const logger = new Logger({ level: getEnv().LOG_LEVEL, service: "care-service" });
