import { importJWK } from "jose";
import type { CryptoKey } from "jose";
import { UserTokenVerifier } from "../../../../src/lib/auth/user-token-verifier";
import { TokenExpired, Unauthorized } from "../../../../src/lib/error/errors";
import { fakeLogger } from "../../../helpers/fake-logger";
import { generateSigningKey, signHs256Token, signUserToken, tamperToken, unsignedToken } from "../../../helpers/tokens";
import type { SigningKey } from "../../../helpers/types";

let key: SigningKey;
let impostor: SigningKey;
let publicKey: CryptoKey;

beforeAll(async () => {
    [key, impostor] = await Promise.all([generateSigningKey("k1"), generateSigningKey("k1")]); // impostor reuses the kid
    publicKey = (await importJWK(key.publicJwk, "EdDSA")) as CryptoKey;
});

/** The verifier's key source is a collaborator: an in-memory map standing in for the JWKS cache. */
function verifier(options?: { nowSeconds?: number; getKey?: jest.Mock }) {
    const getKey = options?.getKey ?? jest.fn((kid: string) => Promise.resolve(kid === "k1" ? publicKey : undefined));
    const log = fakeLogger();
    const now = options?.nowSeconds;
    const instance = new UserTokenVerifier({
        jwks: { getKey },
        logger: log.logger,
        ...(now !== undefined ? { now: () => new Date(now * 1_000) } : {}),
    });
    return { instance, getKey, log };
}

const nowSeconds = (): number => Math.floor(Date.now() / 1_000);

describe("lib/auth/UserTokenVerifier", () => {
    it("should return the AuthContext when the token is valid (A2)", async () => {
        const { instance } = verifier();
        const token = await signUserToken(key, { sub: "4321", role: "doctor", status: "pending", ev: false });
        await expect(instance.verify(token)).resolves.toEqual({
            userId: 4321,
            role: "doctor",
            status: "pending",
            emailVerified: false,
        });
    });

    it("should accept a single-string aud that names vcare-care (A2)", async () => {
        const { instance } = verifier();
        await expect(instance.verify(await signUserToken(key, { aud: "vcare-care" }))).resolves.toMatchObject({
            userId: 101,
        });
    });

    it.each<[string, () => Promise<string>]>([
        ["the signature was made by another key with the same kid", () => signUserToken(impostor)],
        ["the payload was tampered with", async () => tamperToken(await signUserToken(key))],
        ["iss is not vcare-identity", () => signUserToken(key, { iss: "vcare-evil" })],
        ["aud does not contain vcare-care", () => signUserToken(key, { aud: ["vcare-identity"] })],
        ["typ is service", () => signUserToken(key, { typ: "service" })],
        ["typ is missing", () => signUserToken(key, { typ: undefined })],
        ["the kid is unknown", () => signUserToken(key, undefined, { header: { kid: "k-unknown" } })],
        ["the token is not a JWT at all", () => Promise.resolve("not-a-jwt")],
    ])("should throw Unauthorized when %s (A2)", async (_label, make) => {
        const { instance } = verifier();
        await expect(instance.verify(await make())).rejects.toBe(Unauthorized);
    });

    it("should throw Unauthorized without asking the key source when the header has no kid (A2)", async () => {
        const { instance, getKey } = verifier();
        const token = await signUserToken(key, undefined, { header: { kid: undefined } });
        await expect(instance.verify(token)).rejects.toBe(Unauthorized);
        expect(getKey).not.toHaveBeenCalled();
    });

    it.each(["sub", "exp", "iat", "jti"])("should throw Unauthorized when %s is missing (A2)", async (claim) => {
        const { instance } = verifier();
        await expect(instance.verify(await signUserToken(key, { [claim]: undefined }))).rejects.toBe(Unauthorized);
    });

    it.each(["0", "-1", "01", "1.5", "abc", "12345678901234567", "9007199254740993", ""])(
        "should throw Unauthorized when sub is %p (not a positive safe integer) (A2)",
        async (sub) => {
            const { instance } = verifier();
            await expect(instance.verify(await signUserToken(key, { sub }))).rejects.toBe(Unauthorized);
        },
    );

    it.each<[string, Record<string, unknown>]>([
        ["role is unknown", { role: "superuser" }],
        ["role is missing", { role: undefined }],
        ["status is unknown", { status: "banned" }],
        ["status is missing", { status: undefined }],
        ["ev is a string", { ev: "true" }],
        ["ev is missing", { ev: undefined }],
        ["jti is empty", { jti: "" }],
        ["jti is longer than 64 chars", { jti: "j".repeat(65) }],
        ["jti is not a string", { jti: 42 }],
    ])("should throw Unauthorized when %s (A2)", async (_label, overrides) => {
        const { instance } = verifier();
        await expect(instance.verify(await signUserToken(key, overrides))).rejects.toBe(Unauthorized);
    });

    it("should throw TokenExpired when exp + 30 s has passed (A3)", async () => {
        const issuedAt = nowSeconds();
        const token = await signUserToken(key, { iat: issuedAt, exp: issuedAt + 900 }, { nowSeconds: issuedAt });
        const { instance } = verifier({ nowSeconds: issuedAt + 900 + 31 });
        await expect(instance.verify(token)).rejects.toBe(TokenExpired);
        expect(TokenExpired.status).toBe(401);
    });

    it("should accept a token 29 s past exp (A3)", async () => {
        const issuedAt = nowSeconds();
        const token = await signUserToken(key, { iat: issuedAt, exp: issuedAt + 900 }, { nowSeconds: issuedAt });
        const { instance } = verifier({ nowSeconds: issuedAt + 900 + 29 });
        await expect(instance.verify(token)).resolves.toMatchObject({ userId: 101 });
    });

    it("should throw Unauthorized rather than TokenExpired when an expired token's signature is invalid (A3)", async () => {
        const issuedAt = nowSeconds() - 3_600;
        const token = await signUserToken(impostor, { iat: issuedAt, exp: issuedAt + 60 });
        const { instance } = verifier();
        await expect(instance.verify(token)).rejects.toBe(Unauthorized);
    });

    it("should throw Unauthorized when nbf is more than 30 s in the future (A2)", async () => {
        const { instance } = verifier();
        await expect(instance.verify(await signUserToken(key, { nbf: nowSeconds() + 120 }))).rejects.toBe(Unauthorized);
        await expect(instance.verify(await signUserToken(key, { nbf: nowSeconds() + 10 }))).resolves.toBeDefined();
    });

    it("should throw Unauthorized when an alg=none or HS256 token is presented (A2)", async () => {
        const { instance, getKey } = verifier();
        await expect(instance.verify(unsignedToken("k1"))).rejects.toBe(Unauthorized);
        await expect(instance.verify(await signHs256Token("k1", new Uint8Array(32).fill(7)))).rejects.toBe(Unauthorized);
        expect(getKey).not.toHaveBeenCalled(); // rejected on the pinned algorithm before any key lookup
    });

    it("should throw Unauthorized and log token_verification_error without the token when the key source throws unexpectedly (A5)", async () => {
        const getKey = jest.fn(() => Promise.reject(new TypeError("synthetic key source bug")));
        const { instance, log } = verifier({ getKey });
        const token = await signUserToken(key);

        await expect(instance.verify(token)).rejects.toBe(Unauthorized);
        expect(log.error).toHaveBeenCalledWith("token_verification_error", { error: expect.any(TypeError) });
        const [, , signature] = token.split(".");
        expect(log.text()).not.toContain(token);
        expect(log.text()).not.toContain(signature);
    });

    it("should throw Unauthorized when the key source has no key (JWKS unreachable, nothing cached) (A5)", async () => {
        const getKey = jest.fn(() => Promise.resolve(undefined));
        const { instance, log } = verifier({ getKey });
        await expect(instance.verify(await signUserToken(key))).rejects.toBe(Unauthorized);
        expect(getKey).toHaveBeenCalledWith("k1");
        expect(log.error).not.toHaveBeenCalled();
    });
});
