import { mergeUtcIntervals } from "./intervals";
import type { FreeSegment, OpenDay, UtcInterval } from "./types";

/** Subtract half-open busy ranges without moving each working interval's grid anchor. */
export function subtractBusy(days: readonly OpenDay[], busy: readonly UtcInterval[]): FreeSegment[] {
    const intervals = days.flatMap((day) => day.intervals).filter((range) => range.endMs > range.startMs)
        .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
    const occupied = mergeUtcIntervals(busy);
    const free: FreeSegment[] = [];
    let pointer = 0;
    for (const interval of intervals) {
        while (pointer < occupied.length && occupied[pointer]!.endMs <= interval.startMs) pointer += 1;
        let cursor = interval.startMs;
        for (let i = pointer; i < occupied.length; i += 1) {
            const block = occupied[i]!;
            if (block.startMs >= interval.endMs) break;
            if (block.startMs > cursor) free.push({ anchorMs: interval.startMs, startMs: cursor, endMs: Math.min(block.startMs, interval.endMs) });
            cursor = Math.max(cursor, block.endMs);
            if (cursor >= interval.endMs) break;
        }
        if (cursor < interval.endMs) free.push({ anchorMs: interval.startMs, startMs: cursor, endMs: interval.endMs });
    }
    return free;
}
