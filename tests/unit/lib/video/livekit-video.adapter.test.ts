import { createHmac, timingSafeEqual } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type * as ConstantsModule from "../../../../src/lib/video/constants";
import type * as AdapterModule from "../../../../src/lib/video/livekit-video.adapter";
import type { LiveKitVideoConfig } from "../../../../src/lib/video/types";
import type * as VideoErrorModule from "../../../../src/lib/video/video-error";

/**
 * The real request budget is 1.8 s (asserted below against the real constant); this suite loads the adapter in an isolated module
 * registry with a 300 ms budget so the timeout case stays fast. Every other constant is the real one. The "server" is a local HTTP
 * server: a system-external dependency, so faking it is allowed in a unit test.
 */
let LiveKitVideoProvider: typeof AdapterModule.LiveKitVideoProvider;
// The same registry instance the adapter throws from (a top-level import would be a second copy of the class).
let VideoProviderError: typeof VideoErrorModule.VideoProviderError;
let realConstants: typeof ConstantsModule;
jest.isolateModules(() => {
    realConstants = jest.requireActual<typeof ConstantsModule>("../../../../src/lib/video/constants");
    jest.doMock("../../../../src/lib/video/constants", () => ({ ...realConstants, LIVEKIT_REQUEST_TIMEOUT_MS: 300 }));
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    LiveKitVideoProvider = (require("../../../../src/lib/video/livekit-video.adapter") as typeof AdapterModule).LiveKitVideoProvider;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    VideoProviderError = (require("../../../../src/lib/video/video-error") as typeof VideoErrorModule).VideoProviderError;
});

const SECRET = "synthetic-livekit-secret-0123456789abcdef";
const KEY_ID = "care-local";
const NOW_MS = Date.UTC(2030, 0, 1, 10, 0, 0);
const NOW_S = NOW_MS / 1000;
const clock = { now: () => NOW_MS };

interface Seen { method?: string; url?: string; headers: http.IncomingHttpHeaders; body: string }
interface Claims { iss?: string; sub?: string; nbf?: number; iat?: number; exp?: number; metadata?: string; video?: Record<string, unknown> }

function decode(token: string): { header: Record<string, unknown>; claims: Claims; signatureOk: (secret: string) => boolean } {
    const [header, payload, signature] = token.split(".") as [string, string, string];
    return {
        header: JSON.parse(Buffer.from(header, "base64url").toString("utf8")) as Record<string, unknown>,
        claims: JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Claims,
        signatureOk: (secret) => {
            const expected = Buffer.from(createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url"));
            const actual = Buffer.from(signature);
            return expected.length === actual.length && timingSafeEqual(expected, actual);
        },
    };
}

describe("LiveKitVideoProvider", () => {
    let server: http.Server;
    let apiUrl: string;
    let seen: Seen[];
    let respond: (res: http.ServerResponse) => void;

    beforeAll(async () => {
        server = http.createServer((req, res) => {
            const chunks: Buffer[] = [];
            req.on("data", (chunk: Buffer) => chunks.push(chunk));
            req.on("end", () => { seen.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString("utf8") }); respond(res); });
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });
    afterAll(async () => {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    beforeEach(() => {
        seen = [];
        respond = (res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ name: "care-7", sid: "RM_synthetic" })); };
    });

    const provider = (overrides: Partial<LiveKitVideoConfig> = {}) =>
        new LiveKitVideoProvider({ keyId: KEY_ID, apiSecret: SECRET, url: "wss://video.example.test", apiUrl, ...overrides }, clock);
    const status = (code: number) => { respond = (res) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify({ msg: `synthetic provider text ${SECRET}` })); }; };
    const failure = async (run: () => Promise<unknown>): Promise<InstanceType<typeof VideoProviderError>> => {
        const error = await run().then(() => undefined, (caught: unknown) => caught);
        expect(error).toBeInstanceOf(VideoProviderError);
        return error as InstanceType<typeof VideoProviderError>;
    };
    const input = { consultationId: 7, startsAtMs: NOW_MS, endsAtMs: NOW_MS + 1_800_000 };

    it("should keep the real request budget under the sessions 2 s bound", () => {
        expect(realConstants.LIVEKIT_REQUEST_TIMEOUT_MS).toBe(1800);
    });

    describe("ensureRoom", () => {
        it("should create a two-participant room named from the consultation id with a roomCreate-only server token", async () => {
            await expect(provider().ensureRoom(input)).resolves.toEqual({ roomId: "care-7" });
            expect(seen).toHaveLength(1);
            expect(seen[0]).toMatchObject({ method: "POST", url: "/twirp/livekit.RoomService/CreateRoom" });
            expect(seen[0]?.headers["content-type"]).toBe("application/json");
            expect(JSON.parse(seen[0]?.body ?? "{}")).toEqual({ name: "care-7", empty_timeout: 3600, departure_timeout: 600, max_participants: 2 });
            const bearer = (seen[0]?.headers.authorization ?? "").replace("Bearer ", "");
            const token = decode(bearer);
            expect(token.header).toEqual({ alg: "HS256", typ: "JWT" });
            expect(token.signatureOk(SECRET)).toBe(true);
            expect(token.claims).toEqual({ iss: KEY_ID, nbf: NOW_S - 5, exp: NOW_S + 60, video: { roomCreate: true } });
        });

        it("should derive a room id that fits the 128-character column for the largest id", async () => {
            const room = await provider().ensureRoom({ ...input, consultationId: Number.MAX_SAFE_INTEGER });
            expect(room.roomId.length).toBeLessThanOrEqual(128);
        });

        it.each([
            [401, "provider_auth"], [403, "provider_auth"], [429, "provider_throttled"], [500, "provider_unavailable"], [503, "provider_unavailable"],
            [400, "provider_rejected"], [404, "provider_rejected"], [409, "provider_rejected"],
        ])("should map HTTP %i to the fixed code %s without any provider text", async (code, expected) => {
            status(code);
            const error = await failure(() => provider().ensureRoom(input));
            expect(error.code).toBe(expected);
            expect(error.message).toBe(`video_provider_error:${expected}`);
            expect(error.message).not.toContain("synthetic");
            expect(error.message).not.toContain(SECRET);
        });

        it("should fail with the fixed timeout code when the server does not answer within the budget", async () => {
            respond = () => undefined;
            expect((await failure(() => provider().ensureRoom(input))).code).toBe("timeout");
        });

        it("should fail with the fixed network code when nothing listens at the API URL", async () => {
            expect((await failure(() => provider({ apiUrl: "http://127.0.0.1:1" }).ensureRoom(input))).code).toBe("network");
        });
    });

    describe("issueJoinToken", () => {
        const join = { roomId: "care-7", userId: 101, role: "patient" as const, expiresAtMs: NOW_MS + 300_000 };

        it("should sign an HS256 token bound to one room and one participant, valid until the requested expiry", async () => {
            const issued = await provider().issueJoinToken(join);
            const token = decode(issued.token);
            expect(token.header).toEqual({ alg: "HS256", typ: "JWT" });
            expect(token.signatureOk(SECRET)).toBe(true);
            expect(token.signatureOk("synthetic-other-secret-0123456789abcdef-x")).toBe(false);
            expect(token.claims).toMatchObject({ iss: KEY_ID, sub: "user-101", nbf: NOW_S - 5, iat: NOW_S, exp: NOW_S + 300 });
            expect(token.claims.video).toEqual({ room: "care-7", roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: true });
            expect(JSON.parse(token.claims.metadata ?? "{}")).toEqual({ role: "patient" });
            expect(issued).toMatchObject({ expiresAtMs: NOW_MS + 300_000, serverUrl: "wss://video.example.test" });
        });

        it("should give the doctor their own identity and role and make no network call", async () => {
            const issued = await provider().issueJoinToken({ ...join, userId: 202, role: "doctor" });
            const token = decode(issued.token);
            expect([token.claims.sub, JSON.parse(token.claims.metadata ?? "{}")]).toEqual(["user-202", { role: "doctor" }]);
            expect(seen).toHaveLength(0);
        });

        it("should never grant room administration or creation and never carry a name, email or phone", async () => {
            const claims = decode((await provider().issueJoinToken(join)).token).claims;
            expect(Object.keys(claims.video ?? {}).sort()).toEqual(["canPublish", "canPublishData", "canSubscribe", "room", "roomJoin"]);
            expect(claims).not.toHaveProperty("name");
            expect(JSON.stringify(claims)).not.toMatch(/@|email|phone/i);
        });

        it("should round a fractional expiry down to the second, never beyond the requested instant", async () => {
            const issued = await provider().issueJoinToken({ ...join, expiresAtMs: NOW_MS + 300_999 });
            expect(issued.expiresAtMs).toBe(NOW_MS + 300_000);
            expect(decode(issued.token).claims.exp).toBe(NOW_S + 300);
        });
    });
});
