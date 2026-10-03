import { JwksCache } from "../../src/lib/auth/jwks-cache";
import { UserTokenVerifier } from "../../src/lib/auth/user-token-verifier";
import { TOKENS } from "../../src/lib/di/tokens";
import { logger } from "../../src/lib/logger/logger";
import { withContainerOverrides } from "./app";
import { startFakeHttpServer } from "./fake-http-server";
import { generateSigningKey } from "./tokens";
import type { FakeJwks, FakeJwksCacheOptions, FakeJwksWiring, FakeRoute, SigningKey, TestClock } from "./types";

export const JWKS_PATH = "/.well-known/jwks.json";

/**
 * The only faked dependency of the access suites (CLAUDE.md → Testing policy): Identity's public JWKS endpoint, served
 * over real HTTP so the real `undici` fetcher, DTO validation, and cache run unchanged. Keys are generated per run.
 */
export async function startFakeJwks(kids: string[]): Promise<FakeJwks> {
    const keys = new Map<string, SigningKey>();
    const published = new Set<string>();
    const route: FakeRoute = { method: "GET", path: JWKS_PATH, status: 200 };

    const publish = (): void => {
        route.body = { keys: [...published].map((kid) => keys.get(kid)?.publicJwk) };
    };

    for (const kid of kids) {
        keys.set(kid, await generateSigningKey(kid));
        published.add(kid);
    }
    publish();

    const server = await startFakeHttpServer([route]);

    return {
        jwksUrl: `${server.url}${JWKS_PATH}`,
        keys,
        key(kid: string): SigningKey {
            const key = keys.get(kid);
            if (key === undefined) {
                throw new Error(`fake JWKS never generated kid ${kid}`);
            }
            return key;
        },
        async addKey(kid: string): Promise<SigningKey> {
            const key = await generateSigningKey(kid);
            keys.set(kid, key);
            published.add(kid);
            publish();
            return key;
        },
        removeKey(kid: string): void {
            published.delete(kid);
            publish();
        },
        setBody(raw: string | undefined, contentType?: string): void {
            route.rawBody = raw;
            route.contentType = contentType;
        },
        setMode: (mode, options) => server.setMode(mode, options),
        requests: server.requests,
        close: () => server.close(),
    };
}

/** A clock that only moves when the test says so (epoch ms). */
export function createTestClock(start = Date.now()): TestClock {
    let current = start;
    return {
        now: () => current,
        advance: (ms: number) => {
            current += ms;
        },
    };
}

/** A real `JwksCache` + `UserTokenVerifier` pointed at the fake (never started: no background timer). */
export async function buildFakeJwksWiring(fake: FakeJwks, options?: FakeJwksCacheOptions): Promise<FakeJwksWiring> {
    const cache = new JwksCache({ url: fake.jwksUrl, logger, now: options?.clock?.now });
    const verifier = new UserTokenVerifier({ jwks: cache });
    if (options?.prime ?? true) {
        const loaded = await cache.refresh("boot");
        if (!loaded) {
            throw new Error("fake JWKS could not be loaded");
        }
    }
    return { cache, verifier };
}

/**
 * Runs `fn` with `TOKENS.JwksCache` and `TOKENS.UserTokenVerifier` swapped for a cache on the fake JWKS. Apps must be
 * built inside `fn` only when they resolve these at build time; `userGuard()` resolves the verifier per request.
 */
export async function withFakeJwksCache(
    fake: FakeJwks,
    fn: (wiring: FakeJwksWiring) => Promise<void> | void,
    options?: FakeJwksCacheOptions,
): Promise<void> {
    const wiring = await buildFakeJwksWiring(fake, options);
    try {
        await withContainerOverrides(
            [
                { token: TOKENS.JwksCache, value: wiring.cache },
                { token: TOKENS.UserTokenVerifier, value: wiring.verifier },
            ],
            () => fn(wiring),
        );
    } finally {
        wiring.cache.stop();
    }
}
