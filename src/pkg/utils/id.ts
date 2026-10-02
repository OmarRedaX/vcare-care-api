/** A positive decimal integer without sign, leading zeros, or more than 16 digits. */
const POSITIVE_ID_PATTERN = /^[1-9][0-9]{0,15}$/;

/**
 * Parses a BIGSERIAL id (or a token `sub`) exposed as a number (hub ADR 0004). Returns `undefined` for anything that
 * is not a positive safe integer written canonically — callers decide the error (401 for a token, 404 for a path).
 */
export function parsePositiveId(value: unknown): number | undefined {
    if (typeof value !== "string" || !POSITIVE_ID_PATTERN.test(value)) {
        return undefined;
    }
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : undefined;
}
