import type { OpenDay } from "./types";

const MINUTE_MS = 60_000;

/**
 * Whether a booking start sits on the slot grid of ONE open interval: the interval holds the whole slot and the start is a
 * whole number of durations after the interval's start. The grid is anchored on the working interval's start and steps by
 * the duration in real elapsed minutes (so it survives a DST change inside the interval); busy consultations never move
 * it. Intervals are per doctor-local date and are NOT merged across dates, so a slot cannot straddle local midnight.
 * Overlap with other consultations is the database constraint's job, not this function's. Pure: epoch ms in, boolean out.
 */
export function isSlotOnGrid(days: readonly OpenDay[], startMs: number, durationMinutes: number): boolean {
    if (!Number.isInteger(durationMinutes) || durationMinutes < 1 || !Number.isFinite(startMs)) {
        return false;
    }
    const durationMs = durationMinutes * MINUTE_MS;
    for (const day of days) {
        for (const interval of day.intervals) {
            if (interval.startMs <= startMs && startMs + durationMs <= interval.endMs && (startMs - interval.startMs) % durationMs === 0) {
                return true;
            }
        }
    }
    return false;
}

/** Whether `[startMs, endMs)` lies inside ONE open interval (containment, no grid check). Pure. */
export function isCoveredByOpenIntervals(days: readonly OpenDay[], startMs: number, endMs: number): boolean {
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
        return false;
    }
    for (const day of days) {
        for (const interval of day.intervals) {
            if (interval.startMs <= startMs && endMs <= interval.endMs) {
                return true;
            }
        }
    }
    return false;
}
