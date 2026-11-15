/**
 * Live smoke of the LiveKit adapter against a running local server (ADR 0031). Synthetic key; nothing is deployed.
 *
 *   docker compose up -d livekit
 *   npx tsx scripts/video-livekit-smoke.ts
 *
 * Proves, with the real adapter and the real server: CreateRoom is idempotent and sets the two-participant cap, a join token is
 * accepted by the server's own validator (`/rtc/validate`), a tampered token and a wrong-secret room call are refused, and an
 * unreachable server surfaces as a fixed provider error code.
 */
import { signHs256Jwt } from "../src/lib/video/jwt-hs256";
import { LiveKitVideoProvider } from "../src/lib/video/livekit-video.adapter";
import { VideoProviderError } from "../src/lib/video/video-error";

const API_URL = process.env.LIVEKIT_API_URL ?? "http://127.0.0.1:7880";
const WS_URL = process.env.LIVEKIT_WS_URL ?? "ws://localhost:7880";
const KEY_ID = process.env.LIVEKIT_KEY_ID ?? "care-local";
const SECRET = process.env.LIVEKIT_SECRET ?? "synthetic-livekit-secret-0123456789abcdef";

const results: Array<[boolean, string]> = [];
const check = (name: string, ok: boolean, detail = ""): void => { results.push([ok, detail === "" ? name : `${name} [${detail}]`]); };

async function validate(token: string): Promise<number> {
    const response = await fetch(`${API_URL}/rtc/validate?access_token=${encodeURIComponent(token)}`);
    await response.text();
    return response.status;
}

async function listRooms(name: string): Promise<Array<Record<string, unknown>>> {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const serverToken = signHs256Jwt({ iss: KEY_ID, nbf: nowSeconds - 5, exp: nowSeconds + 60, video: { roomList: true } }, SECRET);
    const response = await fetch(`${API_URL}/twirp/livekit.RoomService/ListRooms`, {
        method: "POST", headers: { authorization: `Bearer ${serverToken}`, "content-type": "application/json" }, body: JSON.stringify({ names: [name] }),
    });
    const body = (await response.json()) as { rooms?: Array<Record<string, unknown>> };
    return body.rooms ?? [];
}

async function main(): Promise<void> {
    const provider = new LiveKitVideoProvider({ keyId: KEY_ID, apiSecret: SECRET, url: WS_URL, apiUrl: API_URL });
    const consultationId = 900000 + (Date.now() % 100000);
    const start = Date.now();

    const room = await provider.ensureRoom({ consultationId, startsAtMs: start, endsAtMs: start + 1_800_000 });
    const again = await provider.ensureRoom({ consultationId, startsAtMs: start, endsAtMs: start + 1_800_000 });
    check("ensureRoom names the room from the consultation id and is idempotent", room.roomId === `care-${consultationId}` && again.roomId === room.roomId, room.roomId);

    const rooms = await listRooms(room.roomId);
    check("the room exists once, capped at two participants", rooms.length === 1 && rooms[0]?.max_participants === 2, JSON.stringify({ count: rooms.length, max: rooms[0]?.max_participants }));

    const patient = await provider.issueJoinToken({ roomId: room.roomId, userId: 101, role: "patient", expiresAtMs: start + 300_000 });
    const doctor = await provider.issueJoinToken({ roomId: room.roomId, userId: 202, role: "doctor", expiresAtMs: start + 300_000 });
    check("a patient join token is accepted by the server's validator", (await validate(patient.token)) === 200);
    check("a doctor join token is accepted by the server's validator", (await validate(doctor.token)) === 200);
    check("the join response carries the client websocket URL, not the API URL", patient.serverUrl === WS_URL);

    const tampered = `${patient.token.slice(0, -3)}${patient.token.endsWith("AAA") ? "BBB" : "AAA"}`;
    check("a tampered token is refused by the server", (await validate(tampered)) === 401, String(await validate(tampered)));
    const expired = await provider.issueJoinToken({ roomId: room.roomId, userId: 101, role: "patient", expiresAtMs: start - 60_000 });
    check("an expired token is refused by the server", (await validate(expired.token)) === 401);
    const forged = signHs256Jwt({ iss: KEY_ID, sub: "user-1", exp: Math.floor(start / 1000) + 300, video: { room: room.roomId, roomJoin: true } }, "synthetic-wrong-secret-0123456789abcdef-xx");
    check("a token signed with another secret is refused", (await validate(forged)) === 401);

    const wrongSecret = new LiveKitVideoProvider({ keyId: KEY_ID, apiSecret: "synthetic-wrong-secret-0123456789abcdef-xx", url: WS_URL, apiUrl: API_URL });
    const authFailure = await wrongSecret.ensureRoom({ consultationId, startsAtMs: start, endsAtMs: start + 1 }).then(() => undefined, (error: unknown) => error);
    check("a wrong API secret is a provider_auth error with no provider text", authFailure instanceof VideoProviderError && authFailure.code === "provider_auth" && !authFailure.message.includes("secret"));

    const down = new LiveKitVideoProvider({ keyId: KEY_ID, apiSecret: SECRET, url: WS_URL, apiUrl: "http://127.0.0.1:1" });
    const networkFailure = await down.ensureRoom({ consultationId, startsAtMs: start, endsAtMs: start + 1 }).then(() => undefined, (error: unknown) => error);
    check("an unreachable server is a fixed network error code", networkFailure instanceof VideoProviderError && networkFailure.code === "network");
}

main().then(() => {
    for (const [ok, line] of results) console.log(`${ok ? "PASS" : "FAIL"}  ${line}`);
    const failed = results.filter(([ok]) => !ok).length;
    console.log(`\n${results.length - failed}/${results.length} passed`);
    process.exit(failed === 0 ? 0 : 1);
}, (error: unknown) => {
    console.error("smoke aborted:", error instanceof Error ? error.message : error);
    process.exit(2);
});
