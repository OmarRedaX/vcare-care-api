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

/** `{ name, message, code?, stack? }` — never pg `detail`, `where`, `parameters`, `query`, or `bindings`. */
export function serializeError(error: unknown): SerializedError {
    if (error instanceof Error) {
        const code = (error as { code?: unknown }).code;
        return {
            name: error.name,
            message: error.message,
            ...(typeof code === "string" ? { code } : {}),
            ...(typeof error.stack === "string" ? { stack: error.stack } : {}),
        };
    }
    return { name: "NonError", message: typeof error === "string" ? error : "Unknown error" };
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
