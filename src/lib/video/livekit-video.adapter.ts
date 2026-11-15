import { request } from "undici";
import { LIVEKIT_REQUEST_TIMEOUT_MS, LIVEKIT_ROOM_PREFIX, ROOM_DEPARTURE_TIMEOUT_SECONDS, ROOM_EMPTY_TIMEOUT_SECONDS, ROOM_MAX_PARTICIPANTS, SERVER_TOKEN_TTL_SECONDS, VideoFailureCode } from "./constants";
import { signHs256Jwt } from "./jwt-hs256";
import type { EnsureRoomInput, JoinTokenInput, LiveKitVideoConfig, VideoJoinToken, VideoRoom, VideoRoomProvider } from "./types";
import { VideoProviderError } from "./video-error";

const TIMEOUT_CODES = new Set(["UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_CONNECT_TIMEOUT"]);
const CREATE_ROOM_PATH = "/twirp/livekit.RoomService/CreateRoom";

function isTimeout(error: unknown, timeoutSignal: AbortSignal): boolean {
    if (timeoutSignal.aborted) return true;
    const code = (error as { code?: unknown } | null)?.code;
    const name = (error as { name?: unknown } | null)?.name;
    return (typeof code === "string" && TIMEOUT_CODES.has(code)) || name === "TimeoutError";
}

/**
 * Self-hosted LiveKit behind the room-provider port (ADR 0031; sessions S-D1). Two things only:
 * - `ensureRoom`: `CreateRoom` on LiveKit's RoomService (idempotent per name) so the room holds at most two participants and
 *   closes on its own; the room name derives from the consultation id.
 * - `issueJoinToken`: a LiveKit access token, an HS256 JWT signed locally with the API secret (no network call): bound to one room
 *   and one participant identity (`user-<id>`, no name, no email), joinable until `expiresAtMs`, never longer.
 * A failure carries a fixed code only: the provider body, the API secret and every token are never read, logged or returned.
 */
export class LiveKitVideoProvider implements VideoRoomProvider {
    constructor(private readonly config: LiveKitVideoConfig, private readonly clock: { now(): number } = { now: () => Date.now() }) {}

    async ensureRoom(input: EnsureRoomInput): Promise<VideoRoom> {
        const roomId = `${LIVEKIT_ROOM_PREFIX}${input.consultationId}`;
        const timeoutSignal = AbortSignal.timeout(LIVEKIT_REQUEST_TIMEOUT_MS);
        let response: Awaited<ReturnType<typeof request>>;
        try {
            response = await request(`${this.config.apiUrl}${CREATE_ROOM_PATH}`, {
                method: "POST",
                headers: { authorization: `Bearer ${this.serverToken()}`, "content-type": "application/json" },
                body: JSON.stringify({ name: roomId, empty_timeout: ROOM_EMPTY_TIMEOUT_SECONDS, departure_timeout: ROOM_DEPARTURE_TIMEOUT_SECONDS, max_participants: ROOM_MAX_PARTICIPANTS }),
                headersTimeout: LIVEKIT_REQUEST_TIMEOUT_MS,
                bodyTimeout: LIVEKIT_REQUEST_TIMEOUT_MS,
                signal: timeoutSignal,
            });
        } catch (error) {
            throw new VideoProviderError(isTimeout(error, timeoutSignal) ? VideoFailureCode.Timeout : VideoFailureCode.Network);
        }
        // The body is never read; destroying an undici body emits 'error', which needs a listener or it is uncaught.
        response.body.on("error", () => undefined);
        response.body.destroy();

        const status = response.statusCode;
        if (status >= 200 && status < 300) return { roomId };
        if (status === 401 || status === 403) throw new VideoProviderError(VideoFailureCode.Auth);
        if (status === 429) throw new VideoProviderError(VideoFailureCode.Throttled);
        if (status >= 500) throw new VideoProviderError(VideoFailureCode.Unavailable);
        throw new VideoProviderError(VideoFailureCode.Rejected);
    }

    issueJoinToken(input: JoinTokenInput): Promise<VideoJoinToken> {
        const nowSeconds = Math.floor(this.clock.now() / 1000);
        const expiresAtSeconds = Math.floor(input.expiresAtMs / 1000);
        const token = signHs256Jwt({
            iss: this.config.keyId,
            sub: `user-${input.userId}`,
            nbf: nowSeconds - 5,
            iat: nowSeconds,
            exp: expiresAtSeconds,
            metadata: JSON.stringify({ role: input.role }),
            video: { room: input.roomId, roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: true },
        }, this.config.apiSecret);
        return Promise.resolve({ token, expiresAtMs: expiresAtSeconds * 1000, serverUrl: this.config.url });
    }

    private serverToken(): string {
        const nowSeconds = Math.floor(this.clock.now() / 1000);
        return signHs256Jwt({ iss: this.config.keyId, nbf: nowSeconds - 5, exp: nowSeconds + SERVER_TOKEN_TTL_SECONDS, video: { roomCreate: true } }, this.config.apiSecret);
    }
}
