import { importJWK } from "jose";
import type { CryptoKey } from "jose";
import type { Logger } from "../logger/logger";
import { validateBody } from "../validation/validate";
import { JWKS_MAX_STALE_MS, JWKS_MIN_FETCH_INTERVAL_MS, JWKS_REFRESH_INTERVAL_MS } from "./constants";
import { fetchJwksDocument, JwksFetchError } from "./jwks-fetcher";
import { JwksDocumentDto } from "./jwks.dto";
import type {
    JwksCacheOptions,
    JwksFetcher,
    JwksRefreshFailureReason,
    JwksRefreshTrigger,
    JwksStatus,
    JwksStatusSource,
    JwksTimers,
    KeySource,
} from "./types";

/** Demand triggers share the per-minute gate; `boot` and `interval` always attempt. */
const DEMAND_TRIGGERS: ReadonlySet<JwksRefreshTrigger> = new Set(["stale", "unknown_kid", "no_keys"]);

const DEFAULT_TIMERS: JwksTimers = {
    setInterval: (callback, ms) => {
        const handle = setInterval(callback, ms);
        handle.unref();
        return handle;
    },
    clearInterval: (handle) => {
        clearInterval(handle as NodeJS.Timeout);
    },
};

function hostOf(url: string): string {
    try {
        return new URL(url).host;
    } catch {
        return "invalid";
    }
}

/**
 * Identity's public signing keys, in memory (access spec §3.3.4; CLAUDE.md → Authentication and service-to-service
 * auth). Re-fetched every 5 minutes (Identity's `max-age`), on an unknown `kid` or a stale/empty set at most once per
 * minute; while refreshes fail the cached keys stay trusted for at most 1 hour after the last successful fetch, then
 * none are. A successful fetch replaces the set wholesale (a removed `kid` stops verifying at once); a failed or
 * malformed one keeps the previous set. Concurrent refreshes share one HTTP request.
 *
 * Not `jose.createRemoteJWKSet`: it cannot express the 1 h stale-if-error window, does not use `undici`, and does not
 * expose its age for readiness. jose is used only for `importJWK` here and `jwtVerify` in the verifier.
 */
export class JwksCache implements JwksStatusSource, KeySource {
    private keys: Map<string, CryptoKey> | null = null;
    private fetchedAt: number | null = null;
    private lastAttemptAt: number | null = null;
    private lastAttemptOk = false;
    private inFlight: Promise<boolean> | null = null;
    private interval: unknown = null;
    private controller = new AbortController();
    private expiredLogged = false;

    private readonly url: string;
    private readonly host: string;
    private readonly logger: Logger;
    private readonly fetcher: JwksFetcher;
    private readonly now: () => number;
    private readonly timers: JwksTimers;

    constructor(options: JwksCacheOptions) {
        this.url = options.url;
        this.host = hostOf(options.url);
        this.logger = options.logger;
        this.fetcher = options.fetcher ?? fetchJwksDocument;
        this.now = options.now ?? Date.now;
        this.timers = options.timers ?? DEFAULT_TIMERS;
    }

    /** Boot: one fetch (not awaited — boot never waits on Identity) and the 5-minute background refresh. */
    start(): void {
        if (this.interval !== null) {
            return;
        }
        if (this.controller.signal.aborted) {
            this.controller = new AbortController();
        }
        void this.refresh("boot");
        this.interval = this.timers.setInterval(() => {
            void this.tick();
        }, JWKS_REFRESH_INTERVAL_MS);
    }

    /** Clears the interval and aborts an in-flight fetch. Idempotent. */
    stop(): void {
        if (this.interval !== null) {
            this.timers.clearInterval(this.interval);
            this.interval = null;
        }
        this.controller.abort();
    }

    async getKey(kid: string): Promise<CryptoKey | undefined> {
        const age = this.age();
        if (this.keys === null || age === null || age > JWKS_MAX_STALE_MS) {
            this.noteExpired();
            await this.refresh("no_keys");
            return this.usableKey(kid);
        }
        if (age > JWKS_REFRESH_INTERVAL_MS) {
            // A missed or failed tick: refresh in the background, answer from the current set now.
            void this.refresh("stale");
        }
        const key = this.keys.get(kid);
        if (key !== undefined) {
            return key;
        }
        await this.refresh("unknown_kid");
        return this.usableKey(kid);
    }

    /**
     * Single-flight; demand triggers are gated to one attempt per `JWKS_MIN_FETCH_INTERVAL_MS` (every attempt counts,
     * successful or not). Never rejects: `true` when this call's attempt (or the shared one) succeeded.
     */
    refresh(trigger: JwksRefreshTrigger): Promise<boolean> {
        if (this.inFlight !== null) {
            return this.inFlight;
        }
        const startedAt = this.now();
        if (
            DEMAND_TRIGGERS.has(trigger) &&
            this.lastAttemptAt !== null &&
            startedAt - this.lastAttemptAt < JWKS_MIN_FETCH_INTERVAL_MS
        ) {
            return Promise.resolve(false);
        }
        this.lastAttemptAt = startedAt;
        const attempt = this.attempt(trigger, startedAt).finally(() => {
            this.inFlight = null;
        });
        this.inFlight = attempt;
        return attempt;
    }

    /** `up` iff a set was loaded, it is at most 1 h old, and the latest attempt succeeded. No network call. */
    status(): JwksStatus {
        const age = this.age();
        return age !== null && age <= JWKS_MAX_STALE_MS && this.lastAttemptOk ? "up" : "down";
    }

    private async tick(): Promise<void> {
        await this.refresh("interval");
        this.noteExpired();
        const age = this.age();
        if (age !== null) {
            this.logger.metric("jwks_cache_age_s", Math.floor(age / 1_000));
        }
    }

    private async attempt(trigger: JwksRefreshTrigger, startedAt: number): Promise<boolean> {
        const signal = this.controller.signal;
        let keys: Map<string, CryptoKey> | null;
        try {
            const document = await this.fetcher(this.url, signal);
            keys = await this.importKeys(document);
        } catch (error) {
            if (signal.aborted) {
                // Stopped (shutdown): not a failure worth reporting.
                return false;
            }
            const reason: JwksRefreshFailureReason = error instanceof JwksFetchError ? error.reason : "network";
            const status = error instanceof JwksFetchError ? error.status : undefined;
            this.fail(trigger, reason, status);
            return false;
        }
        if (keys === null) {
            this.fail(trigger, "invalid_document");
            return false;
        }

        this.keys = keys;
        this.fetchedAt = startedAt;
        this.lastAttemptOk = true;
        this.expiredLogged = false;
        this.logger.info("jwks_refreshed", { trigger, keys: keys.size });
        return true;
    }

    /** The whole response or nothing: any invalid member, a duplicate `kid`, or a failed import → `null`. */
    private async importKeys(document: unknown): Promise<Map<string, CryptoKey> | null> {
        let parsed: JwksDocumentDto;
        try {
            // Extra public members are allowed by the contract and stripped; `d` and the six members stay strict.
            parsed = await validateBody(JwksDocumentDto, document, { unknownMembers: "strip" });
        } catch {
            return null;
        }
        const keys = new Map<string, CryptoKey>();
        for (const jwk of parsed.keys) {
            if (keys.has(jwk.kid)) {
                return null;
            }
            let key: CryptoKey | Uint8Array;
            try {
                key = await importJWK({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, alg: jwk.alg, use: jwk.use }, "EdDSA");
            } catch {
                return null;
            }
            if (key instanceof Uint8Array) {
                return null;
            }
            keys.set(jwk.kid, key);
        }
        return keys;
    }

    private fail(trigger: JwksRefreshTrigger, reason: JwksRefreshFailureReason, status?: number): void {
        this.lastAttemptOk = false;
        // Only the host — never the path, query, or response body.
        this.logger.warn("jwks_refresh_failed", {
            trigger,
            host: this.host,
            reason,
            ...(status !== undefined ? { status } : {}),
        });
        this.logger.metric("jwks_refresh_failed", 1, { reason });
    }

    /** `jwks_keys_expired` once per crossing of the 1 h cap; reset by the next success. */
    private noteExpired(): void {
        const age = this.age();
        if (age !== null && age > JWKS_MAX_STALE_MS && !this.expiredLogged) {
            this.expiredLogged = true;
            this.logger.error("jwks_keys_expired", { host: this.host });
        }
    }

    private usableKey(kid: string): CryptoKey | undefined {
        const age = this.age();
        if (this.keys === null || age === null || age > JWKS_MAX_STALE_MS) {
            return undefined;
        }
        return this.keys.get(kid);
    }

    private age(): number | null {
        return this.fetchedAt === null ? null : this.now() - this.fetchedAt;
    }
}
