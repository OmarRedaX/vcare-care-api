/**
 * The one normalisation of a person's display name for prefix matching (availability spec AV-R27): Unicode NFC, trimmed, every whitespace run
 * collapsed to one space, lower-cased. Used for both the stored name-index members and the search query, so the two always compare equal.
 */
export function normalizeName(value: string): string {
    return value.normalize("NFC").trim().replace(/\s+/gu, " ").toLowerCase();
}
