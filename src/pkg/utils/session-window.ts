import { toMs } from "./time";
import type { SessionWindow } from "./types";

/** `opensAt = startsAt - openMinutes`, `closesAt = endsAt + overrunMinutes` (Domain rule 12). Pure; instants are UTC milliseconds. */
export function sessionWindow(startsAtMs: number, endsAtMs: number, openMinutes: number, overrunMinutes: number): SessionWindow {
    return { opensAtMs: startsAtMs - toMs(openMinutes, "min"), closesAtMs: endsAtMs + toMs(overrunMinutes, "min") };
}

/** Half-open: a token issued at `opensAt` is valid, one issued at `closesAt` would have no life left. */
export function isInsideWindow(window: SessionWindow, nowMs: number): boolean {
    return window.opensAtMs <= nowMs && nowMs < window.closesAtMs;
}
