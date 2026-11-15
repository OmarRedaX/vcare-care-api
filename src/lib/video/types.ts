/** Role a join token is issued for. */
export type VideoParticipantRole = "patient" | "doctor";

export interface EnsureRoomInput { consultationId: number; startsAtMs: number; endsAtMs: number }
/** `roomId` is at most 128 characters (`consultations.room_id VARCHAR(128)`). */
export interface VideoRoom { roomId: string }
export interface JoinTokenInput { roomId: string; userId: number; role: VideoParticipantRole; expiresAtMs: number }
/** `serverUrl` is the `ws(s)://` address a client connects to with the token (not a secret); `null` when the provider has none (the fake). */
export interface VideoJoinToken { token: string; expiresAtMs: number; serverUrl: string | null }

/**
 * The room-provider port (CLAUDE.md → Security rules, Video). `ensureRoom` is idempotent per `consultationId`.
 * Implementations never log or return provider bodies, tokens or URLs in errors.
 */
export interface VideoRoomProvider {
    ensureRoom(input: EnsureRoomInput): Promise<VideoRoom>;
    issueJoinToken(input: JoinTokenInput): Promise<VideoJoinToken>;
}

/** The claims a fake join token carries (`verifyFakeJoinToken`). */
export interface FakeJoinTokenClaims { roomId: string; userId: number; role: VideoParticipantRole; expiresAtMs: number }

/** Settings of the LiveKit adapter, from `VIDEO_PROVIDER_*` (ADR 0031). `apiSecret` is a secret: never logged. */
export interface LiveKitVideoConfig {
    /** The API key id (`iss` of every token); not a secret. */
    keyId: string;
    apiSecret: string;
    /** `ws(s)://` address clients connect to; returned in the join response. */
    url: string;
    /** `http(s)://` address of the server API (RoomService), without a trailing slash. */
    apiUrl: string;
}
