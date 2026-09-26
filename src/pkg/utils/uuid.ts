/** Any RFC 4122 UUID version, either case — the shape of `X-Request-Id` and `Idempotency-Key`. */
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
    return UUID_PATTERN.test(value);
}
