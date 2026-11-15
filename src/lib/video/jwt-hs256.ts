import { createHmac } from "node:crypto";

/**
 * A compact HS256 JWT signed with `node:crypto` (LiveKit access tokens are plain HS256 JWTs; `jose` stays confined to
 * `lib/auth`, so this needs no dependency). The claims are the caller's; nothing here reads a clock.
 */
export function signHs256Jwt(claims: Record<string, unknown>, secret: string): string {
    const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
    const unsigned = `${encode({ alg: "HS256", typ: "JWT" })}.${encode(claims)}`;
    return `${unsigned}.${createHmac("sha256", secret).update(unsigned).digest("base64url")}`;
}
