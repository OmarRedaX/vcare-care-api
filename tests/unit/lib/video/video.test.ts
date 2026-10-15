import { createVideoProvider } from "../../../../src/lib/video/create-video-provider";
import { FakeVideoProvider, verifyFakeJoinToken } from "../../../../src/lib/video/fake-video.adapter";
import { VideoProviderError } from "../../../../src/lib/video/video-error";

const KEY = "synthetic-video-provider-key-0123456789abcdef";
const OTHER_KEY = "synthetic-other-provider-key-0123456789abcd";
const NOW = Date.parse("2030-03-30T10:00:00Z");
const room = { consultationId: 42, startsAtMs: NOW, endsAtMs: NOW + 1_800_000 };

describe("lib/video FakeVideoProvider", () => {
    const provider = new FakeVideoProvider(KEY);

    it("should derive the same room id for the same consultation and a different one for another", async () => {
        const first = await provider.ensureRoom(room);
        expect(await provider.ensureRoom(room)).toEqual(first);
        expect((await provider.ensureRoom({ ...room, consultationId: 43 })).roomId).not.toBe(first.roomId);
        expect(first.roomId.length).toBeLessThanOrEqual(128);
    });

    it("should issue a token bound to the room, user and role that verifies until it expires", async () => {
        const expiresAtMs = NOW + 300_000;
        const token = await provider.issueJoinToken({ roomId: "fake-room-42", userId: 7, role: "patient", expiresAtMs });
        expect(token.expiresAtMs).toBe(expiresAtMs);
        expect(verifyFakeJoinToken(token.token, KEY, NOW)).toEqual({ roomId: "fake-room-42", userId: 7, role: "patient", expiresAtMs });
        expect(verifyFakeJoinToken(token.token, KEY, expiresAtMs - 1)).toBeDefined();
        expect(verifyFakeJoinToken(token.token, KEY, expiresAtMs)).toBeUndefined();
    });

    it("should give a different token to another user or role", async () => {
        const base = { roomId: "fake-room-42", expiresAtMs: NOW + 300_000 };
        const patient = await provider.issueJoinToken({ ...base, userId: 7, role: "patient" });
        const doctor = await provider.issueJoinToken({ ...base, userId: 8, role: "doctor" });
        expect(patient.token).not.toBe(doctor.token);
        expect(verifyFakeJoinToken(doctor.token, KEY, NOW)).toMatchObject({ userId: 8, role: "doctor" });
    });

    it("should reject a tampered payload, a wrong key and malformed tokens", async () => {
        const token = (await provider.issueJoinToken({ roomId: "fake-room-42", userId: 7, role: "patient", expiresAtMs: NOW + 300_000 })).token;
        const [payload = "", signature = ""] = token.split(".");
        const forged = Buffer.from(JSON.stringify({ rid: "fake-room-42", uid: 8, role: "patient", exp: NOW + 300_000 })).toString("base64url");
        expect(verifyFakeJoinToken(`${forged}.${signature}`, KEY, NOW)).toBeUndefined();
        expect(verifyFakeJoinToken(token, OTHER_KEY, NOW)).toBeUndefined();
        for (const bad of ["", "abc", `${payload}.`, `${payload}.${signature}.x`]) expect(verifyFakeJoinToken(bad, KEY, NOW)).toBeUndefined();
    });
});

describe("lib/video createVideoProvider", () => {
    it("should return the fake provider outside production", () => {
        expect(createVideoProvider({ NODE_ENV: "development", VIDEO_PROVIDER: "fake", VIDEO_PROVIDER_KEY: KEY })).toBeInstanceOf(FakeVideoProvider);
        expect(createVideoProvider({ NODE_ENV: "test", VIDEO_PROVIDER: "fake", VIDEO_PROVIDER_KEY: KEY })).toBeInstanceOf(FakeVideoProvider);
    });

    it("should refuse the fake provider when NODE_ENV is production", () => {
        expect(() => createVideoProvider({ NODE_ENV: "production", VIDEO_PROVIDER: "fake", VIDEO_PROVIDER_KEY: KEY })).toThrow("video_provider_fake_not_allowed_in_production");
    });
});

describe("lib/video VideoProviderError", () => {
    it("should carry only a safe code", () => {
        const error = new VideoProviderError("timeout");
        expect(error.code).toBe("timeout");
        expect(error.message).toBe("video_provider_error:timeout");
    });
});
