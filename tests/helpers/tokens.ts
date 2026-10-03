import { randomUUID } from "node:crypto";
import { base64url, exportJWK, generateKeyPair, SignJWT } from "jose";
import type { ClaimOverrides, SignTokenOptions, SigningKey } from "./types";

/**
 * User-token fixtures (access spec §9.1). Every key is generated fresh per call — no key material lives in the repo.
 * Tokens mirror what Identity issues: EdDSA, header `{ alg, kid, typ: "JWT" }`, claims
 * `iss, aud, sub, typ, role, status, ev, jti, iat, exp`.
 */
export async function generateSigningKey(kid: string): Promise<SigningKey> {
    const { privateKey, publicKey } = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true });
    const jwk = await exportJWK(publicKey);
    return {
        kid,
        privateKey,
        publicJwk: { kty: String(jwk.kty), crv: String(jwk.crv), x: String(jwk.x), kid, alg: "EdDSA", use: "sig" },
    };
}

/** The default claims of a valid patient token (overridable; `undefined` deletes a claim). */
export function defaultClaims(nowSeconds: number): Record<string, unknown> {
    return {
        iss: "vcare-identity",
        aud: ["vcare-identity", "vcare-care"],
        sub: "101",
        typ: "user",
        role: "patient",
        status: "active",
        ev: true,
        jti: randomUUID(),
        iat: nowSeconds,
        exp: nowSeconds + 900,
    };
}

function applyOverrides(base: Record<string, unknown>, overrides: Record<string, unknown> | undefined): Record<string, unknown> {
    const merged: Record<string, unknown> = { ...base };
    for (const [key, value] of Object.entries(overrides ?? {})) {
        if (value === undefined) {
            delete merged[key];
        } else {
            merged[key] = value;
        }
    }
    return merged;
}

export async function signUserToken(
    key: SigningKey,
    overrides?: ClaimOverrides,
    options?: SignTokenOptions,
): Promise<string> {
    const nowSeconds = options?.nowSeconds ?? Math.floor(Date.now() / 1_000);
    const payload = applyOverrides(defaultClaims(nowSeconds), overrides);
    const header = applyOverrides({ alg: "EdDSA", kid: key.kid, typ: "JWT" }, options?.header);
    return new SignJWT(payload)
        .setProtectedHeader(header as { alg: string })
        .sign(key.privateKey);
}

/** Signature valid; `exp` 10 minutes in the past (well beyond the 30 s tolerance). */
export function signExpiredUserToken(key: SigningKey, overrides?: ClaimOverrides): Promise<string> {
    const nowSeconds = Math.floor(Date.now() / 1_000);
    return signUserToken(key, { iat: nowSeconds - 1_500, exp: nowSeconds - 600, ...overrides });
}

/** Rewrites the payload (role → admin) and keeps the original signature: the signature no longer matches. */
export function tamperToken(token: string): string {
    const [header, payload, signature] = token.split(".");
    const claims = JSON.parse(Buffer.from(payload ?? "", "base64url").toString("utf8")) as Record<string, unknown>;
    claims.role = claims.role === "admin" ? "patient" : "admin";
    return `${header}.${base64url.encode(JSON.stringify(claims))}.${signature}`;
}

/** An unsigned `alg: none` token carrying otherwise valid claims. */
export function unsignedToken(kid: string, overrides?: ClaimOverrides): string {
    const header = base64url.encode(JSON.stringify({ alg: "none", kid, typ: "JWT" }));
    const payload = base64url.encode(
        JSON.stringify(applyOverrides(defaultClaims(Math.floor(Date.now() / 1_000)), overrides)),
    );
    return `${header}.${payload}.`;
}

/** An HS256 token keyed with `secret` (algorithm-confusion attempt). */
export function signHs256Token(kid: string, secret: Uint8Array, overrides?: ClaimOverrides): Promise<string> {
    return new SignJWT(applyOverrides(defaultClaims(Math.floor(Date.now() / 1_000)), overrides))
        .setProtectedHeader({ alg: "HS256", kid, typ: "JWT" })
        .sign(secret);
}
