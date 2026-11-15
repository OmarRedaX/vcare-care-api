import { createHmac } from "node:crypto";
import { signHs256Jwt } from "../../../../src/lib/video/jwt-hs256";

describe("lib/video signHs256Jwt", () => {
    it("should produce header.payload.signature with an HS256 header and the claims verbatim", () => {
        const token = signHs256Jwt({ iss: "synthetic", exp: 1893495600, video: { room: "care-1" } }, "synthetic-secret-0123456789abcdef-0123");
        const [header, payload, signature] = token.split(".") as [string, string, string];
        expect(JSON.parse(Buffer.from(header, "base64url").toString("utf8"))).toEqual({ alg: "HS256", typ: "JWT" });
        expect(JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))).toEqual({ iss: "synthetic", exp: 1893495600, video: { room: "care-1" } });
        expect(signature).toBe(createHmac("sha256", "synthetic-secret-0123456789abcdef-0123").update(`${header}.${payload}`).digest("base64url"));
    });

    it("should change the signature when the secret or any claim changes, and use no padding or url-unsafe characters", () => {
        const base = signHs256Jwt({ a: 1 }, "synthetic-secret-0123456789abcdef-0123");
        expect(signHs256Jwt({ a: 1 }, "synthetic-secret-0123456789abcdef-0124")).not.toBe(base);
        expect(signHs256Jwt({ a: 2 }, "synthetic-secret-0123456789abcdef-0123")).not.toBe(base);
        expect(base).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    });
});
