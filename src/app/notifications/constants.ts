/**
 * The only keys an outbox payload may carry: ids, ISO instants and roles. Reasons, complaint text, names and emails are
 * never allowed (ADR 0011; consultations spec C-R17). A key outside this list is a programming error.
 */
export const OUTBOX_PAYLOAD_KEYS: readonly string[] = ["startsAt", "endsAt", "previousStartsAt", "byRole", "recipientRole"];
