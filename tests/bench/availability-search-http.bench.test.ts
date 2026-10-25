/**
 * availability search and profile latency budgets (slice S2; `npm run test:bench`) — real Postgres and Redis, 2,500 bookable doctors, in-process HTTP
 * through the real wiring, fake Identity. Budgets (CLAUDE.md -> Performance rules, spec 8): search p95 < 400 ms, 14-day slots p95 < 300 ms. Each measured
 * run is 100 requests after 10 warm-up requests; the rate-limit window is reset outside the timer.
 *
 * Rule map: AV-R17/AV-R18 (indexed order, inline cap on a cold index), AV-R20 (Redis down stays inside the budget), spec 8 (evidence required before merge).
 */
import { DateTime } from "luxon";
import { useAvailabilityHarness } from "../helpers/availability-harness";
import { seedBulkDoctors, seedBulkSpecialties } from "../helpers/availability-seed";
import { ownerDb } from "../helpers/db";
import { flushByPrefix } from "../helpers/redis";
import { redis } from "../../src/lib/redis/redis";

jest.setTimeout(900_000);

const COUNT = 2_500;
const FIRST_USER_ID = 100_000;
const SEARCH_BUDGET_MS = 400;
const SLOTS_BUDGET_MS = 300;
const WARM_UP = 10;
const RUNS = 100;

describe("availability search HTTP latency budgets (real Postgres and Redis, 2,500 bookable doctors)", () => {
    const a = useAvailabilityHarness("availability-search-bench", { captureLogs: false });
    const results: Array<{ label: string; p95: number; max: number; budget: number }> = [];

    async function measure(label: string, budget: number, request: () => PromiseLike<{ status: number }>, before?: () => Promise<void>): Promise<number> {
        const durations: number[] = [];
        for (let i = 0; i < WARM_UP + RUNS; i += 1) {
            await a.h.resetRateLimits();
            if (before !== undefined) await before();
            const start = performance.now();
            const response = await request();
            const elapsed = performance.now() - start;
            expect(response.status).toBe(200);
            if (i >= WARM_UP) durations.push(elapsed);
        }
        durations.sort((x, y) => x - y);
        const p95 = durations[94]!;
        results.push({ label, p95, max: durations[durations.length - 1]!, budget });
        process.stderr.write(`availability search bench ${label}: p95 ${p95.toFixed(1)} ms (max ${durations[durations.length - 1]!.toFixed(1)} ms, budget ${budget} ms)\n`);
        return p95;
    }

    it("should serve every sort, a filter combination and a window below 400 ms p95 with a warm index, a cold index and Redis down, and slots below 300 ms", async () => {
        await seedBulkSpecialties();
        await seedBulkDoctors({ count: COUNT, firstUserId: FIRST_USER_ID, bookableEvery: 1, withHours: true });
        for (let i = 0; i < COUNT; i += 1) {
            a.h.identityServer.users.set(FIRST_USER_ID + i, { id: FIRST_USER_ID + i, fullName: `Dr Bench ${i}`, avatarUrl: null, status: "active" });
        }
        const windowFrom = DateTime.now().plus({ hours: 3 }).toUTC().toISO();
        const windowTo = DateTime.now().plus({ hours: 6 }).toUTC().toISO();

        // Warm index: one sweep (the worker's job), then steady state.
        const sweepStarted = performance.now();
        expect(await a.sweep()).toBe("done");
        process.stderr.write(`availability search bench sweep of ${COUNT} doctors: ${(performance.now() - sweepStarted).toFixed(0)} ms\n`);
        expect(await redis.zcard("next-available:index")).toBe(COUNT);
        const filters = { specialty: "spec-3", language: "en", minFee: 200, maxFee: 800 };
        for (const sort of ["earliest_availability", "price", "experience"]) {
            await measure(`warm ${sort}`, SEARCH_BUDGET_MS, () => a.search({ sort }));
            await measure(`warm ${sort} + filters`, SEARCH_BUDGET_MS, () => a.search({ sort, ...filters }));
        }
        const first = await a.search({ limit: 20 });
        await measure("warm earliest page 2", SEARCH_BUDGET_MS, () => a.search({ limit: 20, cursor: first.body.meta.nextCursor }));
        await measure("warm earliest + window", SEARCH_BUDGET_MS, () => a.search({ availableFrom: windowFrom, availableTo: windowTo }));

        // Cold index: the index key is gone before every request, so every candidate is a miss and the inline cap applies (20 computed).
        const dropIndex = async (): Promise<void> => { await redis.del("next-available:index"); };
        for (const sort of ["earliest_availability", "price", "experience"]) {
            await measure(`cold ${sort}`, SEARCH_BUDGET_MS, () => a.search({ sort }), dropIndex);
        }
        await measure("cold earliest + window", SEARCH_BUDGET_MS, () => a.search({ availableFrom: windowFrom, availableTo: windowTo }), dropIndex);

        // Redis down: price order with at most 20 positions computed from Postgres.
        await a.withRedisDown(async () => {
            await measure("redis down earliest (degraded to price)", SEARCH_BUDGET_MS, () => a.search({}));
        }, { keepRateLimiter: true });

        // Slots must stay untouched at this scale: 14 days, a doctor with 150 busy consultations, cache miss and hit.
        const profile = (await ownerDb("doctor_profiles").where({ user_id: FIRST_USER_ID }).first())!;
        const type = (await ownerDb("consultation_types").where({ doctor_profile_id: profile.id }).first())!;
        const day0 = DateTime.now().toUTC().plus({ days: 1 }).startOf("day");
        await ownerDb("consultations").insert(Array.from({ length: 150 }, (_, i) => {
            const start = day0.plus({ days: Math.floor(i / 12), hours: 9, minutes: (i % 12) * 30 });
            return { doctor_user_id: FIRST_USER_ID, patient_user_id: 1000 + i, consultation_type_id: Number(type.id), starts_at: start.toJSDate(),
                ends_at: start.plus({ minutes: 30 }).toJSDate(), status: "booked", complaint_text: "Synthetic benchmark complaint", patient_timezone: "UTC", price: 1000,
                currency: "EGP", idempotency_key: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, request_hash: "a".repeat(64) };
        }));
        const slotsUrl = `/api/doctors/${FIRST_USER_ID}/slots?typeId=${Number(type.id)}&from=${encodeURIComponent(day0.toISO())}&to=${encodeURIComponent(day0.plus({ days: 14 }).toISO())}`;
        await measure("slots 14 days cache miss (150 busy)", SLOTS_BUDGET_MS, () => a.get(slotsUrl), () => flushByPrefix(["slots:"]));
        await measure("slots 14 days cache hit (150 busy)", SLOTS_BUDGET_MS, () => a.get(slotsUrl));

        const violations = results.filter((entry) => entry.p95 >= entry.budget);
        expect(violations).toEqual([]);
    });
});
