/**
 * Deterministic JSON: object keys sorted recursively, arrays left in order, `undefined` properties dropped.
 * Used for idempotency body hashing, where two semantically identical bodies must hash identically.
 */
export function canonicalJson(value: unknown): string {
    return stringify(value, new Set<object>());
}

function stringify(value: unknown, path: Set<object>): string {
    if (value === null || value === undefined) {
        return "null";
    }

    switch (typeof value) {
        case "bigint":
            throw new TypeError("canonicalJson: BigInt is not serializable");
        case "function":
        case "symbol":
            throw new TypeError("canonicalJson: functions and symbols are not serializable");
        case "number":
            if (!Number.isFinite(value)) {
                throw new TypeError("canonicalJson: numbers must be finite");
            }
            return JSON.stringify(value);
        case "string":
        case "boolean":
            return JSON.stringify(value);
        default:
            break;
    }

    const object = value;
    if (path.has(object)) {
        throw new TypeError("canonicalJson: value is cyclic");
    }
    path.add(object);

    try {
        if (object instanceof Date) {
            return JSON.stringify(object.toISOString());
        }
        if (Array.isArray(object)) {
            return `[${object.map((entry) => stringify(entry, path)).join(",")}]`;
        }
        const parts: string[] = [];
        for (const key of Object.keys(object).sort()) {
            const entry = (object as Record<string, unknown>)[key];
            if (entry === undefined) {
                continue;
            }
            parts.push(`${JSON.stringify(key)}:${stringify(entry, path)}`);
        }
        return `{${parts.join(",")}}`;
    } finally {
        path.delete(object);
    }
}
