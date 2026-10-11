import type { LogLevel } from "../config/types";
import type { Role } from "../types/types";

export type LogFields = Record<string, unknown>;

export type MetricDims = Record<string, string | number | boolean>;

export interface LoggerOptions {
    level: LogLevel;
    service: string;
    bindings?: LogFields;
    /** Defaults to `process.stdout.write`. Tests inject a collector. */
    write?: (line: string) => void;
    /** Defaults to `() => new Date()`. */
    now?: () => Date;
}

/**
 * Error log fields use a safe category in place of non-AppError messages. Database errors retain only identifiers.
 */
export interface SerializedError {
    name: string;
    message?: string;
    code?: string;
    severity?: string;
    constraint?: string;
    table?: string;
    column?: string;
    routine?: string;
    stack?: string;
}

/** Carried through the whole request by AsyncLocalStorage so every log line has the request id. */
export interface RequestContext {
    requestId: string;
    userId?: number;
    role?: Role;
    clientId?: string;
}
