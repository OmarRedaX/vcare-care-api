/**
 * User-token verification constants (access spec §3.3.1). Not env: the contract fixes them, and a configurable value
 * could only break contract conformance. Identity parity: same issuer, audience, algorithm, and claim rules.
 */

/** `iss` must equal this. */
export const JWT_ISSUER = "vcare-identity";
/** `aud` must contain this. */
export const JWT_AUDIENCE = "vcare-care";
/** Pinned: no `none`, no algorithm confusion. */
export const JWT_ALGORITHMS = ["EdDSA"];
/** `exp` / `nbf` tolerance (decided 2026-10-02). */
export const CLOCK_TOLERANCE_SECONDS = 30;
/** Required claims besides the Care-specific ones checked by shape. */
export const JWT_REQUIRED_CLAIMS = ["sub", "exp", "iat", "jti"];
/** Longest accepted `jti`. */
export const MAX_JTI_LENGTH = 64;

/** Background refresh = Identity's `Cache-Control: max-age=300`. */
export const JWKS_REFRESH_INTERVAL_MS = 300_000;
/** At most one demand fetch (unknown `kid`, no keys, stale) per minute, counting every attempt. */
export const JWKS_MIN_FETCH_INTERVAL_MS = 60_000;
/** Cached keys are trusted at most 1 h after the last SUCCESSFUL fetch, then none are. */
export const JWKS_MAX_STALE_MS = 3_600_000;
/** Whole fetch: connect + headers + body. */
export const JWKS_FETCH_TIMEOUT_MS = 2_000;
/** A larger body is a failure. */
export const JWKS_MAX_BYTES = 65_536;
/** More keys make the document invalid. */
export const JWKS_MAX_KEYS = 16;

/** A longer bearer token is rejected with 401 before any parsing. */
export const MAX_BEARER_TOKEN_LENGTH = 4_096;
