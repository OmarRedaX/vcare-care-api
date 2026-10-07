import { decodeSignedCursor, encodeSignedCursor } from "../../../../src/lib/http/pagination/signed-cursor";

const secret = "synthetic-cursor-secret";
const validate = (payload: unknown): { id: number } | undefined => (typeof payload === "object" && payload !== null && "id" in payload && typeof payload.id === "number" ? { id: payload.id } : undefined);

describe("signed cursor", () => {
    it("should round-trip a payload through the validator", () => {
        expect(decodeSignedCursor(encodeSignedCursor({ id: 5 }, secret), secret, validate)).toEqual({ id: 5 });
    });

    it("should reject a tampered body, a different secret, a missing MAC and a payload the validator refuses", () => {
        const cursor = encodeSignedCursor({ id: 5 }, secret);
        const [body, mac] = cursor.split(".");
        const forged = `${Buffer.from(JSON.stringify({ id: 6 })).toString("base64url")}.${mac}`;
        for (const bad of [forged, `${body}x.${mac}`, `${body}.`, body ?? "", "", `${body}.${mac}x`]) {
            expect(() => decodeSignedCursor(bad, secret, validate)).toThrow(expect.objectContaining({ code: "ValidationFailed" }));
        }
        expect(() => decodeSignedCursor(cursor, "another-secret", validate)).toThrow(expect.objectContaining({ code: "ValidationFailed" }));
        expect(() => decodeSignedCursor(encodeSignedCursor({ id: "5" }, secret), secret, validate)).toThrow(expect.objectContaining({ code: "ValidationFailed" }));
    });
});
