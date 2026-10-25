// Rule covered: AV-R17 (signed cursor `{k, v, id}`, kind mismatch, tampering).
import { decodeDiscoveryCursor, encodeDiscoveryCursor } from "../../../../src/app/availability/discovery-cursor";
import { DiscoveryCursorKind } from "../../../../src/app/availability/enums";
import { encodeSignedCursor } from "../../../../src/lib/http/pagination/signed-cursor";

const SECRET = "synthetic-cursor-secret";

describe("discovery cursor (AV-R17)", () => {
    it.each(Object.values(DiscoveryCursorKind))("should round-trip a %s position", (kind) => {
        const cursor = encodeDiscoveryCursor({ k: kind, v: 1_800_000_000_000, id: 42 }, SECRET);
        expect(decodeDiscoveryCursor(cursor, SECRET, kind)).toEqual({ k: kind, v: 1_800_000_000_000, id: 42 });
    });

    it("should reject a cursor issued under another effective sort with the mismatch detail", () => {
        const cursor = encodeDiscoveryCursor({ k: DiscoveryCursorKind.Earliest, v: 1, id: 1 }, SECRET);
        expect(() => decodeDiscoveryCursor(cursor, SECRET, DiscoveryCursorKind.Degraded)).toThrow(expect.objectContaining({
            code: "ValidationFailed", details: [{ field: "cursor", issue: "does not match the requested sort" }] }));
        expect(() => decodeDiscoveryCursor(cursor, SECRET, DiscoveryCursorKind.Price)).toThrow(expect.objectContaining({ code: "ValidationFailed" }));
    });

    it("should reject a tampered or foreign-signed cursor as invalid", () => {
        const cursor = encodeDiscoveryCursor({ k: DiscoveryCursorKind.Price, v: 10, id: 3 }, SECRET);
        const [body = "", mac = ""] = cursor.split(".");
        const forged = `${Buffer.from(JSON.stringify({ k: "price", v: 1, id: 3 })).toString("base64url")}.${mac}`;
        for (const bad of [forged, `${body}.${mac}x`, `${body}`, "", encodeDiscoveryCursor({ k: DiscoveryCursorKind.Price, v: 10, id: 3 }, "other-secret")]) {
            expect(() => decodeDiscoveryCursor(bad, SECRET, DiscoveryCursorKind.Price)).toThrow(expect.objectContaining({
                code: "ValidationFailed", details: [{ field: "cursor", issue: "is invalid" }] }));
        }
    });

    it.each([
        { k: "other", v: 1, id: 1 }, { k: "price", v: -1, id: 1 }, { k: "price", v: 1.5, id: 1 }, { k: "price", v: "1", id: 1 },
        { k: "price", v: 1, id: 0 }, { k: "price", v: 1, id: 1.2 }, { k: "price", v: 1 }, null, 7,
    ])("should reject a correctly signed payload of the wrong shape %j", (payload) => {
        const cursor = encodeSignedCursor(payload as object, SECRET);
        expect(() => decodeDiscoveryCursor(cursor, SECRET, DiscoveryCursorKind.Price)).toThrow(expect.objectContaining({
            details: [{ field: "cursor", issue: "is invalid" }] }));
    });
});
