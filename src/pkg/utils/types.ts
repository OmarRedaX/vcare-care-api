export type DurationUnit = "ms" | "s" | "min" | "h" | "d";

/** The half-open interval `[opensAtMs, closesAtMs)` in which a session room is open. */
export interface SessionWindow { opensAtMs: number; closesAtMs: number }
