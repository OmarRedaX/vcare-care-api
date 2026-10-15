/** Role a join token is issued for. */
export type VideoParticipantRole = "patient" | "doctor";

export interface EnsureRoomInput { consultationId: number; startsAtMs: number; endsAtMs: number }
/** `roomId` is at most 128 characters (`consultations.room_id VARCHAR(128)`). */
export interface VideoRoom { roomId: string }
export interface JoinTokenInput { roomId: string; userId: number; role: VideoParticipantRole; expiresAtMs: number }
export interface VideoJoinToken { token: string; expiresAtMs: number }

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
