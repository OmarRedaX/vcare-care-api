import type { DurationUnit } from "./types";

const UNIT_MS: Record<DurationUnit, number> = {
    ms: 1,
    s: 1_000,
    min: 60_000,
    h: 3_600_000,
    d: 86_400_000,
};

/** Pure duration maths — no clock, no Date arithmetic. Schedule maths lives in `pkg/slots` with luxon. */
export function toMs(value: number, unit: DurationUnit): number {
    if (!Number.isFinite(value) || value < 0) {
        throw new RangeError("Duration must be a finite, non-negative number");
    }
    return value * UNIT_MS[unit];
}

export function toSeconds(value: number, unit: DurationUnit): number {
    return Math.floor(toMs(value, unit) / 1_000);
}
