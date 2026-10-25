import { ValidationFailed } from "../../lib/error/errors";
import { decodeSignedCursor, encodeSignedCursor } from "../../lib/http/pagination/signed-cursor";
import { DiscoveryCursorKind } from "./enums";
import type { DiscoveryCursor } from "./types";

const KINDS: ReadonlySet<unknown> = new Set(Object.values(DiscoveryCursorKind));
const MISMATCH = ValidationFailed.withDetails([{ field: "cursor", issue: "does not match the requested sort" }]);

function validate(payload: unknown): DiscoveryCursor | undefined {
    if (typeof payload !== "object" || payload === null) return undefined;
    const { k, v, id } = payload as Record<string, unknown>;
    if (!KINDS.has(k) || typeof v !== "number" || !Number.isSafeInteger(v) || v < 0 || typeof id !== "number" || !Number.isSafeInteger(id) || id < 1) return undefined;
    return { k: k as DiscoveryCursorKind, v, id };
}

/** AV-R17: the signed search position `{k, v, id}`; it is a position, never a grant. */
export function encodeDiscoveryCursor(cursor: DiscoveryCursor, secret: string): string {
    return encodeSignedCursor({ k: cursor.k, v: cursor.v, id: cursor.id }, secret);
}

/** A tampered cursor is the standard `cursor is invalid`; one issued under another effective order is `400` with the mismatch detail. */
export function decodeDiscoveryCursor(cursor: string, secret: string, expected: DiscoveryCursorKind): DiscoveryCursor {
    const decoded = decodeSignedCursor(cursor, secret, validate);
    if (decoded.k !== expected) throw MISMATCH;
    return decoded;
}
