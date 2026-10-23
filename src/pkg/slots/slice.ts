import type { FreeSegment, SlotRange, StartBounds } from "./types";

function stepOf(durationMinutes: number): number {
    if (!Number.isInteger(durationMinutes) || durationMinutes < 1) throw new RangeError("Invalid slot duration");
    return durationMinutes * 60_000;
}

function firstOnGrid(segment: FreeSegment, fromMs: number, step: number): number {
    return segment.anchorMs + Math.max(0, Math.ceil((Math.max(segment.startMs, fromMs) - segment.anchorMs) / step)) * step;
}

export function sliceSlots(segments: readonly FreeSegment[], durationMinutes: number, bounds: StartBounds): SlotRange[] {
    const step = stepOf(durationMinutes);
    const slots: SlotRange[] = [];
    for (const segment of segments) {
        for (let startMs = firstOnGrid(segment, bounds.fromMs, step); startMs < bounds.toMs && startMs + step <= segment.endMs; startMs += step) {
            slots.push({ startMs, endMs: startMs + step });
        }
    }
    slots.sort((a, b) => a.startMs - b.startMs);
    return slots.filter((slot, index) => index === 0 || slot.startMs !== slots[index - 1]?.startMs);
}

export function firstFreeStart(segments: readonly FreeSegment[], durationMinutes: number, bounds: StartBounds): number | null {
    const step = stepOf(durationMinutes);
    let earliest: number | null = null;
    for (const segment of segments) {
        const start = firstOnGrid(segment, bounds.fromMs, step);
        if (start < bounds.toMs && start + step <= segment.endMs && (earliest === null || start < earliest)) earliest = start;
    }
    return earliest;
}
