import { randomUUID } from "node:crypto";
import { DateTime } from "luxon";
import type Redis from "ioredis";
import { NextAvailableIndex } from "../../src/app/availability/service/next-available.index";
import type { SlotInputsLoader } from "../../src/app/availability/service/slot-inputs.loader";
import { getEnv } from "../../src/lib/config/env";
import { container } from "../../src/lib/di/container";
import { TOKENS } from "../../src/lib/di/tokens";
import { redis } from "../../src/lib/redis/redis";
import { withContainerOverrides } from "../helpers/app";
import { COMPLAINT, DOCTOR, localStart, MINUTE, useConsultationsHarness } from "../helpers/consultations-harness";
import { ownerDb } from "../helpers/db";
import { createUnreachableRedis, ensureRedisReady, flushByPrefix } from "../helpers/redis";

jest.setTimeout(120_000);

const PREFIXES = ["slots:", "slots-ver:", "next-available:", "free-map:", "rl:", "idem:"];
const HEADLINE = "Synthetic headline";

describe("availability slots cache and invalidation (real Postgres and Redis)", () => {
    // Registered first so this cleanup runs before the shared harness closes its Redis client.
    afterAll(async () => { await flushByPrefix(PREFIXES); });
    const h = useConsultationsHarness("availability-slots-redis");
    let typeId: number;
    let profileId: number;
    let from: string;
    let to: string;

    const slotsUrl = (zone?: string): string => `/api/doctors/202/slots?typeId=${typeId}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}` +
        (zone === undefined ? "" : `&timezone=${encodeURIComponent(zone)}`);
    const slots = (zone?: string) => h.call("get", slotsUrl(zone), "patient");
    const values = async (): Promise<string[]> => {
        const keys = await scan("slots:202:");
        return Promise.all(keys.map((key) => redis.get(key).then((value) => value ?? "")));
    };
    async function scan(prefix: string): Promise<string[]> {
        const keys: string[] = [];
        let cursor = "0";
        do {
            const [next, page] = await redis.scan(cursor, "MATCH", `${prefix}*`, "COUNT", 500);
            cursor = next; keys.push(...page);
        } while (cursor !== "0");
        return keys.sort();
    }
    async function seededIndex(): Promise<void> {
        await redis.zadd("next-available:index", 123456, String(DOCTOR));
        await redis.set(`free-map:${DOCTOR}`, "synthetic-derived-map");
    }
    async function expectInvalidated(before: number): Promise<void> {
        expect(Number(await redis.get(`slots-ver:${DOCTOR}`))).toBe(before + 1);
        const ttl = await redis.ttl(`slots-ver:${DOCTOR}`);
        expect(ttl).toBeGreaterThan(0);
        expect(ttl).toBeLessThanOrEqual(604800);
        expect(await redis.zscore("next-available:index", String(DOCTOR))).toBeNull();
        expect(await redis.get(`free-map:${DOCTOR}`)).toBeNull();
        expect(await redis.sismember("next-available:refresh", String(DOCTOR))).toBe(1);
    }
    async function warm(): Promise<{ before: number; loader: jest.SpyInstance; first: string[] }> {
        const loader = jest.spyOn(container.resolve<SlotInputsLoader>(TOKENS.SlotInputsLoader), "loadForSlots");
        const response = await slots();
        expect(response.status).toBe(200);
        expect(loader).toHaveBeenCalledTimes(1);
        await seededIndex();
        return { before: Number(await redis.get(`slots-ver:${DOCTOR}`) ?? "0"), loader,
            first: (response.body.data as Array<{ startsAt: string }>).map((item) => item.startsAt) };
    }
    async function expectMiss(loader: jest.SpyInstance, expectedStatus = 200): Promise<string[]> {
        const response = await slots();
        expect(response.status).toBe(expectedStatus);
        if (expectedStatus === 200) {
            expect(loader).toHaveBeenCalledTimes(2);
            return (response.body.data as Array<{ startsAt: string }>).map((item) => item.startsAt);
        }
        expect(loader).toHaveBeenCalledTimes(1);
        return [];
    }
    async function book(start: string): Promise<number> {
        const response = await h.book("patient", { doctorId: DOCTOR, typeId, startsAt: start, complaintText: COMPLAINT, patientTimezone: "UTC" }, randomUUID());
        expect(response.status).toBe(201);
        return Number(response.body.data.id);
    }

    beforeAll(async () => { await ensureRedisReady(); });
    beforeEach(async () => {
        await flushByPrefix(PREFIXES);
        profileId = Number((await ownerDb("doctor_profiles").where({ user_id: DOCTOR }).first())?.id);
        typeId = Number((await ownerDb("consultation_types").where({ doctor_profile_id: profileId }).first())?.id);
        from = localStart(3, "09:00");
        to = localStart(3, "12:00");
    });
    afterEach(() => { jest.restoreAllMocks(); });

    it("should cache one versioned UTC range list when the same window is rendered in different zones", async () => {
        const loader = jest.spyOn(container.resolve<SlotInputsLoader>(TOKENS.SlotInputsLoader), "loadForSlots");
        const first = await slots();
        const second = await slots();
        const local = await slots("America/New_York");
        expect([first.status, second.status, local.status]).toEqual([200, 200, 200]);
        expect(loader).toHaveBeenCalledTimes(1);
        expect(local.body.data[0].startsAt).toBe(first.body.data[0].startsAt);
        expect(local.body.data[0].startsAtLocal).not.toBe(first.body.data[0].startsAtLocal);
        const keys = await scan("slots:202:");
        expect(keys).toHaveLength(1);
        const version = await redis.get("slots-ver:202") ?? "0";
        const fromDate = DateTime.fromISO(from).toISODate();
        expect(keys[0]).toBe(`slots:202:${version}:${typeId}:${fromDate}:${fromDate}`);
        const ttl = await redis.ttl(keys[0]!);
        expect(ttl).toBeGreaterThan(0);
        expect(ttl).toBeLessThanOrEqual(getEnv().SLOT_CACHE_TTL_SECONDS);
        const ranges: unknown = JSON.parse((await redis.get(keys[0]!))!);
        expect(Array.isArray(ranges)).toBe(true);
        expect(ranges).toEqual(expect.arrayContaining([[expect.any(Number), expect.any(Number)]]));
    });

    it("should invalidate and remove the booked start when a patient books", async () => {
        const { before, loader, first } = await warm();
        const id = await book(first[0]!);
        expect(Number((await ownerDb("consultations").where({ id }).first())?.id)).toBe(id);
        await expectInvalidated(before);
        expect(await expectMiss(loader)).not.toContain(first[0]);
    });

    it("should invalidate and restore the original start when a patient reschedules", async () => {
        const available = await slots();
        const starts = (available.body.data as Array<{ startsAt: string }>).map((item) => item.startsAt);
        const id = await book(starts[0]!);
        await flushByPrefix(["slots:"]);
        const { before, loader } = await warm();
        const moved = await h.reschedule(id, "patient", { startsAt: starts[2] });
        expect(moved.status).toBe(200);
        await expectInvalidated(before);
        const after = await expectMiss(loader);
        expect(after).toContain(starts[0]);
        expect(after).not.toContain(starts[2]);
    });

    it("should invalidate and restore the booked start when a patient cancels", async () => {
        const initial = await slots();
        const start = initial.body.data[0].startsAt as string;
        const id = await book(start);
        await flushByPrefix(["slots:"]);
        const { before, loader } = await warm();
        expect((await h.cancel(id, "patient")).status).toBe(200);
        await expectInvalidated(before);
        expect(await expectMiss(loader)).toContain(start);
    });

    it("should invalidate and restore the booked start when a doctor marks no-show", async () => {
        const first = await slots();
        const start = first.body.data[0].startsAt as string;
        const id = await book(start);
        await flushByPrefix(["slots:"]);
        const { before, loader } = await warm();
        h.clock.freeze(Date.parse(start) + getEnv().NO_SHOW_GRACE_MINUTES * MINUTE);
        expect((await h.call("patch", `/api/consultations/${id}/no-show`, "doctor")).status).toBe(200);
        h.clock.release();
        await expectInvalidated(before);
        expect(await expectMiss(loader)).toContain(start);
    });

    it("should invalidate yet keep the interval busy when a doctor completes early", async () => {
        const first = await slots();
        const start = first.body.data[0].startsAt as string;
        const id = await book(start);
        await flushByPrefix(["slots:"]);
        const { before, loader } = await warm();
        h.clock.freeze(Date.parse(start) + MINUTE);
        expect((await h.call("patch", `/api/consultations/${id}/join`, "doctor")).status).toBe(200);
        expect((await h.call("patch", `/api/consultations/${id}/start`, "doctor")).status).toBe(200);
        const afterStart = Number(await redis.get("slots-ver:202"));
        expect((await h.call("patch", `/api/consultations/${id}/complete`, "doctor")).status).toBe(200);
        h.clock.release();
        expect(afterStart).toBeGreaterThanOrEqual(before);
        await expectInvalidated(afterStart);
        // `completed` keeps its planned `ends_at` and the exclusion constraint still holds it, so the start is not offered again.
        expect(await expectMiss(loader)).not.toContain(start);
    });

    it("should invalidate and change starts when working hours are replaced", async () => {
        const { before, loader, first } = await warm();
        const weekday = DateTime.fromISO(from).weekday;
        const response = await h.call("put", "/api/doctors/me/working-hours", "doctor", { days: [{ weekday, intervals: [{ startTime: "10:00", endTime: "12:00" }] }] });
        expect(response.status).toBe(200);
        await expectInvalidated(before);
        expect(await expectMiss(loader)).not.toContain(first[0]);
    });

    it("should invalidate and remove starts when a day-off exception is created", async () => {
        const { before, loader, first } = await warm();
        const response = await h.call("post", "/api/doctors/me/exceptions", "doctor", { type: "day_off", date: DateTime.fromISO(from).toISODate() });
        expect(response.status).toBe(201);
        await expectInvalidated(before);
        expect(await expectMiss(loader)).toEqual([]);
        expect(first.length).toBeGreaterThan(0);
    });

    it("should invalidate and change the grid when consultation duration changes", async () => {
        const { before, loader, first } = await warm();
        const response = await h.call("patch", `/api/doctors/me/consultation-types/${typeId}`, "doctor", { durationMinutes: 60 });
        expect(response.status).toBe(200);
        await expectInvalidated(before);
        expect(await expectMiss(loader).then((items) => items.length)).toBeLessThan(first.length);
    });

    it("should invalidate and rerender when the doctor timezone changes", async () => {
        const { before, loader } = await warm();
        expect((await h.call("patch", "/api/doctors/me", "doctor", { timezone: "UTC" })).status).toBe(200);
        await expectInvalidated(before);
        const response = await slots();
        expect(response.status).toBe(200);
        expect(response.body.meta.doctorTimezone).toBe("UTC");
        expect(loader).toHaveBeenCalledTimes(2);
    });

    it("should invalidate on accepting toggle and reject the cached list while not bookable", async () => {
        const { before, loader } = await warm();
        expect((await h.call("patch", "/api/doctors/me", "doctor", { isAcceptingPatients: false })).status).toBe(200);
        await expectInvalidated(before);
        await expectMiss(loader, 404);
        const disabledVersion = Number(await redis.get("slots-ver:202"));
        expect((await h.call("patch", "/api/doctors/me", "doctor", { isAcceptingPatients: true })).status).toBe(200);
        expect(Number(await redis.get("slots-ver:202"))).toBe(disabledVersion + 1);
        await expectMiss(loader);
    });

    it("should invalidate on suspension and reinstatement through the Identity boundary", async () => {
        const { before, loader } = await warm();
        expect((await h.call("patch", "/api/admin/doctors/202/suspend", "admin", { reason: "Synthetic suspension" })).status).toBe(200);
        await expectInvalidated(before);
        await expectMiss(loader, 404);
        await seededIndex();
        const suspendedVersion = Number(await redis.get("slots-ver:202"));
        expect((await h.call("patch", "/api/admin/doctors/202/reinstate", "admin", { reason: "Synthetic reinstatement" })).status).toBe(200);
        await expectInvalidated(suspendedVersion);
        await expectMiss(loader);
    });

    it("should keep the version unchanged when timezone and accepting PATCH values are identical", async () => {
        await warm();
        const version = await redis.get("slots-ver:202");
        expect((await h.call("patch", "/api/doctors/me", "doctor", { timezone: "Africa/Cairo" })).status).toBe(200);
        expect((await h.call("patch", "/api/doctors/me", "doctor", { isAcceptingPatients: true })).status).toBe(200);
        expect(await redis.get("slots-ver:202")).toBe(version);
    });

    it("should return 404 for a now unbookable doctor even if the cache remains warm", async () => {
        await warm();
        await ownerDb("doctor_profiles").where({ id: profileId }).update({ is_accepting_patients: false });
        expect((await slots()).status).toBe(404);
        expect(await scan("slots:202:")).toHaveLength(1);
    });

    it("should commit a booking when the listener index rejects", async () => {
        const first = await slots();
        const start = first.body.data[0].startsAt as string;
        jest.spyOn(NextAvailableIndex.prototype, "invalidate").mockRejectedValueOnce(new Error("synthetic listener failure"));
        const id = await book(start);
        expect((await ownerDb("consultations").where({ id }).first())?.status).toBe("booked");
    });

    it("should commit a cancellation and hours write when the listener index rejects", async () => {
        const first = await slots();
        const id = await book(first.body.data[0].startsAt as string);
        jest.spyOn(NextAvailableIndex.prototype, "invalidate").mockRejectedValue(new Error("synthetic listener failure"));
        expect((await h.cancel(id, "patient")).status).toBe(200);
        expect((await ownerDb("consultations").where({ id }).first())?.status).toBe("cancelled");
        const weekday = DateTime.fromISO(from).weekday;
        expect((await h.call("put", "/api/doctors/me/working-hours", "doctor", { days: [{ weekday, intervals: [{ startTime: "10:00", endTime: "12:00" }] }] })).status).toBe(200);
        expect((await ownerDb("working_hours").where({ doctor_profile_id: profileId, weekday }).whereNull("deleted_at").first())?.start_time).toMatch(/^10:00/);
    });

    it("should write successfully and compute slots from Postgres when Redis is unreachable", async () => {
        const unreachable = createUnreachableRedis();
        const index = container.resolve<NextAvailableIndex>(TOKENS.NextAvailableIndex);
        const loader = jest.spyOn(container.resolve<SlotInputsLoader>(TOKENS.SlotInputsLoader), "loadForSlots");
        const redisProperty = jest.replaceProperty(index as unknown as { redis: Redis }, "redis", unreachable);
        try {
            await withContainerOverrides([{ token: TOKENS.Redis, value: unreachable }], async () => {
                const first = await slots();
                expect(first.status).toBe(200);
                const id = await book(first.body.data[0].startsAt as string);
                expect((await ownerDb("consultations").where({ id }).first())?.status).toBe("booked");
                const again = await slots();
                expect(again.status).toBe(200);
                expect(again.body.data.map((item: { startsAt: string }) => item.startsAt)).not.toContain(first.body.data[0].startsAt);
                expect(loader).toHaveBeenCalledTimes(2);
                expect(await scan("slots:202:")).toEqual([]);
            });
        } finally { redisProperty.restore(); unreachable.disconnect(); }
    });

    it("should store no clinical or personal fixture text under availability prefixes after a burst", async () => {
        const first = await slots();
        const id = await book(first.body.data[0].startsAt as string);
        await slots();
        await h.cancel(id, "patient");
        await slots("America/New_York");
        const entries: string[] = [];
        for (const prefix of ["slots:", "slots-ver:", "next-available:", "free-map:"]) {
            for (const key of await scan(prefix)) {
                entries.push(key);
                if (key.startsWith("next-available:index")) entries.push(...(await redis.zrange(key, 0, -1, "WITHSCORES")));
                else if (key.startsWith("next-available:refresh")) entries.push(...(await redis.smembers(key)));
                else entries.push((await redis.get(key)) ?? "");
            }
        }
        expect(entries.length).toBeGreaterThan(0);
        const content = JSON.stringify(entries);
        for (const secret of [COMPLAINT, HEADLINE, "Dr Synthetic", "Pat Synthetic"]) expect(content).not.toContain(secret);
        expect(await values()).not.toContain(COMPLAINT);
    });
});
