import { createHmac, timingSafeEqual } from "node:crypto";
import type { EnsureRoomInput, FakeJoinTokenClaims, JoinTokenInput, VideoJoinToken, VideoParticipantRole, VideoRoom, VideoRoomProvider } from "./types";

const ROOM_PREFIX = "fake-room-";

function sign(payload: string, secret: string): string {
    return createHmac("sha256", secret).update(payload).digest("base64url");
}

/**
 * Deterministic provider for local development and tests (sessions S-D1). The room id derives from the consultation id; a token is
 * `base64url(JSON{rid,uid,role,exp}) + "." + base64url(HMAC-SHA256(secret, payload))`, so a test can prove it is bound to one room,
 * user and role and that it expires. Not a security boundary: production refuses it (`createVideoProvider`).
 */
export class FakeVideoProvider implements VideoRoomProvider {
    constructor(private readonly secret: string) {}

    ensureRoom(input: EnsureRoomInput): Promise<VideoRoom> {
        return Promise.resolve({ roomId: `${ROOM_PREFIX}${input.consultationId}` });
    }

    issueJoinToken(input: JoinTokenInput): Promise<VideoJoinToken> {
        const payload = Buffer.from(JSON.stringify({ rid: input.roomId, uid: input.userId, role: input.role, exp: input.expiresAtMs })).toString("base64url");
        return Promise.resolve({ token: `${payload}.${sign(payload, this.secret)}`, expiresAtMs: input.expiresAtMs });
    }
}

function isRole(value: unknown): value is VideoParticipantRole {
    return value === "patient" || value === "doctor";
}

/** The claims of a genuine, unexpired fake token; any tampering, wrong key or expiry gives `undefined`. For tests. */
export function verifyFakeJoinToken(token: string, secret: string, nowMs: number): FakeJoinTokenClaims | undefined {
    const parts = token.split(".");
    const payload = parts[0];
    const signature = parts[1];
    if (parts.length !== 2 || payload === undefined || signature === undefined) return undefined;
    const expected = Buffer.from(sign(payload, secret));
    const actual = Buffer.from(signature);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return undefined;
    let claims: unknown;
    try {
        claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    } catch {
        return undefined;
    }
    if (typeof claims !== "object" || claims === null) return undefined;
    const { rid, uid, role, exp } = claims as Record<string, unknown>;
    if (typeof rid !== "string" || typeof uid !== "number" || !isRole(role) || typeof exp !== "number" || exp <= nowMs) return undefined;
    return { roomId: rid, userId: uid, role, expiresAtMs: exp };
}

