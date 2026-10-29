import { ValidationFailed } from "../../error/errors";
import type { CursorPosition, StringCursorPosition } from "./types";

const INVALID_CURSOR = ValidationFailed.withDetails([{ field: "cursor", issue: "is invalid" }]);

/** Opaque keyset position `(sortValue, id)`. A cursor is a POSITION, never a grant — every query keeps its filters. */
export function encodeCursor(sortValue: string | number, id: number): string {
    return Buffer.from(JSON.stringify([sortValue, id]), "utf8").toString("base64url");
}

export function decodeCursor(cursor: string): CursorPosition {
    let parsed: unknown;
    try {
        parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    } catch {
        throw INVALID_CURSOR;
    }

    if (!Array.isArray(parsed) || parsed.length !== 2) {
        throw INVALID_CURSOR;
    }
    const [sortValue, id] = parsed as [unknown, unknown];
    const sortValid = typeof sortValue === "string" || (typeof sortValue === "number" && Number.isFinite(sortValue));
    const idValid = typeof id === "number" && Number.isSafeInteger(id) && id > 0;
    if (!sortValid || !idValid) {
        throw INVALID_CURSOR;
    }
    return { sortValue, id };
}

/** Decode a string sort value without changing the generic cursor format. */
export function decodeTextCursor(cursor: string, maxLength: number): StringCursorPosition {
    if (typeof cursor !== "string") {
        throw INVALID_CURSOR;
    }
    const position = decodeCursor(cursor);
    if (typeof position.sortValue !== "string" || [...position.sortValue].length > maxLength || position.sortValue.includes("\u0000")) {
        throw INVALID_CURSOR;
    }
    return { sortValue: position.sortValue, id: position.id };
}

const TIMESTAMP_CURSOR_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const TIMESTAMP_CURSOR_LENGTH = 27;

/** A microsecond ISO timestamp with `Z` that is also a real instant (the millisecond prefix round-trips). */
function assertTimestampCursorValue(value: string): void {
    if (!TIMESTAMP_CURSOR_PATTERN.test(value)) {
        throw INVALID_CURSOR;
    }
    const millisecondPrefix = `${value.slice(0, 23)}Z`;
    const parsed = new Date(millisecondPrefix);
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== millisecondPrefix) {
        throw INVALID_CURSOR;
    }
}

/** Keep the exact six microsecond digits that Postgres stored. */
export function decodeTimestampCursor(cursor: string): StringCursorPosition {
    const position = decodeTextCursor(cursor, TIMESTAMP_CURSOR_LENGTH);
    assertTimestampCursorValue(position.sortValue);
    return position;
}

/**
 * A position whose sort value is `<kind>:<microsecond timestamp>`. The kind must equal `expectedKind`, so a cursor minted for one
 * sort order can never position a page of another; the timestamp must be a real instant. Returns the BARE timestamp.
 */
export function decodeKindedTimestampCursor(cursor: string, expectedKind: string): StringCursorPosition {
    const prefix = `${expectedKind}:`;
    const position = decodeTextCursor(cursor, [...prefix].length + TIMESTAMP_CURSOR_LENGTH);
    if (!position.sortValue.startsWith(prefix)) {
        throw INVALID_CURSOR;
    }
    const timestamp = position.sortValue.slice(prefix.length);
    assertTimestampCursorValue(timestamp);
    return { sortValue: timestamp, id: position.id };
}
