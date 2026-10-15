import { getEnv } from "../../src/lib/config/env";
import type { ConsultationsHarness } from "./consultations-harness";
import { localStart, MINUTE } from "./consultations-harness";

/** Synthetic marker for the no-show note: it must never reach a response, a log line, an audit row or a stored column. */
export const NOTE = "SYNTHETIC-NOTE-9034";

const env = getEnv();
export const OPEN_MS = env.WAITING_ROOM_OPEN_MINUTES * MINUTE;
export const OVERRUN_MS = env.SESSION_OVERRUN_MINUTES * MINUTE;
export const GRACE_MS = env.NO_SHOW_GRACE_MINUTES * MINUTE;
export const TOKEN_TTL_MS = env.VIDEO_JOIN_TOKEN_TTL_SECONDS * 1000;
export const SESSION_MS = 30 * MINUTE;

/** The default session: doctor-local 10:00, three days ahead (inside the seeded 09:00-17:00 hours, 30-minute type). */
export const sessionStart = (): number => Date.parse(localStart(3, "10:00"));

/**
 * Inserts a consultation for the default doctor and patient (real SQL through the owner pool). The window of a row starting at
 * `startMs` is `[startMs - OPEN_MS, startMs + SESSION_MS + OVERRUN_MS)`; tests move the harness clock relative to it.
 */
export function seedSession(h: ConsultationsHarness, changes: Record<string, unknown> = {}, startMs = sessionStart()): Promise<number> {
    return h.seedConsultation({ starts_at: new Date(startMs), ends_at: new Date(startMs + SESSION_MS), ...changes });
}

export const patch = (h: ConsultationsHarness, id: number | string, action: "join" | "start" | "complete" | "no-show", actor: Parameters<ConsultationsHarness["call"]>[2],
    payload?: object) => h.call("patch", `/api/consultations/${id}/${action}`, actor, payload);
