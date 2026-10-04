import type { PgErrorLike } from "./types";

export const PG_UNIQUE_VIOLATION = "23505";

/** The violated constraint name when `error` is a pg unique violation, else undefined. */
export function uniqueViolationConstraint(error: unknown): string | undefined {
    if (typeof error !== "object" || error === null) {
        return undefined;
    }

    const pgError = error as PgErrorLike;
    return pgError.code === PG_UNIQUE_VIOLATION && typeof pgError.constraint === "string"
        ? pgError.constraint
        : undefined;
}
