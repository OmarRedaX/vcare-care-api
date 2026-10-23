import { subtractBusy } from "./busy";
import { addDays, localDateOf } from "./local-date";
import { resolveOpenIntervals } from "./resolve-open-intervals";
import { sliceSlots } from "./slice";
import type { ComputeSlotsInput, SlotRange } from "./types";

export function computeSlots(input: ComputeSlotsInput): SlotRange[] {
    if (input.bounds.toMs <= input.bounds.fromMs) return [];
    const days = resolveOpenIntervals({ timezone: input.timezone, weekly: input.weekly, exceptions: input.exceptions,
        fromDate: addDays(localDateOf(input.bounds.fromMs, input.timezone), -1),
        toDate: addDays(localDateOf(input.bounds.toMs - 1, input.timezone), 1) });
    return sliceSlots(subtractBusy(days, input.busy), input.durationMinutes, input.bounds);
}
