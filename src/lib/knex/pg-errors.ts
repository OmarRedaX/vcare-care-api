import type { PgErrorLike } from "./types";

export const PG_UNIQUE_VIOLATION = "23505";
export const PG_EXCLUSION_VIOLATION = "23P01";

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

/** The violated constraint name when `error` is a pg exclusion violation (`23P01`), else undefined. */
export function exclusionViolationConstraint(error: unknown): string | undefined {
    if (typeof error !== "object" || error === null) {
        return undefined;
    }

    const pgError = error as PgErrorLike;
    return pgError.code === PG_EXCLUSION_VIOLATION && typeof pgError.constraint === "string"
        ? pgError.constraint
        : undefined;
}
