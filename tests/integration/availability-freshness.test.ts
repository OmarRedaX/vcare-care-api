/**
 * availability freshness of the rank index, free-map, refresh set and sweep (slice S2) — real Postgres, real Redis, controllable clock,
 * fake Identity.
 *
 * Rule map: AV-R10 (listener fan-in), AV-R11 (which events fire), AV-R18 (miss definition, inline cap, window exclusion beyond the cap),
 * AV-R19 (known-none sentinel), AV-R23 (sweep: repair, stale members, swept-at only on a full pass, singleton), AV-R24 (refresh drains the set),
 * decision D3 (version-guarded writes).
 */
import { randomUUID } from "node:crypto";
import { getEnv } from "../../src/lib/config/env";
import type { SlotInputsLoader } from "../../src/app/availability/service/slot-inputs.loader";
import { container } from "../../src/lib/di/container";
import { TOKENS } from "../../src/lib/di/tokens";
import { redis } from "../../src/lib/redis/redis";
import { useAvailabilityHarness } from "../helpers/availability-harness";
import type { DoctorSeed } from "../helpers/availability-seed";
import { seedBulkDoctors, seedDoctor } from "../helpers/availability-seed";
import { DOCTOR } from "../helpers/consultations-harness";
import { ownerDb } from "../helpers/db";

jest.setTimeout(120_000);

interface SearchBody { data: Array<{ userId: number; nextAvailableAt: string | null }>; meta: { nextCursor: string | null; hasMore: boolean; count: number; degraded?: string[] } }
const NONE_SCORE = 1e15;
const NOW = Date.parse("2026-11-03T05:00:00Z"); // a Tuesday
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("availability freshness (integration)", () => {
    const a = useAvailabilityHarness("availability-freshness");
    const CAP = getEnv().AVAILABILITY_INLINE_MISS_CAP;

    async function doctor(seed: DoctorSeed): Promise<number> {
        const profileId = await seedDoctor(seed);
        a.h.identityServer.users.set(seed.userId, { id: seed.userId, fullName: `Dr Fresh ${seed.userId}`, avatarUrl: null, status: "active" });
        return profileId;
    }
    const ids = (body: SearchBody): number[] => body.data.map((item) => item.userId);
    const search = async (params: Record<string, string | number | undefined> = {}): Promise<SearchBody> => {
        await a.h.resetRateLimits();
        const response = await a.search(params);
        expect(response.status).toBe(200);
        return response.body as SearchBody;
    };
    const next = async (userId: number): Promise<string | null | undefined> => (await search()).data.find((item) => item.userId === userId)?.nextAvailableAt;
    const inIndex = async (userId: number): Promise<boolean> => (await redis.zscore("next-available:index", String(userId))) !== null;
    const inRefresh = async (userId: number): Promise<boolean> => (await redis.sismember("next-available:refresh", String(userId))) === 1;
    const hasMap = async (userId: number): Promise<boolean> => (await redis.exists(`free-map:${userId}`)) === 1;
    const sweptAt = (): Promise<string | null> => redis.get("next-available:swept-at");
    beforeEach(() => { a.h.clock.freeze(NOW); });

    describe("lost invalidation repaired by one sweep (AV-R23)", () => {
        it("should serve the stale position until the sweep tick recomputes it and stamps swept-at", async () => {
            await doctor({ userId: 4001, hours: { start: "09:00", end: "17:00" } });
            expect(await next(4001)).toBe("2026-11-03T09:00:00.000Z");
            // Hours changed behind the application's back: no listener ran, so the index still holds the old position.
            await ownerDb("working_hours").update({ start_time: "13:00" });
            expect(await next(4001)).toBe("2026-11-03T09:00:00.000Z");
            expect(await sweptAt()).toBeNull();
            expect(await a.sweep()).toBe("done");
            expect(await next(4001)).toBe("2026-11-03T13:00:00.000Z");
            expect(await sweptAt()).toBe(String(NOW));
        });

        it("should recompute a position whose time has already passed because a score at or before now is a miss", async () => {
            await doctor({ userId: 4002, hours: { start: "09:00", end: "17:00" } });
            expect(await next(4002)).toBe("2026-11-03T09:00:00.000Z");
            a.h.clock.freeze(Date.parse("2026-11-03T09:10:00Z"));
            expect(await next(4002)).toBe("2026-11-03T09:30:00.000Z");
        });

        it("should index every bookable doctor with a free-map and a bounded TTL on one sweep, and none that is not bookable", async () => {
            await doctor({ userId: 4003 });
            await doctor({ userId: 4004 });
            await doctor({ userId: 4005, suspended: true });
            await doctor({ userId: 4006, hours: false });
            expect(await a.sweep()).toBe("done");
            const scores = await a.indexScores();
            expect([...scores.keys()].sort()).toEqual([4003, 4004, 4006]);
            expect(scores.get(4003)).toBe(Date.parse("2026-11-03T09:00:00Z"));
            expect(scores.get(4006)).toBe(NONE_SCORE);
            for (const userId of [4003, 4004, 4006]) {
                expect(await hasMap(userId)).toBe(true);
                const ttl = await redis.ttl(`free-map:${userId}`);
                expect(ttl).toBeGreaterThan(0);
                expect(ttl).toBeLessThanOrEqual(600);
            }
            expect(await hasMap(4005)).toBe(false);
            expect((await redis.getBuffer("free-map:4003"))!.length).toBe(173);
        });

        it("should hold only ids, epoch scores and bitmaps under the derived prefixes: no name, avatar or clinical text (AV-R29)", async () => {
            await doctor({ userId: 4007, headline: "Synthetic headline 4007" });
            await doctor({ userId: 4008 });
            await search({ limit: 100 });
            expect(await a.sweep()).toBe("done");
            await a.profile(4007);
            await redis.sadd("next-available:refresh", "4007");
            const seen: string[] = [];
            for (const prefix of ["slots:", "slots-ver:", "next-available:", "free-map:"]) {
                let cursor = "0";
                do {
                    const [nextCursor, keys] = await redis.scan(cursor, "MATCH", `${prefix}*`, "COUNT", 500);
                    cursor = nextCursor;
                    for (const key of keys) {
                        seen.push(key);
                        const type = await redis.type(key);
                        if (type === "zset") seen.push(...await redis.zrange(key, 0, -1, "WITHSCORES"));
                        else if (type === "set") seen.push(...await redis.smembers(key));
                        else seen.push((await redis.getBuffer(key))!.toString("latin1"));
                    }
                } while (cursor !== "0");
            }
            expect(seen.length).toBeGreaterThan(6);
            const text = seen.join(" | ");
            for (const forbidden of ["Dr Fresh", "Fresh", "avatar", "Synthetic headline", "@example.test"]) expect(text).not.toContain(forbidden);
            expect((await redis.zrange("next-available:index", 0, -1)).every((member) => /^\d+$/.test(member))).toBe(true);
        });

        it("should remove index members that stopped being bookable or never existed, and their free-maps, on the next sweep", async () => {
            for (const userId of [4011, 4012, 4013, 4014, 4015]) await doctor({ userId });
            expect(await a.sweep()).toBe("done");
            expect((await a.indexScores()).size).toBe(5);
            await ownerDb("doctor_profiles").where({ user_id: 4013 }).update({ suspended_at: new Date(), suspension_reason: "Synthetic suspension" });
            await ownerDb("doctor_profiles").where({ user_id: 4014 }).update({ is_accepting_patients: false });
            await ownerDb("consultation_types").where({ doctor_profile_id: (await ownerDb("doctor_profiles").where({ user_id: 4015 }).first())!.id }).update({ is_active: false });
            await redis.zadd("next-available:index", 123, "999999");
            expect(await a.sweep()).toBe("done");
            expect([...(await a.indexScores()).keys()].sort()).toEqual([4011, 4012]);
            for (const userId of [4013, 4014, 4015]) expect(await hasMap(userId)).toBe(false);
        });

        it("should not stamp swept-at when the tick is aborted, and stamp it on the next full pass", async () => {
            await doctor({ userId: 4021 });
            const aborted = new AbortController();
            aborted.abort();
            expect(await a.sweep(aborted.signal)).toBe("incomplete");
            expect(await sweptAt()).toBeNull();
            expect(await a.sweep()).toBe("done");
            expect(await sweptAt()).toBe(String(NOW));
        });

        it("should report incomplete and leave swept-at alone while another session holds the sweep lock", async () => {
            await doctor({ userId: 4031 });
            let release!: () => void;
            let held!: () => void;
            const heldPromise = new Promise<void>((resolve) => { held = resolve; });
            const releasePromise = new Promise<void>((resolve) => { release = resolve; });
            const holder = ownerDb.transaction(async (trx) => {
                await trx.raw("SELECT pg_advisory_xact_lock(hashtextextended(?::text, ?::bigint))", ["0", 1104]);
                held();
                await releasePromise;
            });
            await heldPromise;
            try {
                expect(await a.sweep()).toBe("incomplete");
                expect(await sweptAt()).toBeNull();
                expect((await a.indexScores()).size).toBe(0);
            } finally { release(); await holder; }
            expect(await a.sweep()).toBe("done");
            expect(await sweptAt()).toBe(String(NOW));
            expect((await a.indexScores()).size).toBe(1);
        });

        it("should run one sweep and refuse the other when two ticks start concurrently (singleton)", async () => {
            await seedBulkDoctors({ count: 300, firstUserId: 40_000, bookableEvery: 1, withHours: true });
            const lockHeld = async (): Promise<boolean> => {
                const result = await ownerDb.raw<{ rows: Array<{ n: number }> }>(`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND granted
                    AND ((classid::bigint << 32) | objid::bigint) = hashtextextended('0', 1104)`);
                return (result.rows[0]?.n ?? 0) > 0;
            };
            const first = a.sweep();
            const deadline = Date.now() + 10_000;
            while (!(await lockHeld())) {
                if (Date.now() > deadline) throw new Error("the first sweep never took the advisory lock");
                await delay(5);
            }
            const second = await a.sweep();
            expect(second).toBe("incomplete");
            expect(await first).toBe("done");
            expect((await a.indexScores()).size).toBe(300);
            expect(await sweptAt()).toBe(String(NOW));
            expect(await a.sweep()).toBe("done");
        });
    });

    describe("a change removes the member immediately and refresh drains the set (AV-R10, AV-R24)", () => {
        beforeEach(async () => { await doctor({ userId: DOCTOR, hours: { start: "09:00", end: "17:00" } }); });
        const weekdays = [1, 2, 3, 4, 5, 6, 7];

        it("should drop the member and its free-map, queue a refresh, and show the new position on the very next search", async () => {
            expect(await next(DOCTOR)).toBe("2026-11-03T09:00:00.000Z");
            expect(await inIndex(DOCTOR)).toBe(true);
            expect(await hasMap(DOCTOR)).toBe(true);
            const put = await a.h.call("put", "/api/doctors/me/working-hours", "doctor", { days: weekdays.map((weekday) => ({ weekday, intervals: [{ startTime: "13:00", endTime: "17:00" }] })) });
            expect(put.status).toBe(200);
            expect(await inIndex(DOCTOR)).toBe(false);
            expect(await hasMap(DOCTOR)).toBe(false);
            expect(await inRefresh(DOCTOR)).toBe(true);
            expect(await next(DOCTOR)).toBe("2026-11-03T13:00:00.000Z");
        });

        it("should recompute the member on one refresh tick and empty the refresh set", async () => {
            await next(DOCTOR);
            const put = await a.h.call("put", "/api/doctors/me/working-hours", "doctor", { days: weekdays.map((weekday) => ({ weekday, intervals: [{ startTime: "14:00", endTime: "17:00" }] })) });
            expect(put.status).toBe(200);
            expect(await inIndex(DOCTOR)).toBe(false);
            expect(await a.refresh()).toBe("done");
            expect(await redis.scard("next-available:refresh")).toBe(0);
            expect((await a.indexScores()).get(DOCTOR)).toBe(Date.parse("2026-11-03T14:00:00Z"));
            expect(await hasMap(DOCTOR)).toBe(true);
            const loader = jest.spyOn(container.resolve<SlotInputsLoader>(TOKENS.SlotInputsLoader), "loadShortestType");
            try {
                expect(await next(DOCTOR)).toBe("2026-11-03T14:00:00.000Z");
                expect(loader).not.toHaveBeenCalled();
            } finally { loader.mockRestore(); }
        });

        it("should drain a set larger than one batch in one tick and drop doctors that are no longer bookable without indexing them", async () => {
            await seedBulkDoctors({ count: 120, firstUserId: 50_000, bookableEvery: 1, withHours: true });
            await doctor({ userId: 4101, suspended: true });
            const members = Array.from({ length: 120 }, (_, i) => String(50_000 + i));
            await redis.sadd("next-available:refresh", ...members, "4101", "888888");
            expect(await a.refresh()).toBe("done");
            expect(await redis.scard("next-available:refresh")).toBe(0);
            const scores = await a.indexScores();
            expect(scores.size).toBe(120);
            expect(scores.has(4101)).toBe(false);
            expect(scores.has(888888)).toBe(false);
        });

        it("should report an empty tick as done without touching the index", async () => {
            expect(await a.refresh()).toBe("done");
            expect((await a.indexScores()).size).toBe(0);
        });
    });

    describe("listener fan-in (AV-R10, AV-R11)", () => {
        beforeEach(async () => { await doctor({ userId: DOCTOR, hours: { start: "09:00", end: "17:00" }, timezone: "UTC" }); });
        const prime = async (): Promise<void> => {
            await next(DOCTOR);
            expect(await inIndex(DOCTOR)).toBe(true);
            await redis.del("next-available:refresh");
        };
        const gone = async (): Promise<void> => {
            expect(await inIndex(DOCTOR)).toBe(false);
            expect(await hasMap(DOCTOR)).toBe(false);
            expect(await inRefresh(DOCTOR)).toBe(true);
        };

        it("should remove the doctor from the index when PATCH /doctors/me changes the timezone", async () => {
            await prime();
            expect((await a.h.call("patch", "/api/doctors/me", "doctor", { timezone: "Africa/Cairo" })).status).toBe(200);
            await gone();
            expect(await next(DOCTOR)).toBe("2026-11-03T07:00:00.000Z");
        });

        it("should remove the doctor when PATCH /doctors/me toggles accepting patients off and on", async () => {
            await prime();
            expect((await a.h.call("patch", "/api/doctors/me", "doctor", { isAcceptingPatients: false })).status).toBe(200);
            await gone();
            expect(ids(await search())).toEqual([]);
            expect((await a.profile(DOCTOR, "patient")).status).toBe(404);
            expect((await a.h.call("patch", "/api/doctors/me", "doctor", { isAcceptingPatients: true })).status).toBe(200);
            expect(await inIndex(DOCTOR)).toBe(false);
            expect(ids(await search())).toEqual([DOCTOR]);
        });

        it("should keep the member when a PATCH changes nothing", async () => {
            await prime();
            expect((await a.h.call("patch", "/api/doctors/me", "doctor", { timezone: "UTC", isAcceptingPatients: true })).status).toBe(200);
            expect(await inIndex(DOCTOR)).toBe(true);
            expect(await inRefresh(DOCTOR)).toBe(false);
        });

        it("should remove the doctor from the index and from search when an admin suspends, and again when an admin reinstates", async () => {
            await prime();
            const suspend = await a.h.call("patch", `/api/admin/doctors/${DOCTOR}/suspend`, "admin", { reason: "Synthetic suspension reason" });
            expect(suspend.status).toBe(200);
            await gone();
            expect(ids(await search())).toEqual([]);
            await redis.zadd("next-available:index", NOW + 1000, String(DOCTOR));
            await redis.set(`free-map:${DOCTOR}`, "stale");
            await redis.del("next-available:refresh");
            const reinstate = await a.h.call("patch", `/api/admin/doctors/${DOCTOR}/reinstate`, "admin", { reason: "Synthetic reinstatement reason" });
            expect(reinstate.status).toBe(200);
            await gone();
            expect(ids(await search())).toEqual([DOCTOR]);
        });

        it("should not fire for a no-op suspension of an already suspended doctor", async () => {
            expect((await a.h.call("patch", `/api/admin/doctors/${DOCTOR}/suspend`, "admin", { reason: "Synthetic suspension reason" })).status).toBe(200);
            await redis.zadd("next-available:index", NOW + 1000, String(DOCTOR));
            expect((await a.h.call("patch", `/api/admin/doctors/${DOCTOR}/suspend`, "admin", { reason: "Synthetic suspension reason" })).status).toBe(200);
            expect(await inIndex(DOCTOR)).toBe(true);
        });

        it("should remove a doctor from a window result at once when a patient books the only free slot, and restore it on cancel", async () => {
            await ownerDb("working_hours").update({ deleted_at: new Date() });
            const profile = (await ownerDb("doctor_profiles").where({ user_id: DOCTOR }).first())!;
            await ownerDb("working_hours").insert({ doctor_profile_id: profile.id, weekday: 2, start_time: "09:00", end_time: "09:30" });
            await a.clearDerived();
            const typeId = Number((await ownerDb("consultation_types").where({ doctor_profile_id: profile.id }).first())!.id);
            const window = { availableFrom: "2026-11-03T09:00:00Z", availableTo: "2026-11-03T09:15:00Z" };
            expect(ids(await search(window))).toEqual([DOCTOR]);
            const booked = await a.h.book("patient", { doctorId: DOCTOR, typeId, startsAt: "2026-11-03T09:00:00Z", complaintText: "SYNTHETIC-FRESHNESS-BOOKING-1", patientTimezone: "UTC" }, randomUUID());
            expect(booked.status).toBe(201);
            expect(await inIndex(DOCTOR)).toBe(false);
            expect(ids(await search(window))).toEqual([]);
            expect((await a.h.cancel(Number(booked.body.data.id), "patient")).status).toBe(200);
            expect(ids(await search(window))).toEqual([DOCTOR]);
            expect(await next(DOCTOR)).toBe("2026-11-03T09:00:00.000Z");
        });
    });

    describe("inline miss cap (AV-R18)", () => {
        beforeEach(async () => {
            for (let i = 0; i < 25; i += 1) await doctor({ userId: 4200 + i, hours: { start: "09:00", end: "17:00" } });
        });
        const firstIds = (count: number): number[] => Array.from({ length: count }, (_, i) => 4200 + i);

        it("should compute at most the cap cold doctors inline in ascending profile id order and rank the rest last with a null position", async () => {
            expect(CAP).toBeGreaterThan(0);
            expect(CAP).toBeLessThan(25);
            const body = await search({ limit: 100 });
            expect(body.data).toHaveLength(25);
            const known = body.data.filter((item) => item.nextAvailableAt !== null);
            expect(known.map((item) => item.userId)).toEqual(firstIds(CAP));
            expect(body.data.slice(0, CAP).every((item) => item.nextAvailableAt === "2026-11-03T09:00:00.000Z")).toBe(true);
            expect(body.data.slice(CAP).map((item) => item.userId)).toEqual(Array.from({ length: 25 - CAP }, (_, i) => 4200 + CAP + i));
            expect(body.data.slice(CAP).every((item) => item.nextAvailableAt === null)).toBe(true);
            expect((await a.indexScores()).size).toBe(CAP);
        });

        it("should compute the next cap-sized batch on the following request until the whole set is known", async () => {
            await search({ limit: 100 });
            const second = await search({ limit: 100 });
            expect(second.data.every((item) => item.nextAvailableAt === "2026-11-03T09:00:00.000Z")).toBe(true);
            expect((await a.indexScores()).size).toBe(Math.min(25, 2 * CAP));
        });

        it("should compute only the page rows on price order and cap them as well", async () => {
            const body = await search({ sort: "price", limit: 100 });
            expect(body.data.filter((item) => item.nextAvailableAt !== null)).toHaveLength(CAP);
            expect((await a.indexScores()).size).toBe(CAP);
            const small = await search({ sort: "price", limit: 5 });
            expect(small.data).toHaveLength(5);
        });

        it("should answer concurrent cold searches without duplicates or errors and share the inline computation", async () => {
            const loader = jest.spyOn(container.resolve<SlotInputsLoader>(TOKENS.SlotInputsLoader), "loadShortestType");
            try {
                const responses = await Promise.all(Array.from({ length: 8 }, () => a.search({ limit: 100 })));
                for (const response of responses) {
                    expect(response.status).toBe(200);
                    const listed = ids(response.body as SearchBody);
                    expect(new Set(listed).size).toBe(25);
                }
                const loaded = loader.mock.calls.reduce((total, call) => total + call[0].length, 0);
                // Without sharing, eight requests would load eight cap-sized batches.
                expect(loaded).toBeLessThan(8 * CAP);
                expect((await a.indexScores()).size).toBeGreaterThanOrEqual(CAP);
            } finally { loader.mockRestore(); }
        });

        it("should compute nothing inline when every candidate is already known and the loader is not called", async () => {
            expect(await a.sweep()).toBe("done");
            const loader = jest.spyOn(container.resolve<SlotInputsLoader>(TOKENS.SlotInputsLoader), "loadShortestType");
            try {
                const body = await search({ limit: 100 });
                expect(body.data.every((item) => item.nextAvailableAt === "2026-11-03T09:00:00.000Z")).toBe(true);
                expect(loader).not.toHaveBeenCalled();
            } finally { loader.mockRestore(); }
        });

        it("should exclude doctors beyond the cap from a window result and say so in meta.degraded", async () => {
            const body = await search({ availableFrom: "2026-11-03T09:00:00Z", availableTo: "2026-11-03T09:15:00Z", limit: 100 });
            expect(ids(body)).toEqual(firstIds(CAP));
            expect(body.meta.degraded).toEqual(["availabilityFilter"]);
            const again = await search({ availableFrom: "2026-11-03T09:00:00Z", availableTo: "2026-11-03T09:15:00Z", limit: 100 });
            expect(again.data).toHaveLength(Math.min(25, 2 * CAP));
        });

        it("should not flag a window result when every candidate position is known", async () => {
            expect(await a.sweep()).toBe("done");
            const body = await search({ availableFrom: "2026-11-03T09:00:00Z", availableTo: "2026-11-03T09:15:00Z", limit: 100 });
            expect(body.data).toHaveLength(25);
            expect(body.meta.degraded).toBeUndefined();
        });
    });

    describe("known-none sentinel (AV-R19)", () => {
        it("should store NONE_SCORE for a doctor without a free slot, rank it last with a null position, and not recompute it", async () => {
            await doctor({ userId: 4301, hours: false });
            await doctor({ userId: 4302 });
            const body = await search();
            expect(ids(body)).toEqual([4302, 4301]);
            expect(body.data[1]!.nextAvailableAt).toBeNull();
            expect((await a.indexScores()).get(4301)).toBe(NONE_SCORE);
            expect(await hasMap(4301)).toBe(true);
            const loader = jest.spyOn(container.resolve<SlotInputsLoader>(TOKENS.SlotInputsLoader), "loadShortestType");
            try {
                expect(ids(await search())).toEqual([4302, 4301]);
                expect(loader).not.toHaveBeenCalled();
            } finally { loader.mockRestore(); }
        });

        it("should keep a known-none doctor out of every window result", async () => {
            await doctor({ userId: 4311, hours: false });
            await a.sweep();
            expect(ids(await search({ availableFrom: "2026-11-03T05:00:00Z", availableTo: "2026-11-17T05:00:00Z" }))).toEqual([]);
        });
    });

    describe("the batch computation agrees with the slot list (AV-R3, AV-R19)", () => {
        const BUCKET = 900_000;
        const BUCKETS = 1344;
        interface Fixture { userId: number; shortest: number; typeId: number }
        const bits = (map: Buffer): { base: number; set: Set<number> } => {
            expect(map.length).toBe(173);
            expect(map[0]).toBe(1);
            const set = new Set<number>();
            const base = map.readUInt32BE(1);
            for (let i = 0; i < BUCKETS; i += 1) if ((map[5 + (i >> 3)]! & (0x80 >> (i & 7))) !== 0) set.add(base + i);
            return { base, set };
        };

        it("should store the first start and the exact 15-minute bucket set of GET /slots for doctors in extreme zones, with exceptions, split shifts and busy time", async () => {
            const fixtures: Fixture[] = [];
            const add = async (seed: DoctorSeed, shortest: number): Promise<number> => {
                const profileId = await doctor(seed);
                const types = await ownerDb("consultation_types").where({ doctor_profile_id: profileId }).orderBy([{ column: "duration_minutes" }, { column: "id" }]);
                fixtures.push({ userId: seed.userId, shortest, typeId: Number(types[0]!.id) });
                return profileId;
            };
            await add({ userId: 4501, hours: { start: "09:00", end: "17:00" } }, 30);
            const kiritimati = await add({ userId: 4502, timezone: "Pacific/Kiritimati", hours: { start: "08:00", end: "12:00" }, types: [{ minutes: 20 }] }, 20);
            await add({ userId: 4503, timezone: "Pacific/Pago_Pago", hours: { start: "22:00", end: "24:00", weekdays: [1, 2, 3, 4, 5] }, types: [{ minutes: 30 }] }, 30);
            const newYork = await add({ userId: 4504, timezone: "America/New_York", hours: false, types: [{ minutes: 30 }, { minutes: 50 }] }, 30);
            await add({ userId: 4505, timezone: "Asia/Kolkata", hours: { start: "10:00", end: "13:00" }, types: [{ name: "Long", minutes: 45 }, { name: "Short", minutes: 15 }] }, 15);
            await add({ userId: 4506, timezone: "Australia/Lord_Howe", hours: { start: "08:00", end: "16:00" }, types: [{ minutes: 5 }] }, 5);
            await add({ userId: 4507, timezone: "UTC", hours: false }, 30);
            await ownerDb("working_hours").insert([1, 2, 3, 4, 5].flatMap((weekday) => [
                { doctor_profile_id: newYork, weekday, start_time: "09:00", end_time: "12:00" }, { doctor_profile_id: newYork, weekday, start_time: "14:00", end_time: "18:00" }]));
            await ownerDb("schedule_exceptions").insert([
                { doctor_profile_id: kiritimati, date: "2026-11-05", type: "day_off" },
                { doctor_profile_id: newYork, date: "2026-11-05", type: "custom_hours", start_time: "13:00", end_time: "15:30" },
                { doctor_profile_id: newYork, date: "2026-11-04", type: "day_off" }]);
            const busyType = fixtures.find((fixture) => fixture.userId === 4504)!.typeId;
            const busy = (startIso: string, minutes: number, key: number) => ({ doctor_user_id: 4504, patient_user_id: 101, consultation_type_id: busyType, starts_at: new Date(startIso),
                ends_at: new Date(Date.parse(startIso) + minutes * 60_000), status: "booked", complaint_text: "SYNTHETIC-AGREEMENT-BUSY", patient_timezone: "UTC", price: 1000,
                currency: "EGP", idempotency_key: `00000000-0000-4000-8000-0000000000${String(key).padStart(2, "0")}`, request_hash: "a".repeat(64) });
            // Off-grid busy intervals that cut across the grid and across an interval edge.
            await ownerDb("consultations").insert([busy("2026-11-03T14:40:00Z", 50, 1), busy("2026-11-06T17:10:00Z", 45, 2), busy("2026-11-09T19:45:00Z", 120, 3)]);
            await a.clearDerived();
            expect(await a.sweep()).toBe("done");

            const base = Math.floor(NOW / BUCKET);
            const limit = (base + BUCKETS) * BUCKET;
            const from = new Date(NOW).toISOString();
            const to = new Date(NOW + 14 * 86_400_000).toISOString();
            const scores = await a.indexScores();
            for (const fixture of fixtures) {
                const response = await a.get(`/api/doctors/${fixture.userId}/slots?typeId=${fixture.typeId}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
                expect(response.status).toBe(200);
                const starts = (response.body.data as Array<{ startsAt: string }>).map((slot) => Date.parse(slot.startsAt)).filter((start) => start < limit);
                const expectedScore = starts[0] ?? NONE_SCORE;
                expect({ user: fixture.userId, score: scores.get(fixture.userId) }).toEqual({ user: fixture.userId, score: expectedScore });
                const stored = bits((await redis.getBuffer(`free-map:${fixture.userId}`))!);
                expect(stored.base).toBe(base);
                expect({ user: fixture.userId, buckets: [...stored.set].sort((x, y) => x - y) }).toEqual({
                    user: fixture.userId, buckets: [...new Set(starts.map((start) => Math.floor(start / BUCKET)))].sort((x, y) => x - y) });
                if (fixture.userId !== 4507) expect(starts.length).toBeGreaterThan(0);
            }
            // The profile preview is the first five of the same list.
            const profile = await a.profile(4505);
            const list = await a.get(`/api/doctors/4505/slots?typeId=${fixtures.find((fixture) => fixture.userId === 4505)!.typeId}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
            expect(profile.body.data.nextAvailableSlots).toEqual(list.body.data.slice(0, 5));
        });
    });

    describe("version guard (decision D3)", () => {
        const indexDoctor = async (userId: number): Promise<{ profileId: number; userId: number; timezone: string }> => {
            const row = (await ownerDb("doctor_profiles").where({ user_id: userId }).first())!;
            return { profileId: Number(row.id), userId, timezone: String(row.timezone) };
        };

        it("should discard a computation that started before an invalidation and queue the doctor for refresh", async () => {
            await doctor({ userId: 4401 });
            const computed = await a.computer.compute([await indexDoctor(4401)], NOW);
            expect(computed.entries).toHaveLength(1);
            expect(computed.entries[0]!.ver).toBe("0");
            await a.index.invalidate(4401); // an input changed while the computation was running
            const written = await a.computer.write(computed.entries);
            expect(written).toEqual({ stored: 0, failed: [] });
            expect(await inIndex(4401)).toBe(false);
            expect(await hasMap(4401)).toBe(false);
            expect(await inRefresh(4401)).toBe(true);
            expect(await redis.get("slots-ver:4401")).toBe("1");
        });

        it("should store the entry when no invalidation happened in between, and a recomputation after one", async () => {
            await doctor({ userId: 4402 });
            const first = await a.computer.compute([await indexDoctor(4402)], NOW);
            expect(await a.computer.write(first.entries)).toEqual({ stored: 1, failed: [] });
            expect((await a.indexScores()).get(4402)).toBe(Date.parse("2026-11-03T09:00:00Z"));
            await a.index.invalidate(4402);
            const second = await a.computer.compute([await indexDoctor(4402)], NOW);
            expect(second.entries[0]!.ver).toBe("1");
            expect(await a.computer.write(second.entries)).toEqual({ stored: 1, failed: [] });
            expect(await inIndex(4402)).toBe(true);
        });

        it("should keep one entry per doctor when a refresh and a sweep run for the same doctor back to back", async () => {
            await doctor({ userId: 4403 });
            await redis.sadd("next-available:refresh", "4403");
            expect(await a.refresh()).toBe("done");
            expect(await a.sweep()).toBe("done");
            expect(await redis.zcard("next-available:index")).toBe(1);
        });
    });
});
