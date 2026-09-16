import { ValidationFailed } from "../../error/errors";
import type { CursorPosition } from "./types";

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
