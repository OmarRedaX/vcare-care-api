import type { ClippedWindow } from "./types";

export function clipWindow(fromMs: number, toMs: number, nowMs: number, horizonMs: number): ClippedWindow {
    const from = Math.min(Math.max(fromMs, nowMs), horizonMs);
    const to = Math.min(Math.max(toMs, from), horizonMs);
    return { fromMs: from, toMs: to, empty: from >= to };
}
