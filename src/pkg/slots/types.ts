/** Local wall-clock interval as minutes since doctor-local midnight: `0 <= startMinute < endMinute <= 1440` (`1440` = `24:00`). */
export interface LocalInterval {
    startMinute: number;
    endMinute: number;
}

/** Recurring weekly hours of one ISO weekday (1 = Monday ... 7 = Sunday). */
export interface WeeklyHoursRule {
    weekday: number;
    intervals: readonly LocalInterval[];
}

export type ExceptionRuleType = "day_off" | "custom_hours";

/** A per-date override: `day_off` removes the date, `custom_hours` replaces that weekday's hours. */
export interface ExceptionRule {
    date: string;
    type: ExceptionRuleType;
    startMinute: number | null;
    endMinute: number | null;
}

/** Half-open `[startMs, endMs)` in epoch milliseconds. */
export interface UtcInterval {
    startMs: number;
    endMs: number;
}

export interface ResolveOpenIntervalsInput {
    timezone: string;
    weekly: readonly WeeklyHoursRule[];
    exceptions: readonly ExceptionRule[];
    /** Inclusive doctor-local dates, `YYYY-MM-DD`. */
    fromDate: string;
    toDate: string;
}

export interface OpenDay {
    date: string;
    intervals: UtcInterval[];
}

/** Which end of an interval a wall time is: a start rounds to the earlier instant, an end to the later one. */
export type InstantEdge = "start" | "end";
