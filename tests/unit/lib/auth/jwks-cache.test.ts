import { JWKS_MAX_STALE_MS, JWKS_MIN_FETCH_INTERVAL_MS, JWKS_REFRESH_INTERVAL_MS } from "../../../../src/lib/auth/constants";
import { JwksCache } from "../../../../src/lib/auth/jwks-cache";
import { JwksFetchError } from "../../../../src/lib/auth/jwks-fetcher";
import type { JwksFetcher, JwksTimers } from "../../../../src/lib/auth/types";
import { fakeLogger } from "../../../helpers/fake-logger";
import { generateSigningKey, signUserToken } from "../../../helpers/tokens";
import type { FakeLogger, SigningKey } from "../../../helpers/types";

const URL_WITH_PATH = "http://identity.example.test:3000/.well-known/jwks.json?probe=synthetic-query-4410";
const MINUTE = 60_000;

let k1: SigningKey;
let k2: SigningKey;

beforeAll(async () => {
    [k1, k2] = await Promise.all([generateSigningKey("k1"), generateSigningKey("k2")]);
});

const doc = (...keys: SigningKey[]): unknown => ({ keys: keys.map((key) => ({ ...key.publicJwk })) });

/** Manual timers: the interval callback runs only when the test calls `fire()`. */
function manualTimers() {
    let callback: (() => void) | undefined;
    const timers: JwksTimers & { fire(): void; ms?: number; cleared: number } = {
        cleared: 0,
        setInterval(cb, ms) {
            callback = cb;
            timers.ms = ms;
            return "handle";
        },
        clearInterval() {
            timers.cleared += 1;
            callback = undefined;
        },
        fire() {
            callback?.();
        },
    };
    return timers;
}

interface Harness {
    cache: JwksCache;
    fetcher: jest.Mock<ReturnType<JwksFetcher>, Parameters<JwksFetcher>>;
    clock: { t: number };
    log: FakeLogger;
    timers: ReturnType<typeof manualTimers>;
}

function harness(responses: unknown[]): Harness {
    const clock = { t: 1_800_000_000_000 };
    const log = fakeLogger();
    const timers = manualTimers();
    const queue = [...responses];
    let last: unknown = responses[responses.length - 1];
    const fetcher = jest.fn<ReturnType<JwksFetcher>, Parameters<JwksFetcher>>(() => {
        const next = queue.length > 0 ? queue.shift() : last;
        last = next;
        if (next instanceof Error) {
            return Promise.reject(next);
        }
        return Promise.resolve(next);
    });
    const cache = new JwksCache({ url: URL_WITH_PATH, logger: log.logger, fetcher, now: () => clock.t, timers });
    return { cache, fetcher, clock, log, timers };
}

/** Let fire-and-forget refreshes (start, interval tick, stale) settle. */
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe("lib/auth/JwksCache", () => {
    it("should fetch once at start and every 5 min when started (A4)", async () => {
        const { cache, fetcher, timers, log } = harness([doc(k1)]);
        cache.start();
        await flush(); // the boot fetch alone — no manual refresh
        expect(fetcher).toHaveBeenCalledTimes(1);
        expect(log.info).toHaveBeenCalledWith("jwks_refreshed", { trigger: "boot", keys: 1 });
        expect(timers.ms).toBe(JWKS_REFRESH_INTERVAL_MS);
        expect(JWKS_REFRESH_INTERVAL_MS).toBe(5 * MINUTE);

        // The interval tick ALONE fetches and logs trigger "interval" (L8): no manual refresh() before these asserts.
        expect(log.info).not.toHaveBeenCalledWith("jwks_refreshed", { trigger: "interval", keys: 1 });
        timers.fire();
        await flush();
        await flush();
        expect(fetcher).toHaveBeenCalledTimes(2);
        expect(log.info).toHaveBeenCalledWith("jwks_refreshed", { trigger: "interval", keys: 1 });
        expect(log.info).toHaveBeenCalledTimes(2);
        timers.fire();
        await flush();
        await flush();
        expect(fetcher).toHaveBeenCalledTimes(3);
        expect(log.info).toHaveBeenCalledTimes(3);
        expect(log.metric).toHaveBeenCalledWith("jwks_cache_age_s", 0);

        cache.start(); // already started: no second boot fetch, no second interval
        await flush();
        expect(fetcher).toHaveBeenCalledTimes(3);
        cache.stop();
    });

    it("should share one fetch when refreshes overlap (A4)", async () => {
        let release: (value: unknown) => void = () => undefined;
        const pending = new Promise<unknown>((resolve) => {
            release = resolve;
        });
        const { cache, fetcher } = harness([pending]);

        const a = cache.refresh("boot");
        const b = cache.refresh("interval");
        const c = cache.refresh("unknown_kid");
        const key = cache.getKey("k1");
        release(doc(k1));

        expect(await Promise.all([a, b, c])).toEqual([true, true, true]);
        expect(await key).toBeDefined();
        expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it("should fetch at most once per 60 s when unknown kids arrive repeatedly (A4)", async () => {
        const { cache, fetcher, clock } = harness([doc(k1)]);
        await cache.refresh("boot");
        expect(JWKS_MIN_FETCH_INTERVAL_MS).toBe(MINUTE);

        // Within a minute of the boot attempt: every demand fetch is gated.
        expect(await cache.getKey("ghost-1")).toBeUndefined();
        clock.t += 59_999;
        expect(await cache.getKey("ghost-2")).toBeUndefined();
        expect(fetcher).toHaveBeenCalledTimes(1);

        clock.t += 1;
        expect(await cache.getKey("ghost-3")).toBeUndefined();
        expect(await cache.getKey("ghost-4")).toBeUndefined();
        clock.t += 30_000;
        expect(await cache.getKey("ghost-5")).toBeUndefined();
        expect(fetcher).toHaveBeenCalledTimes(2);

        // boot / interval are never gated.
        expect(await cache.refresh("interval")).toBe(true);
        expect(fetcher).toHaveBeenCalledTimes(3);
    });

    it("should count a failed attempt toward the 60 s gate (A4)", async () => {
        const { cache, fetcher, clock } = harness([new JwksFetchError("network")]);
        expect(await cache.getKey("k1")).toBeUndefined(); // no_keys → fetch fails
        expect(await cache.getKey("k1")).toBeUndefined(); // gated
        clock.t += 59_000;
        expect(await cache.getKey("k1")).toBeUndefined(); // still gated
        expect(fetcher).toHaveBeenCalledTimes(1);
        clock.t += 1_000;
        expect(await cache.getKey("k1")).toBeUndefined();
        expect(fetcher).toHaveBeenCalledTimes(2);
    });

    it("should refetch once and return the key when an unknown kid appears after rotation (A4)", async () => {
        const { cache, fetcher, clock } = harness([doc(k1), doc(k1, k2)]);
        await cache.refresh("boot");
        clock.t += MINUTE + 1;

        const key = await cache.getKey("k2");
        expect(key).toBeDefined();
        expect(key?.type).toBe("public");
        expect(fetcher).toHaveBeenCalledTimes(2);
        expect(await cache.getKey("k1")).toBeDefined();
        expect(fetcher).toHaveBeenCalledTimes(2);
    });

    const malformed: Array<[string, () => unknown]> = [
        ["a keys member that is not an array", () => ({ keys: "k1" })],
        ["an empty key set", () => ({ keys: [] })],
        ["duplicate kids", () => ({ keys: [{ ...k2.publicJwk, kid: "dup" }, { ...k1.publicJwk, kid: "dup" }] })],
        ["more than 16 keys", () => ({ keys: Array.from({ length: 17 }, (_, i) => ({ ...k2.publicJwk, kid: `k${i}` })) })],
        ["a non-Ed25519 key", () => ({ keys: [{ ...k2.publicJwk, crv: "X25519" }] })],
        ["an RSA key", () => ({ keys: [{ kty: "RSA", n: "AQAB", e: "AQAB", kid: "rsa", alg: "RS256", use: "sig" }] })],
        ["a key with a private member", () => ({ keys: [{ ...k2.publicJwk, d: "A".repeat(43) }] })],
        ["a key with an empty private member", () => ({ keys: [{ ...k2.publicJwk, d: "" }] })],
        ["a key with a wrong use next to extra members", () => ({ keys: [{ ...k2.publicJwk, use: "enc", key_ops: ["verify"] }] })],
        ["a non-object body", () => "not-a-jwks"],
    ];

    it.each(malformed)("should keep the previous set when the response has %s (A6)", async (_label, bad) => {
        const { cache, log } = harness([doc(k1), bad()]);
        await cache.refresh("boot");

        expect(await cache.refresh("interval")).toBe(false);
        expect(await cache.getKey("k1")).toBeDefined();
        expect(log.warn).toHaveBeenCalledWith(
            "jwks_refresh_failed",
            expect.objectContaining({ trigger: "interval", reason: "invalid_document" }),
        );
        expect(log.metric).toHaveBeenCalledWith("jwks_refresh_failed", 1, { reason: "invalid_document" });
    });

    it("should strip unknown public members and still verify with the key (contract Jwk allows extras, L5)", async () => {
        const extended = {
            keys: [{ ...k2.publicJwk, key_ops: ["verify"], x5t: "synthetic-thumbprint" }],
            extra: true,
        };
        const { cache, log } = harness([extended]);
        expect(await cache.refresh("boot")).toBe(true);
        expect(log.warn).not.toHaveBeenCalled();

        const key = await cache.getKey("k2");
        expect(key).toBeDefined();
        const token = await signUserToken(k2);
        const { jwtVerify } = await import("jose");
        await expect(jwtVerify(token, key as NonNullable<typeof key>)).resolves.toMatchObject({ protectedHeader: { kid: "k2" } });
    });

    it("should drop a removed kid when a refresh succeeds (A6)", async () => {
        const { cache, fetcher } = harness([doc(k1, k2), doc(k1)]);
        await cache.refresh("boot");
        expect(await cache.getKey("k2")).toBeDefined();

        expect(await cache.refresh("interval")).toBe(true);
        expect(await cache.getKey("k2")).toBeUndefined(); // replaced wholesale; the unknown-kid refetch is gated
        expect(await cache.getKey("k1")).toBeDefined();
        expect(fetcher).toHaveBeenCalledTimes(2);
    });

    it("should return keys between 5 min and 1 h old and start a background refresh without awaiting it (A5)", async () => {
        const never = new Promise<unknown>(() => undefined);
        const { cache, fetcher, clock } = harness([doc(k1), never]);
        await cache.refresh("boot");

        clock.t += 5 * MINUTE + 1;
        const key = await cache.getKey("k1"); // resolves although the stale refresh never settles
        expect(key).toBeDefined();
        expect(fetcher).toHaveBeenCalledTimes(2);

        // Up to the 1 h cap (the stale refresh is still in flight) the cached key keeps verifying.
        clock.t = clock.t - (5 * MINUTE + 1) + JWKS_MAX_STALE_MS;
        expect(await cache.getKey("k1")).toBeDefined();
    });

    it("should keep returning cached keys while refreshes fail and return undefined once the set is older than 1 h (A5)", async () => {
        const failure = new JwksFetchError("http_status", 503);
        const { cache, clock } = harness([doc(k1), failure]);
        const start = clock.t;
        await cache.refresh("boot");

        clock.t = start + 30 * MINUTE;
        await cache.refresh("interval");
        expect(await cache.getKey("k1")).toBeDefined();

        clock.t = start + JWKS_MAX_STALE_MS;
        expect(await cache.getKey("k1")).toBeDefined(); // exactly 1 h: still trusted

        clock.t = start + JWKS_MAX_STALE_MS + 1;
        expect(await cache.getKey("k1")).toBeUndefined(); // never a key older than 1 h
        clock.t += 2 * MINUTE;
        expect(await cache.getKey("k1")).toBeUndefined();
    });

    it("should log jwks_keys_expired once per crossing of the 1 h cap and again after a success resets it (A5)", async () => {
        const failure = new JwksFetchError("timeout");
        const { cache, clock, log, fetcher } = harness([doc(k1), failure]);
        await cache.refresh("boot");

        clock.t += JWKS_MAX_STALE_MS + 1;
        await cache.getKey("k1");
        clock.t += 2 * MINUTE;
        await cache.getKey("k1");
        expect(log.messages("error").filter((message) => message === "jwks_keys_expired")).toHaveLength(1);

        fetcher.mockImplementationOnce(() => Promise.resolve(doc(k1)));
        expect(await cache.refresh("interval")).toBe(true);
        clock.t += JWKS_MAX_STALE_MS + 1;
        await cache.getKey("k1");
        expect(log.messages("error").filter((message) => message === "jwks_keys_expired")).toHaveLength(2);
        expect(log.error).toHaveBeenCalledWith("jwks_keys_expired", { host: "identity.example.test:3000" });
    });

    it("should report up only when the set is younger than 1 h and the last attempt succeeded (A7)", async () => {
        const { cache, clock, fetcher } = harness([doc(k1), new JwksFetchError("network"), doc(k1)]);
        expect(cache.status()).toBe("down"); // never fetched

        await cache.refresh("boot");
        expect(cache.status()).toBe("up");

        await cache.refresh("interval"); // fails: keys still usable, status down
        expect(cache.status()).toBe("down");
        expect(await cache.getKey("k1")).toBeDefined();

        await cache.refresh("interval");
        expect(cache.status()).toBe("up");

        clock.t += JWKS_MAX_STALE_MS + 1; // no attempt since: too old
        expect(cache.status()).toBe("down");
        expect(fetcher).toHaveBeenCalledTimes(3);
    });

    it("should log host and reason but never the path, query, or body when a fetch fails", async () => {
        const { cache, log } = harness([new JwksFetchError("http_status", 503)]);
        await cache.refresh("boot");
        expect(log.warn).toHaveBeenCalledWith("jwks_refresh_failed", {
            trigger: "boot",
            host: "identity.example.test:3000",
            reason: "http_status",
            status: 503,
        });
        expect(log.metric).toHaveBeenCalledWith("jwks_refresh_failed", 1, { reason: "http_status" });

        const bodyHarness = harness([{ keys: [{ kty: "OKP", crv: "Ed25519", x: "SYNTHETIC-BODY-VALUE-9931" }] }]);
        await bodyHarness.cache.refresh("boot");
        for (const text of [log.text(), bodyHarness.log.text()]) {
            expect(text).not.toContain("/.well-known");
            expect(text).not.toContain("synthetic-query-4410");
            expect(text).not.toContain("SYNTHETIC-BODY-VALUE-9931");
        }
    });

    it("should map an unexpected fetcher error to reason network", async () => {
        const { cache, log } = harness([new Error("socket hang up")]);
        expect(await cache.refresh("boot")).toBe(false);
        expect(log.warn).toHaveBeenCalledWith("jwks_refresh_failed", expect.objectContaining({ reason: "network" }));
    });

    it("should abort an in-flight fetch and clear the interval when stopped, without reporting a failure", async () => {
        let seen: AbortSignal | undefined;
        const { cache, fetcher, timers, log } = harness([]);
        fetcher.mockImplementation(
            (_url, signal) =>
                new Promise((_resolve, reject) => {
                    seen = signal;
                    signal.addEventListener("abort", () => reject(new JwksFetchError("network")));
                }),
        );

        cache.start();
        const inFlight = cache.refresh("interval");
        cache.stop();
        expect(await inFlight).toBe(false);
        expect(seen?.aborted).toBe(true);
        expect(timers.cleared).toBe(1);
        expect(log.warn).not.toHaveBeenCalled();

        cache.stop(); // idempotent
        expect(timers.cleared).toBe(1);
    });
});
