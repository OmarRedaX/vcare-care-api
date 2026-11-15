/** One provider call gets this long (the sessions service bounds the whole call at 2 s; the adapter aborts its own socket first). */
export const LIVEKIT_REQUEST_TIMEOUT_MS = 1800;
/** A video room holds exactly the patient and the doctor; the join token is the real gate, this is defence in depth. */
export const ROOM_MAX_PARTICIPANTS = 2;
/** A room nobody joined is closed after this long. */
export const ROOM_EMPTY_TIMEOUT_SECONDS = 3600;
/** A room stays open this long after the last participant leaves, so a dropped call can reconnect. */
export const ROOM_DEPARTURE_TIMEOUT_SECONDS = 600;
/** The short-lived server token used for `CreateRoom` (`roomCreate` grant only). */
export const SERVER_TOKEN_TTL_SECONDS = 60;
/** `roomId` must fit `consultations.room_id VARCHAR(128)`. */
export const LIVEKIT_ROOM_PREFIX = "care-";

/** Fixed vocabulary for `VideoProviderError.code`: never a provider message. */
export const VideoFailureCode = {
    Timeout: "timeout",
    Network: "network",
    Auth: "provider_auth",
    Throttled: "provider_throttled",
    Unavailable: "provider_unavailable",
    Rejected: "provider_rejected",
} as const;
