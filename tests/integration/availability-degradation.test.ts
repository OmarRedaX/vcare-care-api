/**
 * availability degradation (slice S2) — Redis down, the worker down (empty index) and Identity down never produce a 5xx.
 * Real Postgres and wiring; Redis is "down" through an unreachable client swapped in for the index, the container and Identity's cache
 * (`withRedisDown`), Identity through the fake server's down and slow modes.
 *
 * Rule map: AV-R12 (Redis down never changes /slots or the profile), AV-R17 (cursor kinds), AV-R18 (cap), AV-R20 (every degraded combination and its
 * order, earliest cursor refused while Redis is down), AV-R21 (profile slots exact without Redis), AV-R22 (Case 2 never fails), ADR 0006 and 0026.
 */
import { getEnv } from "../../src/lib/config/env";
import type { SlotInputsLoader } from "../../src/app/availability/service/slot-inputs.loader";
import { container } from "../../src/lib/di/container";
import { TOKENS } from "../../src/lib/di/tokens";
import { redis } from "../../src/lib/redis/redis";
import { useAvailabilityHarness } from "../helpers/availability-harness";
import type { DoctorSeed } from "../helpers/availability-seed";
import { seedDoctor } from "../helpers/availability-seed";
import { expectErrorEnvelope } from "../helpers/contract";
import { ownerDb } from "../helpers/db";

jest.setTimeout(90_000);

interface Row { userId: number; nextAvailableAt: string | null; displayName: string | null; profileHydrated: boolean }
interface SearchBody { data: Row[]; meta: { nextCursor: string | null; hasMore: boolean; count: number; degraded?: string[] } }
const NOW = Date.parse("2026-11-03T05:00:00Z"); // a Tuesday
const FIRST = "2026-11-03T09:00:00.000Z";
const COUNT = 25;
const user = (i: number): number => 5000 + i;

describe("availability degradation (integration)", () => {
    const a = useAvailabilityHarness("availability-degradation");
    const CAP = getEnv().AVAILABILITY_INLINE_MISS_CAP;

    async function doctor(seed: DoctorSeed): Promise<number> {
        const profileId = await seedDoctor(seed);
        a.h.identityServer.users.set(seed.userId, { id: seed.userId, fullName: `Dr Degraded ${seed.userId}`, avatarUrl: null, status: "active" });
        return profileId;
    }
    /** Doctor i has fee 2000 - 10 i, so price order is the reverse of profile id order and differs from the earliest order. */
    beforeEach(async () => {
        a.h.clock.freeze(NOW);
        for (let i = 0; i < COUNT; i += 1) await doctor({ userId: user(i), fee: 2000 - i * 10, headline: `Synthetic degraded ${i}`, hours: { start: "09:00", end: "17:00" } });
    });
    const PRICE_ORDER = Array.from({ length: COUNT }, (_, i) => user(COUNT - 1 - i));
    const body = (response: { body: unknown }): SearchBody => response.body as SearchBody;
    const down = <T>(fn: () => Promise<T>): Promise<T> => a.withRedisDown(fn);
    const indexSize = (): Promise<number> => redis.zcard("next-available:index");

    describe("Redis down (AV-R20)", () => {
        it("should answer 200 in price order with meta.degraded sort and compute positions for at most the cap, lowest profile ids first", async () => {
            const result = await down(async () => {
                const response = await a.search({ limit: 100 });
                expect(response.status).toBe(200);
                return body(response);
            });
            expect(result.data.map((row) => row.userId)).toEqual(PRICE_ORDER);
            expect(result.meta).toMatchObject({ degraded: ["sort"], hasMore: false, nextCursor: null, count: COUNT });
            const known = result.data.filter((row) => row.nextAvailableAt !== null);
            expect(known).toHaveLength(CAP);
            expect(known.map((row) => row.userId).sort()).toEqual(Array.from({ length: CAP }, (_, i) => user(i)));
            expect(known.every((row) => row.nextAvailableAt === FIRST)).toBe(true);
            // The five doctors beyond the cap are the cheapest, hence first in this price order, with an unknown position.
            expect(result.data.slice(0, COUNT - CAP).every((row) => row.nextAvailableAt === null)).toBe(true);
            // Nothing was written: Redis was unreachable.
            expect(await indexSize()).toBe(0);
        });

        it("should run one batched computation of at most the cap doctors and no Redis write when serving a degraded page", async () => {
            const loader = jest.spyOn(container.resolve<SlotInputsLoader>(TOKENS.SlotInputsLoader), "loadShortestType");
            try {
                await down(async () => { expect((await a.search({ limit: 100 })).status).toBe(200); });
                expect(loader).toHaveBeenCalledTimes(1);
                expect(loader.mock.calls[0]![0].length).toBe(CAP);
            } finally { loader.mockRestore(); }
        });

        it("should page the degraded order with degraded cursors while Redis stays down", async () => {
            await down(async () => {
                const seen: number[] = [];
                let cursor: string | undefined;
                const sizes: number[] = [];
                do {
                    await a.h.resetRateLimits();
                    const response = body(await a.search({ limit: 10, cursor }));
                    expect(response.meta.degraded).toEqual(["sort"]);
                    seen.push(...response.data.map((row) => row.userId));
                    sizes.push(response.data.length);
                    cursor = response.meta.nextCursor ?? undefined;
                } while (cursor !== undefined && sizes.length < 6);
                expect(sizes).toEqual([10, 10, 5]);
                expect(seen).toEqual(PRICE_ORDER);
            });
        });

        it.each([
            ["default sort with a window", { availableFrom: "2026-11-03T20:00:00Z", availableTo: "2026-11-03T20:15:00Z" }, ["sort", "availabilityFilter"]],
            ["price sort with a window", { sort: "price", availableFrom: "2026-11-03T20:00:00Z", availableTo: "2026-11-03T20:15:00Z" }, ["availabilityFilter"]],
            ["price sort with a name", { sort: "price", name: "synthetic" }, ["nameFilter"]],
            ["default sort with a name", { name: "synthetic" }, ["sort", "nameFilter"]],
            ["price sort with a window and a name", { sort: "price", availableFrom: "2026-11-03T20:00:00Z", name: "synthetic" }, ["availabilityFilter", "nameFilter"]],
            ["default sort with a window and a name", { availableTo: "2026-11-04T09:00:00Z", name: "synthetic" }, ["sort", "availabilityFilter", "nameFilter"]],
            ["experience sort alone", { sort: "experience" }, undefined],
        ])("should report the degraded parts in the fixed order when Redis is down: %s", async (_label, params, expected) => {
            const result = await down(async () => {
                const response = await a.search({ ...(params as Record<string, string>), limit: 100 });
                expect(response.status).toBe(200);
                return body(response);
            });
            expect(result.meta.degraded).toEqual(expected);
            // An ignored window filter returns doctors it would have excluded; a headline-only name still matches the fixture headlines.
            expect(result.data).toHaveLength(COUNT);
        });

        it("should keep the search 200 and ignore a window that no doctor satisfies when Redis is down", async () => {
            const withRedis = body(await a.search({ availableFrom: "2026-11-03T20:00:00Z", availableTo: "2026-11-03T20:15:00Z", limit: 100 }));
            expect(withRedis.data).toEqual([]);
            const withoutRedis = await down(async () => body(await a.search({ availableFrom: "2026-11-03T20:00:00Z", availableTo: "2026-11-03T20:15:00Z", limit: 100 })));
            expect(withoutRedis.data).toHaveLength(COUNT);
            expect(withoutRedis.meta.degraded).toEqual(["sort", "availabilityFilter"]);
        });

        it("should still refuse an invalid window, fee range or cursor with 400 while Redis is down", async () => {
            await down(async () => {
                for (const params of [{ availableFrom: "2026-11-03T04:00:00Z" }, { minFee: 9, maxFee: 1 }, { cursor: "garbage" }]) {
                    const response = await a.search(params);
                    expect(response.status).toBe(400);
                    expectErrorEnvelope(response.body, "ValidationFailed");
                }
            });
        });

        it("should refuse a cursor issued under the Redis-backed earliest order while Redis is down", async () => {
            const first = body(await a.search({ limit: 2 }));
            expect(first.meta.degraded).toBeUndefined();
            await down(async () => {
                const response = await a.search({ limit: 2, cursor: first.meta.nextCursor! });
                expect(response.status).toBe(400);
                expectErrorEnvelope(response.body, "ValidationFailed");
                expect(response.body.error.details).toEqual([{ field: "cursor", issue: "does not match the requested sort" }]);
                // The restarted list works.
                expect((await a.search({ limit: 2 })).status).toBe(200);
            });
        });

        it("should return 200 with unhydrated profiles when Redis and Identity are both down, and never a 5xx", async () => {
            a.h.identityServer.options.down = true;
            const statuses: number[] = [];
            await down(async () => {
                for (const params of [{}, { sort: "price" }, { sort: "experience" }, { name: "synthetic" }, { availableFrom: "2026-11-03T06:00:00Z" }, { minFee: 1900 }]) {
                    await a.h.resetRateLimits();
                    const response = await a.search(params);
                    statuses.push(response.status);
                    expect(response.status).toBe(200);
                    expect(body(response).data.every((row) => row.displayName === null && !row.profileHydrated)).toBe(true);
                }
                const profile = await a.profile(user(0));
                statuses.push(profile.status);
                expect(profile.body.data).toMatchObject({ displayName: null, profileHydrated: false });
            });
            expect(statuses.every((status) => status < 500)).toBe(true);
        });
    });

    describe("worker down: the index was never filled (AV-R18)", () => {
        it("should answer 200 without meta.degraded, rank unknown doctors last and compute at most the cap inline", async () => {
            expect(await indexSize()).toBe(0);
            const loader = jest.spyOn(container.resolve<SlotInputsLoader>(TOKENS.SlotInputsLoader), "loadShortestType");
            try {
                const response = await a.search({ limit: 100 });
                expect(response.status).toBe(200);
                const result = body(response);
                expect(result.meta.degraded).toBeUndefined();
                expect(result.data.map((row) => row.userId)).toEqual(Array.from({ length: COUNT }, (_, i) => user(i)));
                expect(result.data.slice(0, CAP).every((row) => row.nextAvailableAt === FIRST)).toBe(true);
                expect(result.data.slice(CAP).every((row) => row.nextAvailableAt === null)).toBe(true);
                expect(loader).toHaveBeenCalledTimes(1);
                expect(loader.mock.calls[0]![0].length).toBe(CAP);
            } finally { loader.mockRestore(); }
            expect(await indexSize()).toBe(CAP);
        });

        it("should recover to full knowledge once the worker runs a sweep", async () => {
            await a.search({ limit: 100 });
            expect(await a.sweep()).toBe("done");
            const result = body(await a.search({ limit: 100 }));
            expect(result.data.every((row) => row.nextAvailableAt === FIRST)).toBe(true);
            expect(await indexSize()).toBe(COUNT);
        });

        it("should recompute entries that were lost when the index key vanished (Redis restart)", async () => {
            await a.sweep();
            await redis.del("next-available:index");
            const result = body(await a.search({ limit: 100 }));
            expect(result.data.filter((row) => row.nextAvailableAt !== null)).toHaveLength(CAP);
            expect(await indexSize()).toBe(CAP);
        });
    });

    describe("Identity down or slow never fails a search or a profile (AV-R22)", () => {
        it("should return 200 with profileHydrated false for a search and a profile when Identity is down", async () => {
            a.h.identityServer.options.down = true;
            const search = await a.search({ limit: 5 });
            expect(search.status).toBe(200);
            expect(body(search).data.every((row) => !row.profileHydrated && row.displayName === null)).toBe(true);
            const profile = await a.profile(user(3));
            expect(profile.status).toBe(200);
            expect(profile.body.data).toMatchObject({ displayName: null, avatarUrl: null, profileHydrated: false });
            expect(profile.body.data.nextAvailableSlots).toHaveLength(5);
        });

        it("should return 200 with profileHydrated false for a profile when Identity is slower than the 2 s attempt budget", async () => {
            a.h.identityServer.options.slowMs = 2_600;
            const profile = await a.profile(user(3));
            expect(profile.status).toBe(200);
            expect(profile.body.data.profileHydrated).toBe(false);
        });
    });

    describe("the profile without Redis (AV-R12, AV-R21)", () => {
        it("should return the exact slots from Postgres when Redis is down even though the cache holds a stale list", async () => {
            const cached = await a.profile(user(2));
            expect(cached.status).toBe(200);
            const first = cached.body.data.nextAvailableSlots[0].startsAt as string;
            expect(first).toBe(FIRST);
            // A booking inserted behind the application's back: the warm cache still shows the old first slot, the database does not.
            const type = (await ownerDb("consultation_types").where({ doctor_profile_id: 3 }).first())!;
            await ownerDb("consultations").insert({ doctor_user_id: user(2), patient_user_id: 101, consultation_type_id: Number(type.id), starts_at: new Date(first),
                ends_at: new Date(Date.parse(first) + 30 * 60_000), status: "booked", complaint_text: "SYNTHETIC-DEGRADED-BOOKING", patient_timezone: "UTC", price: 1000,
                currency: "EGP", idempotency_key: "00000000-0000-4000-8000-000000000001", request_hash: "a".repeat(64) });
            expect((await a.profile(user(2))).body.data.nextAvailableSlots[0].startsAt).toBe(first);
            const exact = await down(async () => {
                const response = await a.profile(user(2));
                expect(response.status).toBe(200);
                return response.body.data;
            });
            expect(exact.nextAvailableSlots).toHaveLength(5);
            expect(exact.nextAvailableSlots[0].startsAt).toBe("2026-11-03T09:30:00.000Z");
            expect(exact.nextAvailableAt).toBe("2026-11-03T09:30:00.000Z");
            expect(exact.nextAvailableSlots.map((slot: { startsAt: string }) => slot.startsAt)).not.toContain(first);
        });

        it("should return the same profile with and without Redis when nothing is cached", async () => {
            const without = await down(async () => (await a.profile(user(4), "patient", "Africa/Cairo")).body.data);
            const withRedis = (await a.profile(user(4), "patient", "Africa/Cairo")).body.data;
            expect(without.nextAvailableSlots).toEqual(withRedis.nextAvailableSlots);
            expect(without.nextAvailableAt).toBe(withRedis.nextAvailableAt);
            expect(without.consultationTypes).toEqual(withRedis.consultationTypes);
        });

        it("should keep the admin status and the 404 for a non-bookable doctor when Redis is down", async () => {
            await ownerDb("doctor_profiles").where({ user_id: user(5) }).update({ is_accepting_patients: false });
            await down(async () => {
                expect((await a.profile(user(5), "patient")).status).toBe(404);
                const admin = await a.profile(user(5), "admin");
                expect(admin.status).toBe(200);
                expect(admin.body.data.status).toBe("not_bookable");
            });
        });

        it("should serve /slots from Postgres when Redis is down", async () => {
            const typeId = Number((await ownerDb("consultation_types").where({ doctor_profile_id: 1 }).first())!.id);
            const url = `/api/doctors/${user(0)}/slots?typeId=${typeId}&from=${encodeURIComponent("2026-11-03T05:00:00Z")}&to=${encodeURIComponent("2026-11-04T05:00:00Z")}`;
            const live = await down(async () => (await a.get(url)).body);
            expect(live.data).toHaveLength(16);
            expect(live.data[0].startsAt).toBe(FIRST);
            expect((await a.get(url)).body.data).toEqual(live.data);
        });
    });
});
