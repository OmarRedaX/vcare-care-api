import type { CryptoKey } from "jose";
import type { Logger } from "../logger/logger";
import type { UserTokenVerifier } from "./user-token-verifier";

/** Why a JWKS fetch failed (`jwks-fetcher.ts`). */
export type JwksFailureReason = "timeout" | "network" | "http_status" | "content_type" | "too_large" | "invalid_json";

/** Why a refresh failed: a fetch failure, or a response that is not a valid Ed25519 key set. */
export type JwksRefreshFailureReason = JwksFailureReason | "invalid_document";

/** What started a refresh. `stale`, `unknown_kid`, and `no_keys` are demand fetches, gated to one per minute. */
export type JwksRefreshTrigger = "boot" | "interval" | "stale" | "unknown_kid" | "no_keys";

export type JwksStatus = "up" | "down";

/** What readiness reads (no network call). */
export interface JwksStatusSource {
    status(): JwksStatus;
}

/** What the verifier needs from the cache. */
export interface KeySource {
    getKey(kid: string): Promise<CryptoKey | undefined>;
}

/** Fetches and parses the JWKS document; throws `JwksFetchError`. */
export type JwksFetcher = (url: string, signal: AbortSignal) => Promise<unknown>;

/** Injectable timers (tests use fake ones). */
export interface JwksTimers {
    setInterval(callback: () => void, ms: number): unknown;
    clearInterval(handle: unknown): void;
}

export interface JwksCacheOptions {
    url: string;
    logger: Logger;
    /** Defaults to `fetchJwksDocument`. */
    fetcher?: JwksFetcher;
    /** Defaults to `Date.now`. */
    now?: () => number;
    /** Defaults to the global timers (the interval is `unref`'d when the handle supports it). */
    timers?: JwksTimers;
}

export interface UserTokenVerifierOptions {
    jwks: KeySource;
    /** Defaults to `() => new Date()`. */
    now?: () => Date;
    /** Defaults to the root logger. */
    logger?: Logger;
}

export interface UserGuardOptions {
    /** Defaults to the container's `TOKENS.UserTokenVerifier`, resolved per request. */
    verifier?: UserTokenVerifier;
}
