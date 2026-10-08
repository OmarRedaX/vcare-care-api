import type { LocalInterval, UtcInterval } from "./types";

/** Sort, drop empty, and merge overlapping AND touching local intervals. The input is not mutated. */
export function mergeLocalIntervals(intervals: readonly LocalInterval[]): LocalInterval[] {
    const sorted = intervals
        .filter((interval) => interval.endMinute > interval.startMinute)
        .map((interval) => ({ startMinute: interval.startMinute, endMinute: interval.endMinute }))
        .sort((a, b) => a.startMinute - b.startMinute || a.endMinute - b.endMinute);
    const merged: LocalInterval[] = [];
    for (const interval of sorted) {
        const last = merged[merged.length - 1];
        if (last !== undefined && interval.startMinute <= last.endMinute) {
            last.endMinute = Math.max(last.endMinute, interval.endMinute);
        } else {
            merged.push(interval);
        }
    }
    return merged;
}

/** Sort, drop empty, and merge overlapping AND touching UTC intervals. The input is not mutated. */
export function mergeUtcIntervals(intervals: readonly UtcInterval[]): UtcInterval[] {
    const sorted = intervals
        .filter((interval) => interval.endMs > interval.startMs)
        .map((interval) => ({ startMs: interval.startMs, endMs: interval.endMs }))
        .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
    const merged: UtcInterval[] = [];
    for (const interval of sorted) {
        const last = merged[merged.length - 1];
        if (last !== undefined && interval.startMs <= last.endMs) {
            last.endMs = Math.max(last.endMs, interval.endMs);
        } else {
            merged.push(interval);
        }
    }
    return merged;
}
