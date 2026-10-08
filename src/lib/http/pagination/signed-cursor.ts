import { createHmac, timingSafeEqual } from "node:crypto";
import { ValidationFailed } from "../../error/errors";

const INVALID_CURSOR = ValidationFailed.withDetails([{ field: "cursor", issue: "is invalid" }]);

/** Opaque keyset position authenticated with an HMAC, so a client cannot forge or edit it. Still a POSITION, never a grant. */
export function encodeSignedCursor(payload: object, secret: string): string {
    const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const mac = createHmac("sha256", secret).update(body).digest("base64url");
    return `${body}.${mac}`;
}

/** Verifies the MAC (constant time) and hands the parsed payload to `validate`, which returns it typed or `undefined`. */
export function decodeSignedCursor<T>(cursor: string, secret: string, validate: (payload: unknown) => T | undefined): T {
    const [body, mac] = cursor.split(".");
    if (!body || !mac) throw INVALID_CURSOR;
    const expected = createHmac("sha256", secret).update(body).digest();
    const supplied = Buffer.from(mac, "base64url");
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw INVALID_CURSOR;
    let payload: unknown;
    try { payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")); } catch { throw INVALID_CURSOR; }
    const valid = validate(payload);
    if (valid === undefined) throw INVALID_CURSOR;
    return valid;
}
