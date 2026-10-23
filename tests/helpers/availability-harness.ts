import type Redis from "ioredis";
import type { Test } from "supertest";
import request from "supertest";
import type { Express } from "express";
import { AvailabilityController } from "../../src/app/availability/controller/availability.controller";
import { AvailabilityRefreshService } from "../../src/app/availability/service/availability-refresh.service";
import { AvailabilitySweepService } from "../../src/app/availability/service/availability-sweep.service";
import { AvailabilityService } from "../../src/app/availability/service/availability.service";
import { DiscoveryService } from "../../src/app/availability/service/discovery.service";
import type { NextAvailableComputer } from "../../src/app/availability/service/next-available.computer";
import type { NextAvailableIndex } from "../../src/app/availability/service/next-available.index";
import type { DoctorDiscoveryReader } from "../../src/app/doctors/service/doctor-discovery.reader";
import { container } from "../../src/lib/di/container";
import { TOKENS } from "../../src/lib/di/tokens";
import type { IdentityClient } from "../../src/lib/identity-client/identity-client";
import { db } from "../../src/lib/knex/knex";
import { logger } from "../../src/lib/logger/logger";
import { redis } from "../../src/lib/redis/redis";
import type { TickOutcome } from "../../src/lib/worker/types";
import { buildTestApps, withContainerOverrides } from "./app";
import type { Actor, ConsultationsHarness } from "./consultations-harness";
import { useConsultationsHarness } from "./consultations-harness";
import { truncateAll } from "./db";
import { captureLogs } from "./log-capture";
import { createUnreachableRedis, flushByPrefix } from "./redis";
import type { LogCapture } from "./types";

/** Every Redis prefix the discovery module (and its callers) derives or counts; flushed before each test. */
export const DISCOVERY_PREFIXES = ["slots:", "slots-ver:", "next-available:", "free-map:", "rl:", "idem:", "identity:"];

export interface AvailabilityHarness {
    h: ConsultationsHarness;
    index: NextAvailableIndex;
    computer: NextAvailableComputer;
    reader: DoctorDiscoveryReader;
    /** `GET` with a bearer for an actor (default patient). The limiter (60/min per IP) is reset before each test; loops call `h.resetRateLimits()`. */
    get(path: string, actor?: Actor): Test;
    /** `GET /api/doctors?...` (undefined values are skipped). */
    /** `GET` with an arbitrary bearer (an expired or ad hoc token), or none. */
    getWith(path: string, token?: string): Test;
    search(params?: Record<string, string | number | undefined>, actor?: Actor): Test;
    profile(userId: number | string, actor?: Actor, timezone?: string): Test;
    sweepService(): AvailabilitySweepService;
    refreshService(): AvailabilityRefreshService;
    sweep(signal?: AbortSignal): Promise<TickOutcome | void>;
    refresh(): Promise<TickOutcome | void>;
    /**
     * Runs `fn` with a Redis that can never connect: the API index, the container's Redis (rate limiter, idempotency) and Identity's hydration cache all
     * use it. `keepRateLimiter` leaves the limiter on the real Redis (the per-instance fallback allows only 30 requests a minute, too few for a latency run).
     */
    withRedisDown<T>(fn: () => Promise<T>, options?: { keepRateLimiter?: boolean }): Promise<T>;
    /** Rank-index members with scores, `userId -> epoch ms`. */
    indexScores(): Promise<Map<number, number>>;
    clearDerived(): Promise<void>;
}

/**
 * The consultations harness (real routes, services, Postgres and Redis; fake Identity, JWKS, controllable clock) plus a rebuilt
 * discovery stack on the same clock and Identity client, and empty doctor tables (each suite seeds its own). Registers its hooks, so
 * call it inside `describe`. Its cleanup runs before the shared harness closes the Redis client and the pools.
 */
/** Display names and avatar URLs of every fixture of the discovery suites (spec AV-R29: they never reach a log line). */
const FORBIDDEN_IN_LOGS = /Dr (Fixture Name|Fresh|Page|Degraded|Bench|Synthetic|Other Synthetic)|Pat (Synthetic|Other Synthetic)|example\.test\/(avatar|a\.png)|avatar-\d+/;

export function useAvailabilityHarness(suite: string, options: { captureLogs?: boolean } = {}): AvailabilityHarness {
    let app: Express;
    let capture: LogCapture | undefined;
    let level: { restore(): void } | undefined;
    afterAll(async () => {
        if (capture !== undefined) {
            capture.restore();
            level?.restore();
            // Every line the suite wrote at debug level: non-vacuous, and free of display names and avatar URLs.
            expect(capture.lines().some((line) => line.message === "request_completed")).toBe(true);
            expect(FORBIDDEN_IN_LOGS.exec(capture.text())?.[0]).toBeUndefined();
        }
        await flushByPrefix(DISCOVERY_PREFIXES);
    });
    const h = useConsultationsHarness(suite);

    beforeAll(() => {
        if (options.captureLogs !== false) {
            level = jest.replaceProperty(logger as unknown as { level: string }, "level", "debug");
            capture = captureLogs();
        }
        // The boot-time singletons hold the boot-time clock and Identity client: rebuild them on the test doubles, then rebuild the apps.
        container.registerSingleton(TOKENS.AvailabilityService, AvailabilityService);
        container.registerSingleton(TOKENS.DiscoveryService, DiscoveryService);
        container.registerSingleton(TOKENS.AvailabilityController, AvailabilityController);
        app = buildTestApps().publicApp;
    });
    beforeEach(async () => {
        await truncateAll();
        await flushByPrefix(DISCOVERY_PREFIXES);
        h.identityServer.users.clear();
    });

    const harness: AvailabilityHarness = {
        h,
        get index() { return container.resolve<NextAvailableIndex>(TOKENS.NextAvailableIndex); },
        get computer() { return container.resolve<NextAvailableComputer>(TOKENS.NextAvailableComputer); },
        get reader() { return container.resolve<DoctorDiscoveryReader>(TOKENS.DoctorDiscoveryReader); },
        get: (path, actor = "patient") => request(app).get(path).set("Authorization", `Bearer ${h.tokens[actor]}`),
        getWith(path, token) {
            const test = request(app).get(path);
            return token === undefined ? test : test.set("Authorization", `Bearer ${token}`);
        },
        search(params = {}, actor = "patient") {
            const query = new URLSearchParams();
            for (const [key, value] of Object.entries(params)) if (value !== undefined) query.set(key, String(value));
            const text = query.toString();
            return harness.get(`/api/doctors${text === "" ? "" : `?${text}`}`, actor);
        },
        profile(userId, actor = "patient", timezone) {
            return harness.get(`/api/doctors/${userId}${timezone === undefined ? "" : `?timezone=${encodeURIComponent(timezone)}`}`, actor);
        },
        sweepService: () => new AvailabilitySweepService(db, harness.reader, harness.computer, harness.index, logger, h.clock),
        refreshService: () => new AvailabilityRefreshService(harness.reader, harness.computer, harness.index, logger, h.clock),
        sweep: (signal = new AbortController().signal) => harness.sweepService().tick(signal),
        refresh: () => harness.refreshService().tick(new AbortController().signal),
        async withRedisDown<T>(fn: () => Promise<T>, options: { keepRateLimiter?: boolean } = {}): Promise<T> {
            const unreachable: Redis = createUnreachableRedis();
            const identity = container.resolve<IdentityClient>(TOKENS.IDENTITY_CLIENT) as unknown as { options: Record<string, unknown> };
            const indexProperty = jest.replaceProperty(harness.index as unknown as { redis: Redis }, "redis", unreachable);
            const identityProperty = jest.replaceProperty(identity, "options", { ...identity.options, redis: unreachable });
            let result!: T;
            try {
                await withContainerOverrides(options.keepRateLimiter === true ? [] : [{ token: TOKENS.Redis, value: unreachable }], async () => { result = await fn(); });
            } finally {
                indexProperty.restore(); identityProperty.restore(); unreachable.disconnect();
            }
            return result;
        },
        async indexScores() {
            const flat = await redis.zrange("next-available:index", 0, -1, "WITHSCORES");
            const scores = new Map<number, number>();
            for (let i = 0; i < flat.length; i += 2) scores.set(Number(flat[i]), Number(flat[i + 1]));
            return scores;
        },
        clearDerived: () => flushByPrefix(DISCOVERY_PREFIXES),
    };
    return harness;
}
