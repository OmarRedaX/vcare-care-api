/**
 * Key-name redaction — defence in depth for CLAUDE.md → "Privacy and logging".
 * Never rely on it: do not pass clinical data or PII to the logger in the first place.
 * Later modules append keys here; each addition gets a row in the redaction unit test.
 */
export const REDACTED_KEYS: readonly string[] = [
    "complaintText",
    "examinationNotes",
    "diagnosisText",
    "diagnosisCode",
    "treatmentPlan",
    "allergies",
    "chronicConditions",
    "bloodType",
    "dateOfBirth",
    "objectKey",
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
    // access: database URLs carry credentials (ensure-app-login, pool configs).
    "connectionString",
    "databaseUrl",
    "migrationDatabaseUrl",
];

const MAX_DEPTH = 8;

export function normalizeKey(key: string): string {
    return key.toLowerCase().replace(/[_-]/g, "");
}

const REDACTED_SET = new Set(REDACTED_KEYS.map(normalizeKey));

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
