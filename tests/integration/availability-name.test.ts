/**
 * availability name filter and name index (slice S3) — real Postgres, real Redis, controllable clock, real sweep service and name-index builder;
 * only Identity (fake HTTP server, with down and failing modes) and JWKS are fake.
 *
 * Rule map:
 *  - AV-R27 (the `name` filter): prefix on the display name through the index, prefix on the lower-cased headline, the union of both, intersection with
 *    the candidates and the other filters, NFC / case / whitespace normalisation (Latin and Arabic), `meta.degraded:["nameFilter"]` set exactly when the
 *    filter fell back to the headline (index missing or expired, Redis unusable) and never otherwise, `400` below two code points.
 *  - AV-R28 (the rebuild): done by the sweep when `name-index:built-at` is absent or older than AVAILABILITY_NAME_REFRESH_SECONDS, not repeated before,
 *    cache-first on `identity:user:*` in chunks of 100, only Identity-`active` users with a non-blank name, an empty bookable set deletes the index, degraded
 *    hydration keeps the previous build without extending its TTL, and a failed rebuild never fails the rest of the sweep.
 *  - AV-R29 (privacy): fixture display names and avatar URLs never reach a log line, any Postgres text/varchar/json(b) column, or a Redis key other
 *    than `identity:user:*` and `name-index`.
 * Unit coverage of the same code (builder, lex ranges, normalisation, DiscoveryService paths) is in tests/unit; this suite drives it through HTTP.
 */
import { getEnv } from "../../src/lib/config/env";
import { redis } from "../../src/lib/redis/redis";
import { normalizeName } from "../../src/pkg/utils/name";
import { useAvailabilityHarness } from "../helpers/availability-harness";
import type { DoctorSeed } from "../helpers/availability-seed";
import { seedBulkDoctors, seedDoctor, seedSpecialty } from "../helpers/availability-seed";
import { expectErrorEnvelope, expectPaginationMeta } from "../helpers/contract";
import { ownerDb } from "../helpers/db";
import type { FakeIdentityUser } from "../helpers/fake-identity-server";
import { captureLogs } from "../helpers/log-capture";
import { flushByPrefix } from "../helpers/redis";

jest.setTimeout(120_000);

interface Row { userId: number; displayName: string | null; profileHydrated: boolean }
interface SearchBody { data: Row[]; meta: { nextCursor: string | null; hasMore: boolean; count: number; degraded?: string[] } }

const NOW = Date.parse("2026-11-03T05:00:00Z"); // a Tuesday
const REFRESH_MS = getEnv().AVAILABILITY_NAME_REFRESH_SECONDS * 1000;
const SEPARATOR = "\u0000";
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const avatar = (id: number): string => `https://example.test/avatar-${id}.png`;

describe("availability name filter (integration)", () => {
    const a = useAvailabilityHarness("availability-name");

    /** Seeds a bookable doctor and, unless `identity === false`, its Identity account with the given display name. */
    async function doctor(seed: DoctorSeed, fullName: string | false, identity: Partial<FakeIdentityUser> = {}): Promise<number> {
        const profileId = await seedDoctor({ headline: `Synthetic headline ${seed.userId}`, ...seed });
        if (fullName !== false) {
            a.h.identityServer.users.set(seed.userId, { id: seed.userId, fullName, avatarUrl: avatar(seed.userId), status: "active", ...identity });
        }
        return profileId;
    }
    const body = (response: { body: unknown }): SearchBody => response.body as SearchBody;
    /** One search with a fresh rate-limit window; asserts the 200 and returns the parsed body. */
    async function find(params: Record<string, string | number | undefined>): Promise<SearchBody> {
        await a.h.resetRateLimits();
        const response = await a.search({ sort: "price", ...params });
        expect(response.status).toBe(200);
        return body(response);
    }
    const idsOf = (result: SearchBody): number[] => result.data.map((row) => row.userId);
    const sorted = (list: number[]): number[] => [...list].sort((x, y) => x - y);
    /** User ids of every batched Identity call so far, one array per call (a retried chunk appears twice). */
    const batchCalls = (): number[][] => a.h.identityServer.calls.filter((call) => call.path.startsWith("/internal/users?ids="))
        .map((call) => (new URL(call.path, "http://identity.test").searchParams.get("ids") ?? "").split(",").map(Number));
    const indexMembers = (): Promise<string[]> => redis.zrange("name-index", 0, -1);
    const indexedUserIds = async (): Promise<number[]> => sorted((await indexMembers()).map((member) => Number(member.slice(member.lastIndexOf(SEPARATOR) + 1))));
    const builtAt = (): Promise<string | null> => redis.get("name-index:built-at");
    const sweptAt = (): Promise<string | null> => redis.get("next-available:swept-at");
    /** Moves the controllable clock `ms` past the start and runs one sweep tick, which rebuilds the index when due. */
    async function sweepAt(offsetMs: number): Promise<void> {
        a.h.clock.freeze(NOW + offsetMs);
        expect(await a.sweep()).toBe("done");
    }
    beforeEach(() => { a.h.clock.freeze(NOW); });

    describe("index-backed match after a sweep tick (AV-R27, AV-R28)", () => {
        it("should match the display name prefix through the index and omit meta.degraded when the sweep built it", async () => {
            await doctor({ userId: 6001 }, "Dr Synthetic Amal Hassan");
            await doctor({ userId: 6002 }, "Dr Synthetic Basma Nour");
            await doctor({ userId: 6003 }, "Dr Synthetic Amir Saad");
            expect(await a.sweep()).toBe("done");

            const result = await find({ name: "dr synthetic am" });
            expect(sorted(idsOf(result))).toEqual([6001, 6003]);
            expect(result.meta).not.toHaveProperty("degraded");
            expectPaginationMeta(result.meta);
            expect(idsOf(await find({ name: "Dr Synthetic Amal Hassan" }))).toEqual([6001]);
            expect(idsOf(await find({ name: "Dr Synthetic Basma Nour extra" }))).toEqual([]);

            // The index itself: one `<normalised name>\0<userId>` member per doctor, a 900 s TTL at most, stamped with the build time.
            expect(await indexMembers()).toEqual(["dr synthetic amal hassan\u00006001", "dr synthetic amir saad\u00006003", "dr synthetic basma nour\u00006002"]);
            const ttl = await redis.ttl("name-index");
            expect(ttl).toBeGreaterThan(0);
            expect(ttl).toBeLessThanOrEqual(900);
            expect(await builtAt()).toBe(String(NOW));
        });

        it("should match case-insensitively and with whitespace runs collapsed on both the stored name and the query", async () => {
            await doctor({ userId: 6010 }, "  Dr  Synthetic\tAmal   HASSAN ");
            await doctor({ userId: 6011 }, "Dr Synthetic Basma");
            expect(await a.sweep()).toBe("done");
            for (const name of ["DR SYNTHETIC AMAL", "dr    synthetic   amal  hassan", "  Dr Synthetic Amal  ", "Dr Synthetic Amal"]) {
                const result = await find({ name });
                expect(idsOf(result)).toEqual([6010]);
                expect(result.meta).not.toHaveProperty("degraded");
            }
        });

        it("should match Arabic display names by prefix, normalised to NFC on both sides, without reporting nameFilter", async () => {
            // Stored with a decomposed alef + hamza above (U+0627 U+0654); the query uses the composed U+0623: equal only after NFC.
            await doctor({ userId: 6020 }, "الدكتور أمل حسن");
            await doctor({ userId: 6021 }, "الدكتور سامي علي");
            await doctor({ userId: 6022 }, "سامر يوسف");
            // Latin: stored decomposed (e + U+0301), queried composed, and the other way round.
            await doctor({ userId: 6023 }, "Dr Synthetic René Fixture");
            await doctor({ userId: 6024 }, "Dr Synthetic Zoë Fixture");
            expect(await a.sweep()).toBe("done");

            const expectOnly = async (name: string, expected: number[]): Promise<void> => {
                const result = await find({ name });
                expect({ name, ids: sorted(idsOf(result)) }).toEqual({ name, ids: expected });
                expect(result.meta).not.toHaveProperty("degraded");
            };
            await expectOnly("الدكتور", [6020, 6021]);
            await expectOnly("  الدكتور    أمل ", [6020]);
            await expectOnly("الدكتور سا", [6021]);
            await expectOnly("سام", [6022]);
            await expectOnly("سامي", []);
            await expectOnly("dr synthetic rené", [6023]);
            await expectOnly("DR SYNTHETIC RENÉ", [6023]);
            await expectOnly("dr synthetic zoë", [6024]);
            await expectOnly("dr synthetic zoë", [6024]);
            await expectOnly("dr synthetic zoe", []);
        });

        it("should match a headline prefix even though the display name does not match, and not report nameFilter while the index serves", async () => {
            await doctor({ userId: 6030, headline: "Zeta clinic for synthetic cases" }, "Dr Synthetic Ayman Taha");
            await doctor({ userId: 6031, headline: "Dermatology synthetic" }, "Dr Synthetic Basma Nour");
            expect(await a.sweep()).toBe("done");
            const result = await find({ name: "zeta clinic" });
            expect(idsOf(result)).toEqual([6030]);
            expect(result.meta).not.toHaveProperty("degraded");
            // A word inside the headline is not a prefix.
            expect(idsOf(await find({ name: "synthetic cases" }))).toEqual([]);
        });

        it("should return the union of headline and display-name matches, each doctor once, when both match", async () => {
            await doctor({ userId: 6040, headline: "Zeta clinic" }, "Dr Synthetic Ayman Taha");
            await doctor({ userId: 6041, headline: "Dermatology" }, "Zeta Synthetic Person");
            await doctor({ userId: 6042, headline: "Zeta both" }, "Zeta Synthetic Both");
            await doctor({ userId: 6043, headline: "Dermatology" }, "Dr Synthetic Unrelated");
            expect(await a.sweep()).toBe("done");
            const result = await find({ name: "zeta" });
            expect(sorted(idsOf(result))).toEqual([6040, 6041, 6042]);
            expect(result.meta.count).toBe(3);
            expect(result.meta).not.toHaveProperty("degraded");
        });

        it("should answer an empty 200 without meta.degraded when the index serves and nothing matches", async () => {
            await doctor({ userId: 6050 }, "Dr Synthetic Amal Hassan");
            expect(await a.sweep()).toBe("done");
            const result = await find({ name: "qq" });
            expect(result.data).toEqual([]);
            expect(result.meta).toMatchObject({ hasMore: false, nextCursor: null, count: 0 });
            expect(result.meta).not.toHaveProperty("degraded");
        });
    });

    describe("intersection with the candidates (AV-R14, AV-R15, AV-R27)", () => {
        it("should never return a doctor who stopped being bookable after the build, although the index still holds the name", async () => {
            const states: Array<[number, Record<string, unknown>]> = [
                [6101, { suspended_at: new Date(), suspension_reason: "Synthetic suspension" }], [6102, { is_accepting_patients: false }],
                [6103, { verification_status: "submitted" }], [6104, { identity_sync_status: "pending" }], [6105, { deleted_at: new Date() }],
            ];
            await doctor({ userId: 6100 }, "Dr Synthetic Match Active");
            for (const [userId] of states) await doctor({ userId }, `Dr Synthetic Match State ${userId}`);
            await doctor({ userId: 6106 }, "Dr Synthetic Match NoType");
            expect(await a.sweep()).toBe("done");
            expect(await indexedUserIds()).toEqual([6100, 6101, 6102, 6103, 6104, 6105, 6106]);
            expect(sorted(idsOf(await find({ name: "dr synthetic match" })))).toEqual([6100, 6101, 6102, 6103, 6104, 6105, 6106]);

            for (const [userId, change] of states) await ownerDb("doctor_profiles").where({ user_id: userId }).update(change);
            await ownerDb("consultation_types").whereIn("doctor_profile_id", ownerDb("doctor_profiles").select("id").where({ user_id: 6106 })).update({ is_active: false });
            const result = await find({ name: "dr synthetic match" });
            expect(idsOf(result)).toEqual([6100]);
            expect(result.meta).not.toHaveProperty("degraded");
            expect(idsOf(await find({ name: "dr synthetic match state 6101" }))).toEqual([]);
            expect(idsOf(await find({ name: "dr synthetic match notype" }))).toEqual([]);
        });

        it("should not index a doctor who is not bookable when the index is built, and so never match them by name", async () => {
            await doctor({ userId: 6110 }, "Dr Synthetic Build Active");
            await doctor({ userId: 6111, suspended: true }, "Dr Synthetic Build Suspended");
            await doctor({ userId: 6112, accepting: false }, "Dr Synthetic Build Closed");
            await doctor({ userId: 6113, verification: "submitted" }, "Dr Synthetic Build Submitted");
            await doctor({ userId: 6114, sync: "pending" }, "Dr Synthetic Build Pending");
            await doctor({ userId: 6115, deleted: true }, "Dr Synthetic Build Deleted");
            await doctor({ userId: 6116, types: [{ minutes: 30, active: false }] }, "Dr Synthetic Build NoType");
            expect(await a.sweep()).toBe("done");
            expect(await indexedUserIds()).toEqual([6110]);
            expect(idsOf(await find({ name: "dr synthetic build" }))).toEqual([6110]);
        });

        it("should combine the name with specialty, language and fee filters as an intersection", async () => {
            const cardiology = await seedSpecialty("name-cardiology", "Synthetic cardiology");
            const dermatology = await seedSpecialty("name-dermatology", "Synthetic dermatology");
            await doctor({ userId: 6120, fee: 100, specialtyIds: [cardiology], languages: ["ar"] }, "Dr Synthetic Combo One");
            await doctor({ userId: 6121, fee: 200, specialtyIds: [cardiology], languages: ["en"] }, "Dr Synthetic Combo Two");
            await doctor({ userId: 6122, fee: 300, specialtyIds: [dermatology], languages: ["ar", "en"] }, "Dr Synthetic Combo Three");
            await doctor({ userId: 6123, fee: 150, specialtyIds: [cardiology], languages: ["ar"] }, "Dr Synthetic Other Four");
            expect(await a.sweep()).toBe("done");
            const combos: Array<[Record<string, string | number>, number[]]> = [
                [{}, [6120, 6121, 6122]],
                [{ specialty: "name-cardiology" }, [6120, 6121]],
                [{ specialty: "name-dermatology" }, [6122]],
                [{ language: "ar" }, [6120, 6122]],
                [{ language: "en", specialty: "name-cardiology" }, [6121]],
                [{ minFee: 150 }, [6121, 6122]],
                [{ maxFee: 200 }, [6120, 6121]],
                [{ minFee: 200, maxFee: 200 }, [6121]],
                [{ specialty: "name-cardiology", language: "ar", minFee: 100, maxFee: 120 }, [6120]],
                [{ specialty: "name-dermatology", maxFee: 250 }, []],
                [{ specialty: "name-unknown" }, []],
            ];
            for (const [filters, expected] of combos) {
                const result = await find({ name: "dr synthetic combo", ...filters });
                expect({ filters, ids: sorted(idsOf(result)) }).toEqual({ filters, ids: expected });
                expect(result.meta).not.toHaveProperty("degraded");
            }
        });
    });

    describe("who is indexed (AV-R28)", () => {
        it("should index only Identity-active users that have a non-blank name", async () => {
            await doctor({ userId: 6201 }, "Dr Synthetic Index Active");
            await doctor({ userId: 6202 }, "Dr Synthetic Index Suspended", { status: "suspended" });
            await doctor({ userId: 6203 }, "Dr Synthetic Index Pending", { status: "pending" });
            await doctor({ userId: 6204 }, "Dr Synthetic Index Rejected", { status: "rejected" });
            await doctor({ userId: 6205 }, " \t   ");
            await doctor({ userId: 6206 }, false); // no Identity account at all
            expect(await a.sweep()).toBe("done");
            expect(await indexMembers()).toEqual(["dr synthetic index active\u00006201"]);
            expect(idsOf(await find({ name: "dr synthetic index" }))).toEqual([6201]);
            const result = await find({ name: "dr synthetic index suspended" });
            expect(result.data).toEqual([]);
            expect(result.meta).not.toHaveProperty("degraded");
        });

        it("should delete the index and fall back to headlines when the bookable set becomes empty", async () => {
            await doctor({ userId: 6210, headline: "Zeta clinic" }, "Dr Synthetic Empty One");
            await doctor({ userId: 6211 }, "Dr Synthetic Empty Two");
            expect(await a.sweep()).toBe("done");
            expect(await redis.exists("name-index")).toBe(1);
            await ownerDb("doctor_profiles").update({ is_accepting_patients: false });
            await sweepAt(REFRESH_MS + 1000);
            expect(await redis.exists("name-index")).toBe(0);
            expect(await builtAt()).toBe(String(NOW + REFRESH_MS + 1000));
            // The doctors are back, the index is still gone until the next due rebuild: headline-only and honest about it.
            await ownerDb("doctor_profiles").update({ is_accepting_patients: true });
            const result = await find({ name: "zeta" });
            expect(idsOf(result)).toEqual([6210]);
            expect(result.meta.degraded).toEqual(["nameFilter"]);
            expect(idsOf(await find({ name: "dr synthetic empty" }))).toEqual([]);
            await sweepAt(2 * (REFRESH_MS + 1000));
            expect(sorted(idsOf(await find({ name: "dr synthetic empty" })))).toEqual([6210, 6211]);
        });
    });

    describe("rebuild cadence and Identity usage (AV-R28)", () => {
        it("should build with one batched Identity call, then reuse identity:user:* with no call on the next due rebuild", async () => {
            for (const userId of [6301, 6302, 6303]) await doctor({ userId }, `Dr Synthetic Cache ${userId}`);
            expect(await a.sweep()).toBe("done");
            const first = batchCalls();
            expect(first).toHaveLength(1);
            expect(sorted(first[0] ?? [])).toEqual([6301, 6302, 6303]);
            expect(await redis.ttl("identity:user:6301")).toBeGreaterThan(0);

            await sweepAt(REFRESH_MS + 1000);
            expect(await builtAt()).toBe(String(NOW + REFRESH_MS + 1000));
            expect(batchCalls()).toHaveLength(1);
            expect(await indexedUserIds()).toEqual([6301, 6302, 6303]);

            // Only the missing entries are asked for once the cache has lost some.
            await redis.del("identity:user:6302");
            await sweepAt(2 * (REFRESH_MS + 1000));
            const third = batchCalls();
            expect(third).toHaveLength(2);
            expect(third[1]).toEqual([6302]);
        });

        it("should not rebuild before the refresh interval has passed and rebuild once it has", async () => {
            for (const userId of [6310, 6311]) await doctor({ userId }, `Dr Synthetic Cadence ${userId}`);
            expect(await a.sweep()).toBe("done");
            expect(batchCalls()).toHaveLength(1);
            // With the Identity cache gone a rebuild would have to call Identity: the count proves whether one ran.
            await flushByPrefix(["identity:"]);
            expect(await a.sweep()).toBe("done");
            await sweepAt(REFRESH_MS - 1000);
            expect(batchCalls()).toHaveLength(1);
            expect(await builtAt()).toBe(String(NOW));
            await sweepAt(REFRESH_MS + 1000);
            expect(batchCalls()).toHaveLength(2);
            expect(await builtAt()).toBe(String(NOW + REFRESH_MS + 1000));
        });

        it("should rebuild at once when name-index:built-at is absent even though the previous sweep was recent", async () => {
            await doctor({ userId: 6320 }, "Dr Synthetic Absent One");
            expect(await a.sweep()).toBe("done");
            await redis.del("name-index:built-at");
            await flushByPrefix(["identity:"]);
            await doctor({ userId: 6321 }, "Dr Synthetic Absent Two");
            expect(await a.sweep()).toBe("done");
            expect(batchCalls()).toHaveLength(2);
            expect(await indexedUserIds()).toEqual([6320, 6321]);
        });

        it("should hydrate in chunks of at most 100 ids and index every bookable doctor when more than 100 exist", async () => {
            await seedBulkDoctors({ count: 120, firstUserId: 7000, bookableEvery: 1, withHours: false });
            for (let i = 0; i < 120; i += 1) {
                a.h.identityServer.users.set(7000 + i, { id: 7000 + i, fullName: `Dr Synthetic Bulk ${7000 + i}`, avatarUrl: null, status: "active" });
            }
            expect(await a.sweep()).toBe("done");
            const calls = batchCalls();
            expect(calls.map((call) => call.length)).toEqual([100, 20]);
            expect(sorted(calls.flat())).toEqual(Array.from({ length: 120 }, (_, i) => 7000 + i));
            expect(await redis.zcard("name-index")).toBe(120);
            expect(idsOf(await find({ name: "dr synthetic bulk 7119" }))).toEqual([7119]);
            expect(sorted(idsOf(await find({ name: "dr synthetic bulk 700", limit: 100 })))).toEqual(Array.from({ length: 10 }, (_, i) => 7000 + i));
        });

        it("should keep matching the old name until the next due rebuild and match the new one only after it", async () => {
            await doctor({ userId: 6330 }, "Dr Synthetic Rename Before");
            await doctor({ userId: 6331 }, "Dr Synthetic Rename Stable");
            expect(await a.sweep()).toBe("done");
            expect(idsOf(await find({ name: "dr synthetic rename before" }))).toEqual([6330]);

            // Identity renames the doctor and its own cached copy has expired (simulated), but the index is not due yet.
            a.h.identityServer.users.set(6330, { id: 6330, fullName: "Dr Synthetic Rename After", avatarUrl: avatar(6330), status: "active" });
            await redis.del("identity:user:6330");
            const callsBefore = batchCalls().length;
            expect(await a.sweep()).toBe("done");
            expect(batchCalls()).toHaveLength(callsBefore);
            expect(idsOf(await find({ name: "dr synthetic rename before" }))).toEqual([6330]);
            expect(idsOf(await find({ name: "dr synthetic rename after" }))).toEqual([]);

            await redis.del("identity:user:6330");
            await sweepAt(REFRESH_MS + 1000);
            expect(idsOf(await find({ name: "dr synthetic rename after" }))).toEqual([6330]);
            expect(idsOf(await find({ name: "dr synthetic rename before" }))).toEqual([]);
            expect(sorted(idsOf(await find({ name: "dr synthetic rename" })))).toEqual([6330, 6331]);
            expect((await find({ name: "dr synthetic rename after" })).meta).not.toHaveProperty("degraded");
        });
    });

    describe("Identity down during a rebuild (AV-R28, AV-R27)", () => {
        beforeEach(async () => {
            await doctor({ userId: 6401, headline: "Zeta clinic" }, "Dr Synthetic Outage One");
            await doctor({ userId: 6402 }, "Dr Synthetic Outage Two");
            expect(await a.sweep()).toBe("done");
        });

        it("should keep serving the previous build without extending its TTL, then fall back to headlines once that TTL has expired", async () => {
            const ttlBefore = await redis.pttl("name-index");
            const builtBefore = await builtAt();
            const membersBefore = await indexMembers();
            expect(ttlBefore).toBeGreaterThan(0);
            await flushByPrefix(["identity:"]);
            a.h.identityServer.options.down = true;

            const capture = captureLogs();
            try { await sweepAt(REFRESH_MS + 1000); } finally { capture.restore(); }
            expect(capture.lines().some((line) => line.message === "availability_name_index_stale")).toBe(true);
            expect(capture.lines().some((line) => line.message === "availability_name_index_built")).toBe(false);
            expect(batchCalls().length).toBeGreaterThan(1);
            // The last good build is untouched: same members, same stamp, a TTL that only went down.
            expect(await indexMembers()).toEqual(membersBefore);
            expect(await builtAt()).toBe(builtBefore);
            const ttlAfter = await redis.pttl("name-index");
            expect(ttlAfter).toBeGreaterThan(0);
            expect(ttlAfter).toBeLessThanOrEqual(ttlBefore);
            expect(sorted(await indexedUserIds())).toEqual([6401, 6402]);

            // Still served from that build while Identity is down: the old index answers and the response is not degraded.
            const served = await find({ name: "dr synthetic outage two" });
            expect(idsOf(served)).toEqual([6402]);
            expect(served.meta).not.toHaveProperty("degraded");
            expect(served.data[0]).toMatchObject({ displayName: null, profileHydrated: false });

            // Its 900 s TTL elapses (simulated): the filter is headline-only and says so.
            await redis.pexpire("name-index", 1);
            await redis.pexpire("name-index:built-at", 1);
            await delay(30);
            expect(await redis.exists("name-index")).toBe(0);
            const fallback = await find({ name: "dr synthetic outage two" });
            expect(fallback.data).toEqual([]);
            expect(fallback.meta.degraded).toEqual(["nameFilter"]);
            const headline = await find({ name: "zeta" });
            expect(idsOf(headline)).toEqual([6401]);
            expect(headline.meta.degraded).toEqual(["nameFilter"]);
            // Redis itself is fine, so the default earliest-availability sort is not degraded: only the name filter is reported.
            expect((await a.search({ name: "dr synthetic outage two" })).body.meta.degraded).toEqual(["nameFilter"]);

            // Built-at is gone too, so every sweep retries; while Identity stays down nothing is built, and once it is back the index returns.
            await sweepAt(REFRESH_MS + 2000);
            expect(await redis.exists("name-index")).toBe(0);
            a.h.identityServer.options.down = false;
            await sweepAt(REFRESH_MS + 3000);
            const recovered = await find({ name: "dr synthetic outage two" });
            expect(idsOf(recovered)).toEqual([6402]);
            expect(recovered.meta).not.toHaveProperty("degraded");
        });

        it("should keep the previous complete build when only a later chunk of the hydration fails, never a partial index", async () => {
            await seedBulkDoctors({ count: 110, firstUserId: 7500, bookableEvery: 1, withHours: false });
            for (let i = 0; i < 110; i += 1) {
                a.h.identityServer.users.set(7500 + i, { id: 7500 + i, fullName: `Dr Synthetic Chunk ${7500 + i}`, avatarUrl: null, status: "active" });
            }
            await sweepAt(REFRESH_MS + 1000);
            expect(await redis.zcard("name-index")).toBe(112);
            // The second chunk (the 10 highest ids) loses its cache entries and Identity dies: chunk one is served from cache, chunk two fails.
            await redis.del(...Array.from({ length: 10 }, (_, i) => `identity:user:${7600 + i}`));
            a.h.identityServer.options.down = true;
            const membersBefore = await indexMembers();
            await sweepAt(2 * (REFRESH_MS + 1000));
            expect(await indexMembers()).toEqual(membersBefore);
            expect(await builtAt()).toBe(String(NOW + REFRESH_MS + 1000));
            expect(idsOf(await find({ name: "dr synthetic chunk 7609" }))).toEqual([7609]);
        });
    });

    describe("a failing rebuild inside the sweep (AV-R28)", () => {
        it("should finish the sweep, index every doctor and stamp swept-at when Identity answers 500 to the name rebuild", async () => {
            for (const userId of [6501, 6502, 6503]) await doctor({ userId }, `Dr Synthetic Failing ${userId}`);
            a.h.identityServer.options.batchFailures = 99;
            expect(await a.sweep()).toBe("done");
            expect(batchCalls().length).toBeGreaterThanOrEqual(1);
            expect(await sweptAt()).toBe(String(NOW));
            expect([...(await a.indexScores()).keys()].sort()).toEqual([6501, 6502, 6503]);
            expect(await redis.exists("name-index")).toBe(0);
            expect(await builtAt()).toBeNull();
            // The failed build is not remembered: the next sweep with a healthy Identity builds it.
            a.h.identityServer.options.batchFailures = 0;
            expect(await a.sweep()).toBe("done");
            expect(await indexedUserIds()).toEqual([6501, 6502, 6503]);
            expect(await builtAt()).toBe(String(NOW));
        });
    });

    describe("Redis unusable (AV-R27, AV-R20)", () => {
        it("should answer 200 with headline matches only and meta.degraded nameFilter when Redis is down although an index exists", async () => {
            await doctor({ userId: 6601, headline: "Zeta clinic" }, "Dr Synthetic Redis One");
            await doctor({ userId: 6602 }, "Zeta Synthetic Redis Two");
            expect(await a.sweep()).toBe("done");
            expect(sorted(idsOf(await find({ name: "zeta" })))).toEqual([6601, 6602]);

            await a.withRedisDown(async () => {
                await a.h.resetRateLimits();
                const priced = await a.search({ name: "zeta", sort: "price" });
                expect(priced.status).toBe(200);
                expect(idsOf(body(priced))).toEqual([6601]);
                expect(body(priced).meta.degraded).toEqual(["nameFilter"]);
                await a.h.resetRateLimits();
                const named = await a.search({ name: "dr synthetic redis one", sort: "price" });
                expect(named.status).toBe(200);
                expect(body(named).data).toEqual([]);
                expect(body(named).meta.degraded).toEqual(["nameFilter"]);
                await a.h.resetRateLimits();
                const dflt = await a.search({ name: "zeta" });
                expect(dflt.status).toBe(200);
                expect(body(dflt).meta.degraded).toEqual(["sort", "nameFilter"]);
            });
            // Redis is back and the untouched index serves again.
            expect(sorted(idsOf(await find({ name: "zeta" })))).toEqual([6601, 6602]);
        });
    });

    describe("pagination with a name filter (AV-R17, AV-R27)", () => {
        beforeEach(async () => {
            for (let i = 1; i <= 5; i += 1) await doctor({ userId: 6700 + i, fee: 100 * i }, `Dr Synthetic Page Ahmed ${i}`);
            await doctor({ userId: 6710, fee: 250 }, "Dr Synthetic Other Decoy");
            expect(await a.sweep()).toBe("done");
        });

        it("should page the index matches on the price sort with a cursor valid across pages and exact hasMore boundaries", async () => {
            const page1 = await find({ name: "dr synthetic page", limit: 2 });
            expect(idsOf(page1)).toEqual([6701, 6702]);
            expect(page1.meta).toMatchObject({ hasMore: true, count: 2 });
            expect(typeof page1.meta.nextCursor).toBe("string");
            const page2 = await find({ name: "dr synthetic page", limit: 2, cursor: page1.meta.nextCursor ?? undefined });
            expect(idsOf(page2)).toEqual([6703, 6704]);
            expect(page2.meta).toMatchObject({ hasMore: true, count: 2 });
            const page3 = await find({ name: "dr synthetic page", limit: 2, cursor: page2.meta.nextCursor ?? undefined });
            expect(idsOf(page3)).toEqual([6705]);
            expect(page3.meta).toMatchObject({ hasMore: false, nextCursor: null, count: 1 });
            for (const page of [page1, page2, page3]) expect(page.meta).not.toHaveProperty("degraded");

            const exact = await find({ name: "dr synthetic page", limit: 5 });
            expect(idsOf(exact)).toEqual([6701, 6702, 6703, 6704, 6705]);
            expect(exact.meta).toMatchObject({ hasMore: false, nextCursor: null });
            const four = await find({ name: "dr synthetic page", limit: 4 });
            expect(four.meta.hasMore).toBe(true);
            expect(idsOf(await find({ name: "dr synthetic page", limit: 4, cursor: four.meta.nextCursor ?? undefined }))).toEqual([6705]);
        });

        it("should page the index matches on the default earliest-availability sort, reaching page 2 and page 3 without repeats", async () => {
            const seen: number[] = [];
            let cursor: string | undefined;
            const sizes: number[] = [];
            do {
                await a.h.resetRateLimits();
                const response = await a.search({ name: "dr synthetic page", limit: 2, cursor });
                expect(response.status).toBe(200);
                const page = body(response);
                expect(page.meta).not.toHaveProperty("degraded");
                seen.push(...idsOf(page));
                sizes.push(page.data.length);
                cursor = page.meta.nextCursor ?? undefined;
            } while (cursor !== undefined && sizes.length < 6);
            expect(sizes).toEqual([2, 2, 1]);
            expect(sorted(seen)).toEqual([6701, 6702, 6703, 6704, 6705]);
            expect(new Set(seen).size).toBe(5);
        });
    });

    describe("validation (AV-R27)", () => {
        it("should answer 400 on name when fewer than two code points remain after normalisation or a control character is present", async () => {
            await doctor({ userId: 6801 }, "Dr Synthetic Valid One");
            expect(await a.sweep()).toBe("done");
            const raw = ["a", "%20a%20", "%20%20", "%F0%9F%98%80", "e%CC%81", "%D8%B3", "ab%07", "ab%00cd", "ab%0Acd", "x".repeat(101)];
            for (const name of raw) {
                await a.h.resetRateLimits();
                const response = await a.get(`/api/doctors?name=${name}`);
                expect({ name, status: response.status }).toEqual({ name, status: 400 });
                expectErrorEnvelope(response.body, "ValidationFailed");
            }
            // Two code points are enough, whatever their UTF-16 length.
            for (const name of ["%F0%9F%98%80%F0%9F%98%80", "%D8%B3%D8%A7", "dr"]) {
                await a.h.resetRateLimits();
                const response = await a.get(`/api/doctors?name=${name}`);
                expect({ name, status: response.status }).toEqual({ name, status: 200 });
            }
        });

        it("should name the field in the error details when the normalised name is too short", async () => {
            await a.h.resetRateLimits();
            const response = await a.get("/api/doctors?name=e%CC%81");
            expect(response.status).toBe(400);
            expect(response.body.error.details).toEqual(expect.arrayContaining([expect.objectContaining({ field: "name" })]));
        });
    });

    describe("privacy of names (AV-R29)", () => {
        const NAMES = ["Dr Synthetic Privacy Latin", "الدكتور خصوصية اختبار", "Zeta Synthetic Privacy Third"];
        const SECRETS = [...NAMES, ...NAMES.map(normalizeName), avatar(6901), avatar(6902), avatar(6903), "avatar-6901", "avatar-6902", "avatar-6903"];

        async function seedAndExercise(): Promise<void> {
            await doctor({ userId: 6901, headline: "Synthetic scan control headline" }, NAMES[0] ?? "");
            await doctor({ userId: 6902 }, NAMES[1] ?? "");
            await doctor({ userId: 6903 }, NAMES[2] ?? "");
            expect(await a.sweep()).toBe("done");
            // Index-served searches, a profile view, a rename and a second rebuild, an Identity outage, a failing rebuild, Redis down and a degraded page.
            expect(idsOf(await find({ name: "dr synthetic privacy" }))).toEqual([6901]);
            expect(idsOf(await find({ name: "الدكتور خصوصية" }))).toEqual([6902]);
            await a.h.resetRateLimits();
            expect((await a.profile(6901)).status).toBe(200);
            await a.h.resetRateLimits();
            expect((await a.profile(6902, "admin")).status).toBe(200);
            a.h.identityServer.users.set(6903, { id: 6903, fullName: "Zeta Synthetic Privacy Renamed", avatarUrl: avatar(6903), status: "active" });
            await redis.del("identity:user:6903");
            await sweepAt(REFRESH_MS + 1000);
            expect(idsOf(await find({ name: "zeta synthetic privacy renamed" }))).toEqual([6903]);
            await flushByPrefix(["identity:"]);
            a.h.identityServer.options.down = true;
            await sweepAt(2 * (REFRESH_MS + 1000));
            expect((await a.search({ name: "dr synthetic privacy" })).status).toBe(200);
            a.h.identityServer.options.down = false;
            await a.withRedisDown(async () => {
                await a.h.resetRateLimits();
                expect((await a.search({ name: "dr synthetic privacy", sort: "price" })).status).toBe(200);
            });
            a.h.identityServer.options.batchFailures = 99;
            await redis.del("name-index:built-at");
            await sweepAt(3 * (REFRESH_MS + 1000));
            a.h.identityServer.options.batchFailures = 0;
            // Healthy again: pages hydrate and refill identity:user:*, the one Redis home (besides the index) that holds names.
            expect(idsOf(await find({ name: "الدكتور خصوصية" }))).toEqual([6902]);
        }

        it("should write no display name, avatar URL or name query to the logs across builds, searches, outages and failed rebuilds", async () => {
            const capture = captureLogs();
            try { await seedAndExercise(); } finally { capture.restore(); }
            const text = capture.text();
            const messages = new Set(capture.lines().map((line) => String(line.message)));
            // Non-vacuous: the name-index lifecycle itself logged (counts only), as did the requests.
            expect(messages.has("availability_name_index_built")).toBe(true);
            expect(messages.has("availability_name_index_stale")).toBe(true);
            expect(messages.has("request_completed")).toBe(true);
            for (const secret of [...SECRETS, "Zeta Synthetic Privacy Renamed", "zeta synthetic privacy renamed", "dr synthetic privacy", "الدكتور خصوصية"]) {
                expect({ secret, leaked: text.includes(secret) }).toEqual({ secret, leaked: false });
            }
        });

        it("should keep every fixture display name out of Postgres and out of Redis except identity:user:* and the name-index", async () => {
            await seedAndExercise();
            const needles = [...NAMES, "Zeta Synthetic Privacy Renamed"].flatMap((name) => [name, normalizeName(name)]);

            // Controls: the scans do find a string that is stored (the headline), and the two permitted Redis homes do hold names.
            const [tables, controlHits] = await scanPostgres(["Synthetic scan control headline"]);
            expect(tables).toBeGreaterThan(10);
            expect(controlHits).toContain("doctor_profiles.headline");
            expect((await indexMembers()).join("\n")).toContain(normalizeName("Zeta Synthetic Privacy Renamed"));
            expect(await redis.get("identity:user:6902")).toContain(NAMES[1]);

            const [, postgresHits] = await scanPostgres(needles);
            expect(postgresHits).toEqual([]);
            expect(await scanRedisOutsideNameHomes(needles)).toEqual([]);
        });
    });
});

/** Every text-like column of every base table in `public` (varchar, text, char, json, jsonb and arrays of text) searched for each needle, case-insensitively. */
async function scanPostgres(needles: string[]): Promise<[number, string[]]> {
    const columns = await ownerDb.raw<{ rows: Array<{ table: string; column: string }> }>(`
        SELECT c.table_name AS "table", c.column_name AS "column"
        FROM information_schema.columns c
        JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
        WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE'
          AND (c.data_type IN ('text', 'character varying', 'character', 'json', 'jsonb') OR c.udt_name IN ('_text', '_varchar'))
        ORDER BY 1, 2`);
    const hits: string[] = [];
    for (const { table, column } of columns.rows) {
        const condition = needles.map(() => "strpos(lower(??::text), lower(?)) > 0").join(" OR ");
        const bindings = needles.flatMap((needle) => [column, needle]);
        const found = await ownerDb.raw<{ rows: unknown[] }>(`SELECT 1 AS hit FROM ?? WHERE ${condition} LIMIT 1`, [table, ...bindings]);
        if (found.rows.length > 0) hits.push(`${table}.${column}`);
    }
    return [new Set(columns.rows.map((row) => row.table)).size, hits];
}

/** Keys (and, for strings, sets, hashes, lists and sorted sets, values) of the whole Redis database that contain a needle, ignoring the permitted homes. */
async function scanRedisOutsideNameHomes(needles: string[]): Promise<string[]> {
    const lowered = needles.map((needle) => needle.toLowerCase());
    const offenders: string[] = [];
    let cursor = "0";
    do {
        const [next, keys] = await redis.scan(cursor, "MATCH", "*", "COUNT", 500);
        cursor = next;
        for (const key of keys) {
            if (key.startsWith("identity:user:") || key === "name-index") continue;
            const type = await redis.type(key);
            let text = key;
            if (type === "string") text += `\n${(await redis.get(key)) ?? ""}`;
            else if (type === "zset") text += `\n${(await redis.zrange(key, 0, -1)).join("\n")}`;
            else if (type === "set") text += `\n${(await redis.smembers(key)).join("\n")}`;
            else if (type === "list") text += `\n${(await redis.lrange(key, 0, -1)).join("\n")}`;
            else if (type === "hash") text += `\n${Object.entries(await redis.hgetall(key)).flat().join("\n")}`;
            const haystack = text.toLowerCase();
            if (lowered.some((needle) => haystack.includes(needle))) offenders.push(key);
        }
    } while (cursor !== "0");
    return offenders;
}
