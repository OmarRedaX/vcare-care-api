import { ValidationFailed } from "../../lib/error/errors";
import { toMs } from "../../pkg/utils/time";
import { AUDIT_DEFAULT_WINDOW_DAYS } from "./constants";
import type { AuditWindow } from "./types";

const FROM_AFTER_TO = ValidationFailed.withDetails([{ field: "from", issue: "must not be later than to" }]);

/**
 * Effective window `[from, to)` (spec R3/R4). `to` = the request's `to`, else the one frozen into the cursor, else the clock
 * (read lazily: only the first page without `to` reads it). `from` defaults to `to` minus 30 days. `from > to` is a 400;
 * `from == to` is a valid empty window. Pure: the clock is passed in.
 */
export function resolveAuditWindow(now: () => number, from: Date | undefined, to: Date | undefined, cursorTo: Date | undefined): AuditWindow {
    const effectiveTo = to ?? cursorTo ?? new Date(now());
    const effectiveFrom = from ?? new Date(effectiveTo.getTime() - toMs(AUDIT_DEFAULT_WINDOW_DAYS, "d"));
    if (effectiveFrom.getTime() > effectiveTo.getTime()) throw FROM_AFTER_TO;
    return { from: effectiveFrom, to: effectiveTo, empty: effectiveFrom.getTime() === effectiveTo.getTime() };
}
