/**
 * availability search pagination, cursors and the availability window filter (slice S2) — real Postgres and Redis, controllable clock,
 * fake Identity.
 *
 * Rule map: AV-R16 (window defaults, exactness to 15 minutes, every 400), AV-R17 (order, signed cursor kinds, tamper and mismatch,
 * window ordering by overall earliest start), AV-R18 (path B pages the in-memory candidate array), AV-R19 (24:00 ends, DST via luxon in pkg/slots),
 * AV-R20 (a cursor issued while degraded is refused when Redis is back).
 */
import { getEnv } from "../../src/lib/config/env";
import { encodeDiscoveryCursor } from "../../src/app/availability/discovery-cursor";
import { DiscoveryCursorKind } from "../../src/app/availability/enums";
import { useAvailabilityHarness } from "../helpers/availability-harness";
import type { DoctorSeed } from "../helpers/availability-seed";
import { seedDoctor } from "../helpers/availability-seed";
import { expectErrorEnvelope } from "../helpers/contract";
import { ownerDb } from "../helpers/db";

jest.setTimeout(90_000);

interface SearchBody { data: Array<{ userId: number; nextAvailableAt: string | null }>; meta: { nextCursor: string | null; hasMore: boolean; count: number; degraded?: string[] } }

describe("availability search pagination and window filter (integration)", () => {
    const a = useAvailabilityHarness("availability-search-pagination");

    async function doctor(seed: DoctorSeed): Promise<number> {
        const profileId = await seedDoctor(seed);
        a.h.identityServer.users.set(seed.userId, { id: seed.userId, fullName: `Dr Page ${seed.userId}`, avatarUrl: null, status: "active" });
        return profileId;
    }
    const ids = (body: SearchBody): number[] => body.data.map((item) => item.userId);
    async function crawl(params: Record<string, string | number | undefined>, limit: number): Promise<SearchBody[]> {
        const pages: SearchBody[] = [];
        let cursor = params.cursor === undefined ? undefined : String(params.cursor);
        do {
            await a.h.resetRateLimits();
            const response = await a.search({ ...params, limit, cursor });
            expect(response.status).toBe(200);
            const body = response.body as SearchBody;
            expect(body.meta.hasMore).toBe(body.meta.nextCursor !== null);
            expect(body.meta.count).toBe(body.data.length);
            pages.push(body);
            cursor = body.meta.nextCursor ?? undefined;
        } while (cursor !== undefined && pages.length < 30);
        return pages;
    }
    const flat = (pages: SearchBody[]): number[] => pages.flatMap(ids);

    // ── the ladder: seven doctors whose three orders all differ and all contain ties ───────────────────────────────────────
    // profile id:      p1     p2     p3     p4     p5     p6     p7
    const FEES = [300, 100, 300, 200, 100, 300, 200];
    const YEARS = [10, 5, 10, 20, 5, 10, 20];
    const STARTS = ["10:00", "09:00", "10:00", "08:00", "09:00", "10:00", "08:00"];
    const user = (profile: number): number => 2000 + profile;
    const PRICE_ORDER = [2, 5, 4, 7, 1, 3, 6].map(user);
    const EXPERIENCE_ORDER = [7, 4, 6, 3, 1, 5, 2].map(user);
    const EARLIEST_ORDER = [4, 7, 2, 5, 1, 3, 6].map(user);
    const NOW = Date.parse("2026-11-03T05:00:00Z");

    async function seedLadder(): Promise<void> {
        for (let position = 0; position < 7; position += 1) {
            await doctor({ userId: user(position + 1), fee: FEES[position], years: YEARS[position], hours: { start: STARTS[position]!, end: "17:00" } });
        }
        a.h.clock.freeze(NOW);
    }

    describe("page 2 on each sort (AV-R17)", () => {
        beforeEach(seedLadder);

        it("should reach page 2 and order ties by profile id on the default earliest sort with a cold index", async () => {
            const pages = await crawl({}, 3);
            expect(pages.map((page) => page.meta.hasMore)).toEqual([true, true, false]);
            expect(pages.map((page) => page.data.length)).toEqual([3, 3, 1]);
            expect(flat(pages)).toEqual(EARLIEST_ORDER);
            expect(pages[2]!.meta.nextCursor).toBeNull();
            const starts = pages.flatMap((page) => page.data.map((item) => item.nextAvailableAt));
            expect(starts).toEqual(["08:00", "08:00", "09:00", "09:00", "10:00", "10:00", "10:00"].map((time) => `2026-11-03T${time}:00.000Z`));
        });

        it("should return the same earliest pages when the index was swept first", async () => {
            expect(await a.sweep()).toBe("done");
            expect(flat(await crawl({ sort: "earliest_availability" }, 2))).toEqual(EARLIEST_ORDER);
        });

        it("should page price order with ties on a SQL keyset and report hasMore exactly", async () => {
            const pages = await crawl({ sort: "price" }, 2);
            expect(pages.map((page) => page.meta.hasMore)).toEqual([true, true, true, false]);
            expect(flat(pages)).toEqual(PRICE_ORDER);
            expect(pages[0]!.data.map((item) => item.userId)).toEqual(PRICE_ORDER.slice(0, 2));
        });

        it("should page experience order descending with ties on a SQL keyset and report hasMore exactly", async () => {
            const pages = await crawl({ sort: "experience" }, 3);
            expect(pages.map((page) => page.meta.hasMore)).toEqual([true, true, false]);
            expect(flat(pages)).toEqual(EXPERIENCE_ORDER);
        });

        it.each(["earliest_availability", "price", "experience"])("should set hasMore exactly at the limit boundaries when sorting by %s", async (sort) => {
            const expected = ({ earliest_availability: EARLIEST_ORDER, price: PRICE_ORDER, experience: EXPERIENCE_ORDER } as Record<string, number[]>)[sort]!;
            const exact = (await a.search({ sort, limit: 7 })).body as SearchBody;
            expect(ids(exact)).toEqual(expected);
            expect(exact.meta).toMatchObject({ hasMore: false, nextCursor: null, count: 7 });
            const short = (await a.search({ sort, limit: 6 })).body as SearchBody;
            expect(short.meta).toMatchObject({ hasMore: true, count: 6 });
            const rest = (await a.search({ sort, limit: 6, cursor: short.meta.nextCursor! })).body as SearchBody;
            expect(ids(rest)).toEqual(expected.slice(6));
            expect(rest.meta).toMatchObject({ hasMore: false, nextCursor: null, count: 1 });
            const one = await crawl({ sort }, 1);
            expect(one).toHaveLength(7);
            expect(flat(one)).toEqual(expected);
            const wide = (await a.search({ sort, limit: 100 })).body as SearchBody;
            expect(ids(wide)).toEqual(expected);
            expect(wide.meta.hasMore).toBe(false);
        });

        it("should return an empty last page without a cursor when the cursor points past the final row", async () => {
            const secret = getEnv().SERVICE_CLIENT_SECRET;
            const cursor = encodeDiscoveryCursor({ k: DiscoveryCursorKind.Price, v: 999_999, id: 1 }, secret);
            const response = await a.search({ sort: "price", cursor });
            expect(response.status).toBe(200);
            expect(response.body.data).toEqual([]);
            expect(response.body.meta).toMatchObject({ count: 0, hasMore: false, nextCursor: null });
        });

        it("should keep every doctor exactly once when a doctor leaves the candidate set between pages", async () => {
            const first = (await a.search({ sort: "price", limit: 3 })).body as SearchBody;
            await ownerDb("doctor_profiles").where({ user_id: user(1) }).update({ is_accepting_patients: false });
            const rest = flat(await crawl({ sort: "price", cursor: first.meta.nextCursor! }, 3));
            expect([...ids(first), ...rest]).toEqual(PRICE_ORDER.filter((id) => id !== user(1)));
        });
    });

    describe("zero sort values (AV-R17)", () => {
        it("should page free doctors and doctors without experience without losing or repeating a row on every sort", async () => {
            const fees = [0, 0, 5, 0, 5];
            const years = [0, 0, 1, 0, 1];
            for (let position = 0; position < fees.length; position += 1) await doctor({ userId: 2100 + position, fee: fees[position], years: years[position] });
            a.h.clock.freeze(NOW);
            const byPrice = [2100, 2101, 2103, 2102, 2104];
            const byExperience = [2104, 2102, 2103, 2101, 2100];
            expect(flat(await crawl({ sort: "price" }, 1))).toEqual(byPrice);
            expect(flat(await crawl({ sort: "experience" }, 1))).toEqual(byExperience);
            expect(flat(await crawl({ sort: "experience" }, 2))).toEqual(byExperience);
            expect(flat(await crawl({ sort: "earliest_availability" }, 2))).toEqual([2100, 2101, 2102, 2103, 2104]);
            // The same through the in-memory path (a window forces path B).
            const window = { availableFrom: "2026-11-03T09:00:00Z", availableTo: "2026-11-03T09:15:00Z" };
            expect(flat(await crawl({ ...window, sort: "price" }, 2))).toEqual(byPrice);
            expect(flat(await crawl({ ...window, sort: "experience" }, 2))).toEqual(byExperience);
        });
    });

    describe("cursor integrity (AV-R17, AV-R20)", () => {
        beforeEach(seedLadder);

        const cursorFor = async (sort: string): Promise<string> => ((await a.search({ sort, limit: 2 })).body as SearchBody).meta.nextCursor!;
        const refuse = async (params: Record<string, string>, detail?: string): Promise<void> => {
            const response = await a.search({ limit: 2, ...params });
            expect(response.status).toBe(400);
            expectErrorEnvelope(response.body, "ValidationFailed");
            expect(response.body.error.details).toEqual([{ field: "cursor", issue: detail ?? expect.any(String) }]);
        };

        it("should reject a tampered, truncated or foreign cursor with cursor is invalid", async () => {
            const cursor = await cursorFor("price");
            const [body, mac] = cursor.split(".") as [string, string];
            const flipped = `${mac.slice(0, -2)}${mac.endsWith("AA") ? "BB" : "AA"}`;
            const edited = Buffer.from(body, "base64url").toString("utf8").replace(/"id":(\d+)/, '"id":1');
            for (const bad of [`${body}.${flipped}`, `${Buffer.from(edited).toString("base64url")}.${mac}`, body, `${body}.${mac}.x`, "garbage", ".", `.${mac}`, `${body}.`]) {
                await refuse({ sort: "price", cursor: bad }, "is invalid");
            }
        });

        it("should reject a correctly signed cursor whose payload is malformed with cursor is invalid", async () => {
            const secret = getEnv().SERVICE_CLIENT_SECRET;
            const sign = (payload: object): string => encodeDiscoveryCursor(payload as never, secret);
            for (const payload of [{ k: "bogus", v: 1, id: 1 }, { k: "price", v: -1, id: 1 }, { k: "price", v: 1.5, id: 1 }, { k: "price", v: 1, id: 0 }, { k: "price", v: "1", id: 1 },
                { k: "price", v: 1 }, { v: 1, id: 1 }]) {
                await refuse({ sort: "price", cursor: sign(payload) }, "is invalid");
            }
        });

        it("should reject a cursor issued under another sort with does not match the requested sort", async () => {
            const cursors = { earliest_availability: await cursorFor("earliest_availability"), price: await cursorFor("price"), experience: await cursorFor("experience") };
            for (const [issued, cursor] of Object.entries(cursors)) {
                for (const requested of Object.keys(cursors)) {
                    if (issued === requested) continue;
                    await refuse({ sort: requested, cursor }, "does not match the requested sort");
                }
            }
            // The default sort is earliest_availability: a price cursor without ?sort= is refused too.
            await refuse({ cursor: cursors.price }, "does not match the requested sort");
        });

        it("should reject a cursor issued while Redis was down once Redis is back, and the restarted list works", async () => {
            const degraded = await a.withRedisDown(async () => {
                const response = await a.search({ limit: 2 });
                expect(response.status).toBe(200);
                expect(response.body.meta.degraded).toEqual(["sort"]);
                return (response.body as SearchBody).meta.nextCursor!;
            });
            expect(degraded).toEqual(expect.any(String));
            await refuse({ cursor: degraded }, "does not match the requested sort");
            await refuse({ sort: "price", cursor: degraded }, "does not match the requested sort");
            await refuse({ sort: "experience", cursor: degraded }, "does not match the requested sort");
            expect(flat(await crawl({}, 3))).toEqual(EARLIEST_ORDER);
        });

        it("should accept a price cursor issued while Redis was down because the effective order is the same", async () => {
            const cursor = await a.withRedisDown(async () => ((await a.search({ sort: "price", limit: 2 })).body as SearchBody).meta.nextCursor!);
            const response = await a.search({ sort: "price", limit: 2, cursor });
            expect(response.status).toBe(200);
            expect(ids(response.body as SearchBody)).toEqual(PRICE_ORDER.slice(2, 4));
        });
    });

    describe("window filter with pagination (AV-R16, AV-R17)", () => {
        beforeEach(seedLadder);
        // [09:00Z, 09:15Z) on the frozen day: doctors that start at 08:00 (30 min grid: 08:00, 08:30, 09:00) or 09:00 match, the 10:00 starters do not.
        const WINDOW = { availableFrom: "2026-11-03T09:00:00Z", availableTo: "2026-11-03T09:15:00Z" };
        const MATCHED = new Set([4, 7, 2, 5].map(user));

        it.each([
            ["earliest_availability", EARLIEST_ORDER.filter((id) => MATCHED.has(id))],
            ["price", PRICE_ORDER.filter((id) => MATCHED.has(id))],
            ["experience", EXPERIENCE_ORDER.filter((id) => MATCHED.has(id))],
        ])("should page only matching doctors in %s order and set hasMore exactly", async (sort, expected) => {
            const pages = await crawl({ ...WINDOW, sort }, 3);
            expect(pages.map((page) => page.data.length)).toEqual([3, 1]);
            expect(pages.map((page) => page.meta.hasMore)).toEqual([true, false]);
            expect(flat(pages)).toEqual(expected);
            expect(pages.every((page) => page.meta.degraded === undefined)).toBe(true);
            const exact = (await a.search({ ...WINDOW, sort, limit: 4 })).body as SearchBody;
            expect(exact.meta).toMatchObject({ hasMore: false, nextCursor: null, count: 4 });
        });
    });

    describe("window exactness to 15 minutes (AV-R16, AV-R19)", () => {
        const window = (from: string, to: string, extra: Record<string, string | number> = {}) => a.search({ availableFrom: from, availableTo: to, sort: "price", limit: 100, ...extra });
        const matched = async (from: string, to: string): Promise<number[]> => {
            const response = await window(from, to);
            expect(response.status).toBe(200);
            return ids(response.body as SearchBody).sort((x, y) => x - y);
        };

        it("should order a window result by the doctor's overall earliest start and not by the first start inside the window (ADR 0024)", async () => {
            const first = await doctor({ userId: 3801, hours: false });
            const second = await doctor({ userId: 3802, hours: false });
            await ownerDb("working_hours").insert([
                { doctor_profile_id: first, weekday: 2, start_time: "10:00", end_time: "11:00" }, { doctor_profile_id: first, weekday: 3, start_time: "15:00", end_time: "16:00" },
                { doctor_profile_id: second, weekday: 3, start_time: "09:00", end_time: "10:00" }]);
            a.h.clock.freeze(Date.parse("2026-11-03T05:00:00Z")); // Tuesday
            // Inside Wednesday the second doctor starts first (09:00 against 15:00), but the documented order is the overall earliest start (Tuesday 10:00 first).
            const response = await window("2026-11-04T00:00:00Z", "2026-11-05T00:00:00Z", { sort: "earliest_availability" });
            expect(ids(response.body as SearchBody)).toEqual([3801, 3802]);
            expect((response.body as SearchBody).data.map((item) => item.nextAvailableAt)).toEqual(["2026-11-03T10:00:00.000Z", "2026-11-04T09:00:00.000Z"]);
        });

        it("should match on 15-minute buckets in UTC: a start inside a bucket the window overlaps matches, the exclusive end does not", async () => {
            await doctor({ userId: 3001, hours: { start: "09:00", end: "12:00" } });
            a.h.clock.freeze(Date.parse("2026-11-02T00:00:00Z"));
            const day = "2026-11-02";
            expect(await matched(`${day}T09:00:00Z`, `${day}T09:15:00Z`)).toEqual([3001]);
            expect(await matched(`${day}T09:10:00Z`, `${day}T09:20:00Z`)).toEqual([3001]);
            expect(await matched(`${day}T09:14:59Z`, `${day}T09:15:00Z`)).toEqual([3001]);
            expect(await matched(`${day}T08:00:00Z`, `${day}T09:00:00Z`)).toEqual([]);
            expect(await matched(`${day}T08:59:59Z`, `${day}T09:00:00Z`)).toEqual([]);
            expect(await matched(`${day}T09:15:00Z`, `${day}T09:30:00Z`)).toEqual([]);
            expect(await matched(`${day}T09:30:00Z`, `${day}T09:45:00Z`)).toEqual([3001]);
            expect(await matched(`${day}T11:30:00Z`, `${day}T11:45:00Z`)).toEqual([3001]);
            expect(await matched(`${day}T11:45:00Z`, `${day}T12:00:00Z`)).toEqual([]);
        });

        it("should honour a DST change when the window straddles the New York fall-back day", async () => {
            const sunday = 7;
            const saturday = 6;
            await doctor({ userId: 3101, timezone: "America/New_York", hours: { start: "08:00", end: "10:00", weekdays: [sunday] } });
            await doctor({ userId: 3102, timezone: "America/New_York", hours: { start: "08:00", end: "10:00", weekdays: [saturday] } });
            a.h.clock.freeze(Date.parse("2026-10-30T12:00:00Z"));
            // Saturday 2026-10-31 08:00 EDT = 12:00Z; Sunday 2026-11-01 08:00 EST (after the 02:00 EDT fall-back) = 13:00Z, not the 12:00Z a fixed -4 offset would give.
            const all = (await window("2026-10-30T12:00:00Z", "2026-11-02T12:00:00Z")).body as SearchBody;
            expect(Object.fromEntries(all.data.map((item) => [item.userId, item.nextAvailableAt]))).toEqual({ 3101: "2026-11-01T13:00:00.000Z", 3102: "2026-10-31T12:00:00.000Z" });
            expect(await matched("2026-11-01T12:00:00Z", "2026-11-01T13:00:00Z")).toEqual([]);
            expect(await matched("2026-11-01T12:45:00Z", "2026-11-01T13:00:00Z")).toEqual([]);
            expect(await matched("2026-11-01T13:00:00Z", "2026-11-01T13:15:00Z")).toEqual([3101]);
            expect(await matched("2026-11-01T12:50:00Z", "2026-11-01T13:05:00Z")).toEqual([3101]);
            expect(await matched("2026-11-01T14:30:00Z", "2026-11-01T14:45:00Z")).toEqual([3101]);
            expect(await matched("2026-11-01T14:45:00Z", "2026-11-01T15:00:00Z")).toEqual([]);
            expect(await matched("2026-10-31T12:00:00Z", "2026-10-31T12:15:00Z")).toEqual([3102]);
            expect(await matched("2026-10-31T11:45:00Z", "2026-10-31T12:00:00Z")).toEqual([]);
            expect(await matched("2026-10-31T13:30:00Z", "2026-10-31T13:45:00Z")).toEqual([3102]);
        });

        it("should honour the spring-forward day when the doctor's hours span the missing hour", async () => {
            await doctor({ userId: 3201, timezone: "America/New_York", hours: { start: "01:00", end: "04:00", weekdays: [7] } });
            a.h.clock.freeze(Date.parse("2027-03-12T12:00:00Z"));
            // Sunday 2027-03-14: 02:00 EST jumps to 03:00 EDT, so 01:00-04:00 local is two real hours, 06:00Z to 08:00Z: starts 06:00, 06:30, 07:00, 07:30.
            const response = (await window("2027-03-12T12:00:00Z", "2027-03-15T12:00:00Z")).body as SearchBody;
            expect(response.data[0]!.nextAvailableAt).toBe("2027-03-14T06:00:00.000Z");
            expect(await matched("2027-03-14T06:00:00Z", "2027-03-14T06:15:00Z")).toEqual([3201]);
            expect(await matched("2027-03-14T07:30:00Z", "2027-03-14T07:45:00Z")).toEqual([3201]);
            expect(await matched("2027-03-14T07:45:00Z", "2027-03-14T08:00:00Z")).toEqual([]);
            expect(await matched("2027-03-14T05:45:00Z", "2027-03-14T06:00:00Z")).toEqual([]);
        });

        it("should match a doctor that is free today and tomorrow in either window and in neither gap", async () => {
            await doctor({ userId: 3301, hours: { start: "09:00", end: "10:00" } });
            a.h.clock.freeze(Date.parse("2026-11-03T08:00:00Z"));
            expect(await matched("2026-11-03T08:00:00Z", "2026-11-03T12:00:00Z")).toEqual([3301]);
            expect(await matched("2026-11-04T00:00:00Z", "2026-11-04T12:00:00Z")).toEqual([3301]);
            expect(await matched("2026-11-03T09:45:00Z", "2026-11-04T08:59:00Z")).toEqual([]);
            expect(await matched("2026-11-03T10:00:00Z", "2026-11-04T09:00:00Z")).toEqual([]);
            expect(await matched("2026-11-03T10:00:00Z", "2026-11-04T09:15:00Z")).toEqual([3301]);
        });

        it("should match across UTC midnight for a doctor working 22:00 to 24:00 local and stop at the 24:00 end", async () => {
            await doctor({ userId: 3401, timezone: "America/New_York", hours: { start: "22:00", end: "24:00", weekdays: [1] } });
            a.h.clock.freeze(Date.parse("2026-11-09T12:00:00Z"));
            // Monday 22:00 EST = Tuesday 03:00Z; the last 30-minute start is 23:30 local = 04:30Z.
            const first = (await window("2026-11-09T12:00:00Z", "2026-11-11T00:00:00Z")).body as SearchBody;
            expect(first.data[0]!.nextAvailableAt).toBe("2026-11-10T03:00:00.000Z");
            expect(await matched("2026-11-10T03:00:00Z", "2026-11-10T03:15:00Z")).toEqual([3401]);
            expect(await matched("2026-11-10T04:30:00Z", "2026-11-10T04:45:00Z")).toEqual([3401]);
            expect(await matched("2026-11-10T04:45:00Z", "2026-11-10T05:00:00Z")).toEqual([]);
            expect(await matched("2026-11-10T02:45:00Z", "2026-11-10T03:00:00Z")).toEqual([]);
            expect(await matched("2026-11-10T00:00:00Z", "2026-11-10T03:00:00Z")).toEqual([]);
            expect(await matched("2026-11-10T00:00:00Z", "2026-11-10T23:59:00Z")).toEqual([3401]);
            // The next Monday (2026-11-16 local) is also inside the 14 days: 03:00Z on the 17th.
            expect(await matched("2026-11-17T03:00:00Z", "2026-11-17T03:15:00Z")).toEqual([3401]);
        });

        it("should default a missing availableFrom to now when only availableTo is given", async () => {
            await doctor({ userId: 3501, hours: { start: "09:00", end: "10:00" } });
            a.h.clock.freeze(Date.parse("2026-11-03T08:00:00Z"));
            const only = async (availableTo: string): Promise<number[]> => ids((await a.search({ availableTo, sort: "price" })).body as SearchBody);
            expect(await only("2026-11-03T09:15:00Z")).toEqual([3501]);
            expect(await only("2026-11-03T09:00:00Z")).toEqual([]);
            expect(await only("2026-11-03T08:30:00Z")).toEqual([]);
            expect(await only("2026-11-17T08:00:00Z")).toEqual([3501]);
        });

        it("should default a missing availableTo to availableFrom plus 14 days clipped to now plus 14 days when only availableFrom is given", async () => {
            await doctor({ userId: 3601, hours: { start: "09:00", end: "10:00", weekdays: [1] } });
            await doctor({ userId: 3602, hours: { start: "09:00", end: "10:00", weekdays: [2] } });
            a.h.clock.freeze(Date.parse("2026-11-03T08:00:00Z")); // Tuesday
            const only = async (availableFrom: string): Promise<number[]> => ids((await a.search({ availableFrom, sort: "price" })).body as SearchBody).sort();
            expect(await only("2026-11-03T08:00:00Z")).toEqual([3601, 3602]);
            // Monday 2026-11-16 09:00Z is inside [now, now + 14 d); Tuesday 2026-11-17 09:00Z is past the 14-day horizon.
            expect(await only("2026-11-15T00:00:00Z")).toEqual([3601]);
            expect(await only("2026-11-11T00:00:00Z")).toEqual([3601]);
            expect(await only("2026-11-16T10:00:00Z")).toEqual([]);
        });

        it("should accept the exact limits now, now plus 14 days and a 14-day span", async () => {
            await doctor({ userId: 3701, hours: { start: "09:00", end: "10:00" } });
            a.h.clock.freeze(Date.parse("2026-11-03T08:00:00Z"));
            for (const [from, to] of [["2026-11-03T08:00:00Z", "2026-11-17T08:00:00Z"], ["2026-11-03T08:00:00Z", "2026-11-03T08:15:00Z"], ["2026-11-17T07:45:00Z", "2026-11-17T08:00:00Z"]] as const) {
                expect((await window(from, to)).status).toBe(200);
            }
        });

        describe("every 400 of AV-R16", () => {
            beforeEach(() => { a.h.clock.freeze(Date.parse("2026-11-03T08:00:00Z")); });
            const bad = async (params: Record<string, string>, field: string): Promise<void> => {
                const response = await a.search(params);
                expect(response.status).toBe(400);
                expectErrorEnvelope(response.body, "ValidationFailed");
                expect(response.body.error.details[0].field).toBe(field);
            };

            it("should reject a supplied availableFrom in the past or beyond now plus 14 days", async () => {
                await bad({ availableFrom: "2026-11-03T07:59:59Z" }, "availableFrom");
                await bad({ availableFrom: "2026-11-03T07:59:59Z", availableTo: "2026-11-04T08:00:00Z" }, "availableFrom");
                await bad({ availableFrom: "2026-11-17T08:00:01Z" }, "availableFrom");
                await bad({ availableFrom: "2026-11-17T08:00:01Z", availableTo: "2026-11-17T09:00:00Z" }, "availableFrom");
            });

            it("should reject a supplied availableTo in the past or beyond now plus 14 days", async () => {
                await bad({ availableTo: "2026-11-03T07:59:59Z" }, "availableTo");
                await bad({ availableTo: "2026-11-17T08:00:01Z" }, "availableTo");
                await bad({ availableFrom: "2026-11-03T09:00:00Z", availableTo: "2026-11-17T08:00:01Z" }, "availableTo");
            });

            it("should reject an empty or inverted window", async () => {
                await bad({ availableFrom: "2026-11-03T10:00:00Z", availableTo: "2026-11-03T10:00:00Z" }, "availableTo");
                await bad({ availableFrom: "2026-11-03T10:00:00Z", availableTo: "2026-11-03T09:59:59Z" }, "availableTo");
                await bad({ availableTo: "2026-11-03T08:00:00Z" }, "availableTo");
            });

            it("should reject an availableFrom of exactly now plus 14 days because the clipped window is empty", async () => {
                await bad({ availableFrom: "2026-11-17T08:00:00Z" }, "availableFrom");
            });

            it("should reject datetimes without an offset or that are not ISO-8601", async () => {
                await bad({ availableFrom: "2026-11-03T09:00:00" }, "availableFrom");
                await bad({ availableTo: "2026-11-04T09:00:00" }, "availableTo");
                await bad({ availableFrom: "tomorrow" }, "availableFrom");
                await bad({ availableFrom: "2026-13-45T00:00:00Z" }, "availableFrom");
                await bad({ availableTo: "9".repeat(41) }, "availableTo");
            });

            it("should report minFee above maxFee before looking at the window", async () => {
                await bad({ minFee: "5", maxFee: "4", availableFrom: "2026-11-03T08:00:00Z" }, "minFee");
            });
        });
    });
});
