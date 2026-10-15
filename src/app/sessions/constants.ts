/** Join and start share one bucket of their own, so reconnecting never consumes booking writes (spec 1.5.2). */
export const SESSION_RATE_NAME = "consultations-session-user";
export const SESSION_USER_LIMIT = 10;

/** Per call to the video provider; no retry inside the request (the client repeats `join`). */
export const VIDEO_CALL_TIMEOUT_MS = 2000;
export const WAITING_ROOM_MAX_ENTRIES = 100;
export const CALENDAR_MAX_ENTRIES = 1000;
export const CALENDAR_MAX_WINDOW_DAYS = 7;
export const NO_SHOW_NOTE_MAX_LENGTH = 1000;
