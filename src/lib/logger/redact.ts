import { serializeError } from "./serialize-error";

/**
 * Key-name redaction — defence in depth for CLAUDE.md → "Privacy and logging".
 * Never rely on it: do not pass clinical data or PII to the logger in the first place.
 * Later modules append keys here; each addition gets a row in the redaction unit test.
 */
export const REDACTED_KEYS: readonly string[] = [
    "complaintText",
    "cancelReason",
    "examinationNotes",
    "diagnosisText",
    "diagnosisCode",
    "treatmentPlan",
    // records: the chief complaint, the follow-up interval, the nested amendments (carry `reason`) and a named amendment reason.
    "chiefComplaint",
    "followUpInDays",
    "amendments",
    "amendmentReason",
    "allergies",
    "chronicConditions",
    "bloodType",
    "dateOfBirth",
    "gender",
    "objectKey",
    // record-attachments: clinical free text of an attachment; a bare `description` is NOT redacted (specialties.description is non-clinical).
    "attachmentDescription",
    "downloadUrl",
    "uploadUrl",
    "joinToken",
    "authorization",
    "cookie",
    "setCookie",
    "fullName",
    "displayName",
    "firstName",
    "lastName",
    "email",
    "phone",
    "password",
    "token",
    "accessToken",
    "refreshToken",
    "serviceToken",
    "clientSecret",
    "body",
    "requestBody",
    "headline",
    "bio",
    "reviewNote",
    "suspensionReason",
    "quarantineKey",
    "fields",
    "url",
    "avatarUrl",
    // access: database URLs carry credentials (ensure-app-login, pool configs).
    "connectionString",
    "databaseUrl",
    "migrationDatabaseUrl",
    // database error and query internals: a pg error under any key (`cause`, `err`, …) carries the failing row in `detail` and the SQL in `query`.
    "detail",
    "where",
    "hint",
    "parameters",
    "bindings",
    "query",
    "sql",
];

const MAX_DEPTH = 8;

export function normalizeKey(key: string): string {
    return key.toLowerCase().replace(/[_-]/g, "");
}

const REDACTED_SET = new Set(REDACTED_KEYS.map(normalizeKey));

/** Whether the logger redacts `key` (after normalization) — the one answer, also used by `lib/audit` metadata checks. */
export function isRedactedKey(key: string): boolean {
    return REDACTED_SET.has(normalizeKey(key));
}

function redactValue(value: unknown, depth: number, path: Set<object>): unknown {
    if (depth > MAX_DEPTH) {
        return "[Truncated]";
    }
    if (value === null || typeof value !== "object") {
        return value;
    }
    if (value instanceof Date) {
        return value.toISOString();
    }
    // An Error under any key or depth: only the fixed-category fields of `serializeError` leave the process (never `message`, `detail`, `where`).
    if (value instanceof Error) {
        return serializeError(value);
    }
    if (path.has(value)) {
        return "[Circular]";
    }
    path.add(value);
    try {
        if (Array.isArray(value)) {
            return value.map((entry) => redactValue(entry, depth + 1, path));
        }
        const output: Record<string, unknown> = {};
        for (const [key, entry] of Object.entries(value)) {
            output[key] = REDACTED_SET.has(normalizeKey(key)) ? "[REDACTED]" : redactValue(entry, depth + 1, path);
        }
        return output;
    } finally {
        path.delete(value);
    }
}

export function redact(value: unknown): unknown {
    return redactValue(value, 0, new Set<object>());
}
