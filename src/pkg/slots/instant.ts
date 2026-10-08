import { DateTime, IANAZone } from "luxon";
import { addDays, assertValidZone } from "./local-date";
import type { InstantEdge } from "./types";

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

/**
 * The first whole minute in `(loMs, hiMs]` at which the zone offset equals the offset at `hiMs`
 * (`loMs` and `hiMs` have different offsets): the DST transition instant.
 */
function transitionBetween(zone: IANAZone, loMs: number, hiMs: number): number {
    const target = zone.offset(hiMs);
    let lo = 0;
    let hi = Math.round((hiMs - loMs) / MINUTE_MS);
    while (hi - lo > 1) {
        const mid = Math.floor((lo + hi) / 2);
        if (zone.offset(loMs + mid * MINUTE_MS) === target) {
            hi = mid;
        } else {
            lo = mid;
        }
    }
    return loMs + hi * MINUTE_MS;
}

/**
 * The UTC instant (epoch ms) of a doctor-local wall time. `minute = 1440` is the next local midnight.
 * Normal times map to one instant; an ambiguous wall time (fall-back overlap) maps to the earlier instant for a
 * `start` edge and the later one for an `end` edge; a nonexistent wall time (spring-forward gap) maps to the
 * transition instant for both edges. Durations between instants are therefore always real elapsed minutes.
 */
export function localInstant(date: string, minute: number, timezone: string, edge: InstantEdge): number {
    assertValidZone(timezone);
    if (!Number.isInteger(minute) || minute < 0 || minute > 1440) {
        throw new RangeError("Minute out of range");
    }
    const wallDate = minute === 1440 ? addDays(date, 1) : date;
    const wallMinute = minute === 1440 ? 0 : minute;
    const midnight = DateTime.fromISO(wallDate, { zone: "utc" }).toMillis();
    const wall = midnight + wallMinute * MINUTE_MS;

    const zone = IANAZone.create(timezone);
    const before = zone.offset(wall - DAY_MS);
    const after = zone.offset(wall + DAY_MS);
    const candidates: number[] = [];
    for (const offset of before === after ? [before] : [before, after]) {
        const instant = wall - offset * MINUTE_MS;
        if (zone.offset(instant) === offset && !candidates.includes(instant)) {
            candidates.push(instant);
        }
    }

    const first = candidates[0];
    if (first === undefined) {
        const low = wall - Math.max(before, after) * MINUTE_MS;
        const high = wall - Math.min(before, after) * MINUTE_MS;
        return transitionBetween(zone, low, high);
    }
    const second = candidates[1];
    if (second === undefined) {
        return first;
    }
    return edge === "start" ? Math.min(first, second) : Math.max(first, second);
}
