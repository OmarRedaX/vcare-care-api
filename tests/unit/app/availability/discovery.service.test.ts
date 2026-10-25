// Rules covered: AV-R15 (filters), AV-R16 (window), AV-R17 (order, cursor), AV-R18 (misses, cap, exclusion), AV-R20 (degradation),
// AV-R21 (profile), AV-R22 (hydration), AV-R29 (no names logged).
import { NONE_SCORE } from "../../../../src/app/availability/constants";
import { decodeDiscoveryCursor, encodeDiscoveryCursor } from "../../../../src/app/availability/discovery-cursor";
import { DegradedPart, DiscoveryCursorKind, SearchSortKind } from "../../../../src/app/availability/enums";
import type { AvailabilityService } from "../../../../src/app/availability/service/availability.service";
import { DiscoveryService } from "../../../../src/app/availability/service/discovery.service";
import type { NextAvailableComputer } from "../../../../src/app/availability/service/next-available.computer";
import type { NextAvailableIndex } from "../../../../src/app/availability/service/next-available.index";
import type { ComputedEntry, SearchDoctorsQuery } from "../../../../src/app/availability/types";
import { DoctorProfile } from "../../../../src/app/doctors/entity/doctor-profile.entity";
import { CandidateOrder, IdentitySyncStatus, VerificationStatus } from "../../../../src/app/doctors/enums";
import type { DoctorDiscoveryReader } from "../../../../src/app/doctors/service/doctor-discovery.reader";
import type { DoctorsService } from "../../../../src/app/doctors/service/doctors.service";
import type { Candidate, PublicDoctorView } from "../../../../src/app/doctors/types";
import { ConsultationType } from "../../../../src/app/schedules/entity/consultation-type.entity";
import type { Env } from "../../../../src/lib/config/types";
import type { IdentityClient } from "../../../../src/lib/identity-client/identity-client";
import type { HydratedUser } from "../../../../src/lib/identity-client/types";
import type { Logger } from "../../../../src/lib/logger/logger";
import type { AuthContext } from "../../../../src/lib/types/types";
import { FREE_MAP_BYTES, FREE_MAP_VERSION, baseBucketOf, toFreeMap } from "../../../../src/pkg/slots/free-map";

const NOW = Date.UTC(2027, 0, 4, 8, 0, 0);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const SECRET = "synthetic-cursor-secret";
const SECRET_NAME = "SYNTHETIC-DISPLAY-NAME-7731";
const SEARCH_NAME = "SYNTHETIC-SEARCH-NAME";

const cand = (profileId: number, fee = 100, years = 5): Candidate => ({ profileId, userId: profileId + 1000, fee, years });
const type = (id: number, durationMinutes: number): ConsultationType => new ConsultationType({ id, name: `T${id}`, durationMinutes, price: 100, currency: "EGP", isActive: true, createdAt: new Date(0), updatedAt: new Date(0) });
const view = (candidate: Candidate, overrides: Partial<PublicDoctorView> = {}): PublicDoctorView => ({
    profile: new DoctorProfile({ id: candidate.profileId, userId: candidate.userId, headline: `Headline ${candidate.profileId}`, bio: null, yearsExperience: candidate.years,
        consultationFeeAmount: candidate.fee, currency: "EGP", defaultSlotMinutes: 30, timezone: "UTC", isAcceptingPatients: true, verificationStatus: VerificationStatus.Approved,
        identitySyncStatus: IdentitySyncStatus.Synced, suspendedAt: null }),
    languages: ["en"], specialties: [], activeTypes: [type(candidate.profileId * 10, 30)], bookable: true, ...overrides });
const hydratedUser = (status: HydratedUser["status"] = "active"): HydratedUser => ({ displayName: SECRET_NAME, avatarUrl: "https://synthetic.invalid/a.png", status });
const query = (overrides: Partial<SearchDoctorsQuery> = {}): SearchDoctorsQuery => ({ sort: SearchSortKind.EarliestAvailability, limit: 2, ...overrides });
const entry = (userId: number, score: number, map: Uint8Array = new Uint8Array(0)): ComputedEntry => ({ userId, score, map, ver: "1" });
const validEmptyMap = (): Uint8Array => { const map = new Uint8Array(FREE_MAP_BYTES); map[0] = FREE_MAP_VERSION; return map; };

function setup(candidates: Candidate[], options: { usable?: boolean; cap?: number } = {}) {
    const scoreTable = new Map<number, number | null>();
    const mapTable = new Map<number, Uint8Array | null>();
    const logged: unknown[][] = [];
    const record = (...args: unknown[]): void => { logged.push(args); };
    const logger = { warn: jest.fn(record), info: jest.fn(record), debug: jest.fn(record), error: jest.fn(record), metric: jest.fn(record) };
    const reader = {
        listCandidates: jest.fn(() => Promise.resolve({ items: candidates, truncated: false })),
        pageCandidates: jest.fn((_filters: unknown, params: { order: CandidateOrder; after: { value: number; id: number } | null; fetch: number }) => {
            const sorted = [...candidates].sort(params.order === CandidateOrder.Price ? (a, b) => a.fee - b.fee || a.profileId - b.profileId : (a, b) => b.years - a.years || b.profileId - a.profileId);
            const rest = sorted.filter((item) => params.after === null ? true : params.order === CandidateOrder.Price
                ? item.fee > params.after.value || (item.fee === params.after.value && item.profileId > params.after.id)
                : item.years < params.after.value || (item.years === params.after.value && item.profileId < params.after.id));
            return Promise.resolve(rest.slice(0, params.fetch));
        }),
        listBookableForIndex: jest.fn((ids: readonly number[]) => Promise.resolve({ items: ids.map((userId) => ({ profileId: userId - 1000, userId, timezone: "UTC" })), truncated: false })),
    };
    const index = {
        isUsable: jest.fn(() => options.usable ?? true),
        scores: jest.fn((ids: readonly number[]) => Promise.resolve<Map<number, number | null> | undefined>(new Map(ids.map((id) => [id, scoreTable.get(id) ?? null])))),
        maps: jest.fn((ids: readonly number[]) => Promise.resolve<Map<number, Uint8Array | null> | undefined>(new Map(ids.map((id) => [id, mapTable.get(id) ?? null])))),
    };
    const computer = { refresh: jest.fn((doctors: readonly { userId: number }[], nowMs: number) => Promise.resolve({
        entries: doctors.map((item) => entry(item.userId, nowMs + 60_000 + item.userId, validEmptyMap())), removed: [], stored: doctors.length, failed: [] })) };
    const doctors = { findPublicViews: jest.fn((ids: readonly number[]) => Promise.resolve(new Map(ids.flatMap((id) => {
        const found = candidates.find((item) => item.userId === id);
        return found === undefined ? [] : [[id, view(found)] as [number, PublicDoctorView]];
    })))) };
    const availability = { resolveRenderZone: jest.fn((_actor: AuthContext, timezone: string | undefined) => Promise.resolve(timezone ?? "UTC")), listSlots: jest.fn(() => Promise.resolve([])) };
    const identity = { getUsersBatch: jest.fn((ids: number[]) => Promise.resolve({ users: new Map(ids.map((id) => [id, hydratedUser()])), degraded: false })) };
    const service = new DiscoveryService(reader as unknown as DoctorDiscoveryReader, doctors as unknown as DoctorsService, availability as unknown as AvailabilityService,
        index as unknown as NextAvailableIndex, computer as unknown as NextAvailableComputer, identity as unknown as IdentityClient, logger as unknown as Logger,
        { SERVICE_CLIENT_SECRET: SECRET, AVAILABILITY_INLINE_MISS_CAP: options.cap ?? 20 } as Env, { now: () => NOW });
    return { service, reader, index, computer, doctors, availability, identity, logger, logged, scoreTable, mapTable };
}

const ids = (result: { items: Array<{ view: PublicDoctorView }> }): number[] => result.items.map((item) => item.view.profile.id);
const admin: AuthContext = { userId: 1, role: "admin", status: "active", emailVerified: true };
const patient: AuthContext = { userId: 2, role: "patient", status: "active", emailVerified: true };

describe("DiscoveryService.search with a usable index (AV-R17, AV-R18)", () => {
    it("should rank by earliest score then id, ranking unknown and none doctors last, and page with a signed earliest cursor", async () => {
        const s = setup([cand(1), cand(2), cand(3), cand(4), cand(5)], { cap: 0 });
        s.scoreTable.set(1001, NOW + 5 * HOUR); s.scoreTable.set(1002, NOW + HOUR); s.scoreTable.set(1003, NONE_SCORE); s.scoreTable.set(1004, NOW + HOUR);
        const first = await s.service.search(query());
        expect(ids(first)).toEqual([2, 4]);
        expect(first.meta).toEqual({ nextCursor: expect.any(String), hasMore: true, count: 2 });
        expect(decodeDiscoveryCursor(first.meta.nextCursor!, SECRET, DiscoveryCursorKind.Earliest)).toEqual({ k: "earliest", v: NOW + HOUR, id: 4 });
        const second = await s.service.search(query({ cursor: first.meta.nextCursor! }));
        expect(ids(second)).toEqual([1, 3]);
        const third = await s.service.search(query({ cursor: second.meta.nextCursor! }));
        expect(ids(third)).toEqual([5]);
        expect(third.meta).toEqual({ nextCursor: null, hasMore: false, count: 1 });
    });

    it("should read every score with one index call and expose nextAvailableAt only for a known free doctor", async () => {
        const s = setup([cand(1), cand(2)], { cap: 0 });
        s.scoreTable.set(1001, NOW + 2 * HOUR); s.scoreTable.set(1002, NONE_SCORE);
        const result = await s.service.search(query({ limit: 10 }));
        expect(s.index.scores).toHaveBeenCalledTimes(1);
        expect(result.items.map((item) => item.nextAvailableAt)).toEqual([NOW + 2 * HOUR, null]);
    });

    it("should treat a score at or before now as a miss and compute it inline, ascending by profile id, capped (AV-R18)", async () => {
        const candidates = Array.from({ length: 25 }, (_, position) => cand(position + 1));
        const s = setup(candidates, { cap: 20 });
        const result = await s.service.search(query({ limit: 100 }));
        const computedIds = (s.computer.refresh.mock.calls[0]?.[0] as Array<{ userId: number }>).map((item) => item.userId);
        expect(computedIds).toEqual(Array.from({ length: 20 }, (_, position) => 1001 + position));
        expect(s.reader.listBookableForIndex).toHaveBeenCalledWith(computedIds);
        expect(ids(result).slice(0, 20)).toEqual(Array.from({ length: 20 }, (_, position) => position + 1));
        expect(result.items.slice(20).every((item) => item.nextAvailableAt === null)).toBe(true);
        expect(s.logger.metric).toHaveBeenCalledWith("availability_index_miss", 25);
        expect(s.logger.metric).toHaveBeenCalledWith("availability_inline_compute_ms", expect.any(Number));
    });

    it("should treat an elapsed score as a miss", async () => {
        const s = setup([cand(1)], { cap: 5 });
        s.scoreTable.set(1001, NOW);
        await s.service.search(query());
        expect(s.computer.refresh).toHaveBeenCalledTimes(1);
    });

    it("should not compute anything when the cap is zero", async () => {
        const s = setup([cand(1), cand(2)], { cap: 0 });
        const result = await s.service.search(query());
        expect(s.computer.refresh).not.toHaveBeenCalled();
        expect(ids(result)).toEqual([1, 2]);
    });

    it("should page price order with a SQL keyset and look up the scores of the page rows only (path A)", async () => {
        const s = setup([cand(1, 300), cand(2, 100), cand(3, 200)], { cap: 0 });
        const first = await s.service.search(query({ sort: SearchSortKind.Price }));
        expect(s.reader.listCandidates).not.toHaveBeenCalled();
        expect(s.reader.pageCandidates).toHaveBeenCalledWith(expect.anything(), { order: CandidateOrder.Price, after: null, fetch: 3 });
        expect(ids(first)).toEqual([2, 3]);
        expect(s.index.scores).toHaveBeenCalledWith([1002, 1003]);
        expect(decodeDiscoveryCursor(first.meta.nextCursor!, SECRET, DiscoveryCursorKind.Price)).toEqual({ k: "price", v: 200, id: 3 });
        const second = await s.service.search(query({ sort: SearchSortKind.Price, cursor: first.meta.nextCursor! }));
        expect(s.reader.pageCandidates).toHaveBeenLastCalledWith(expect.anything(), { order: CandidateOrder.Price, after: { value: 200, id: 3 }, fetch: 3 });
        expect(ids(second)).toEqual([1]);
        expect(second.meta.hasMore).toBe(false);
    });

    it("should page experience order descending with its own keyset (path A)", async () => {
        const s = setup([cand(1, 1, 3), cand(2, 1, 9), cand(3, 1, 9)], { cap: 0 });
        const first = await s.service.search(query({ sort: SearchSortKind.Experience }));
        expect(ids(first)).toEqual([3, 2]);
        const second = await s.service.search(query({ sort: SearchSortKind.Experience, cursor: first.meta.nextCursor! }));
        expect(ids(second)).toEqual([1]);
    });

    it("should page price order in memory when a window filter is present (path B)", async () => {
        const s = setup([cand(1, 300), cand(2, 100), cand(3, 200)], { cap: 0 });
        for (const id of [1001, 1002, 1003]) s.scoreTable.set(id, NOW + DAY + HOUR);
        const result = await s.service.search(query({ sort: SearchSortKind.Price, limit: 10, availableFrom: new Date(NOW + DAY).toISOString(), availableTo: new Date(NOW + 2 * DAY).toISOString() }));
        expect(s.reader.listCandidates).toHaveBeenCalled();
        expect(s.reader.pageCandidates).not.toHaveBeenCalled();
        expect(ids(result)).toEqual([2, 3, 1]);
    });

    it("should pass the whitelisted filters and the normalised name prefix to the candidate read", async () => {
        const s = setup([cand(1)], { cap: 0 });
        await s.service.search(query({ specialty: "cardiology", language: "ar", minFee: 10, maxFee: 500, name: "  DR   Anna " }));
        expect(s.reader.listCandidates).toHaveBeenCalledWith({ specialty: "cardiology", language: "ar", minFee: 10, maxFee: 500, namePrefix: "dr anna" });
    });
});

describe("DiscoveryService.search window filter (AV-R16, AV-R18)", () => {
    const from = NOW + 2 * DAY;
    const window = { availableFrom: new Date(from).toISOString(), availableTo: new Date(from + DAY).toISOString() };

    it("should settle matches and misses from the score alone and read maps only for earlier first starts", async () => {
        const s = setup([cand(1), cand(2), cand(3), cand(4)], { cap: 0 });
        s.scoreTable.set(1001, from + HOUR);         // inside: match without a map
        s.scoreTable.set(1002, from + 2 * DAY);       // after the window: no match without a map
        s.scoreTable.set(1003, NOW + HOUR);          // before the window: needs its map
        s.scoreTable.set(1004, NONE_SCORE);          // known none
        const withSlot = toFreeMap([from + 3 * HOUR], baseBucketOf(NOW));
        s.mapTable.set(1003, withSlot);
        const result = await s.service.search(query({ limit: 10, ...window }));
        expect(s.index.maps).toHaveBeenCalledWith([1003]);
        expect(ids(result)).toEqual([3, 1]);
        expect(result.meta.degraded).toBeUndefined();
    });

    it("should exclude a doctor whose map shows no slot in the window", async () => {
        const s = setup([cand(1)], { cap: 0 });
        s.scoreTable.set(1001, NOW + HOUR);
        s.mapTable.set(1001, toFreeMap([NOW + HOUR], baseBucketOf(NOW)));
        expect(ids(await s.service.search(query({ ...window })))).toEqual([]);
    });

    it("should compute a missing map inline within the cap and use the fresh map", async () => {
        const s = setup([cand(1)], { cap: 5 });
        s.scoreTable.set(1001, NOW + HOUR);
        s.computer.refresh.mockResolvedValue({ entries: [entry(1001, NOW + HOUR, toFreeMap([from + HOUR], baseBucketOf(NOW)))], removed: [], stored: 1, failed: [] });
        const result = await s.service.search(query({ ...window }));
        expect(ids(result)).toEqual([1]);
        expect(result.meta.degraded).toBeUndefined();
    });

    it("should exclude unknown availability beyond the cap and report availabilityFilter, never claiming a slot without proof", async () => {
        const s = setup([cand(1), cand(2), cand(3)], { cap: 1 });
        s.scoreTable.set(1002, from + HOUR);
        const result = await s.service.search(query({ limit: 10, ...window }));
        expect((s.computer.refresh.mock.calls[0]?.[0] as Array<{ userId: number }>).map((item) => item.userId)).toEqual([1001]);
        expect(ids(result)).toEqual([2]);
        expect(result.meta.degraded).toEqual([DegradedPart.AvailabilityFilter]);
    });

    it("should treat an invalid map layout as unknown and report availabilityFilter", async () => {
        const s = setup([cand(1)], { cap: 0 });
        s.scoreTable.set(1001, NOW + HOUR);
        s.mapTable.set(1001, new Uint8Array([9, 9, 9]));
        const result = await s.service.search(query({ ...window }));
        expect(ids(result)).toEqual([]);
        expect(result.meta.degraded).toEqual([DegradedPart.AvailabilityFilter]);
    });

    it("should validate the window before any I/O (400)", async () => {
        const s = setup([cand(1)]);
        await expect(s.service.search(query({ availableFrom: new Date(NOW - HOUR).toISOString() }))).rejects.toMatchObject({ code: "ValidationFailed", details: [{ field: "availableFrom" }] });
        await expect(s.service.search(query({ minFee: 5, maxFee: 1 }))).rejects.toMatchObject({ code: "ValidationFailed", details: [{ field: "minFee" }] });
        await expect(s.service.search(query({ name: " a " }))).rejects.toMatchObject({ code: "ValidationFailed", details: [{ field: "name" }] });
        expect(s.reader.listCandidates).not.toHaveBeenCalled();
        expect(s.index.scores).not.toHaveBeenCalled();
    });
});

describe("DiscoveryService.search degradation (AV-R20)", () => {
    it("should serve earliest_availability in price order with a degraded sort flag and inline positions when Redis is unusable", async () => {
        const s = setup([cand(1, 300), cand(2, 100), cand(3, 200)], { usable: false, cap: 2 });
        const result = await s.service.search(query({ limit: 10 }));
        expect(ids(result)).toEqual([2, 3, 1]);
        expect(result.meta.degraded).toEqual([DegradedPart.Sort]);
        expect(s.index.scores).not.toHaveBeenCalled();
        expect((s.computer.refresh.mock.calls[0]?.[0] as Array<{ userId: number }>).map((item) => item.userId)).toEqual([1001, 1002]);
        expect(result.items.map((item) => item.nextAvailableAt !== null)).toEqual([true, false, true]);
    });

    it("should list degraded parts in the fixed order sort, availabilityFilter, nameFilter", async () => {
        const s = setup([cand(1)], { usable: false, cap: 0 });
        const result = await s.service.search(query({ name: SEARCH_NAME, availableFrom: new Date(NOW + HOUR).toISOString() }));
        expect(result.meta.degraded).toEqual([DegradedPart.Sort, DegradedPart.AvailabilityFilter, DegradedPart.NameFilter]);
        expect(s.logger.metric).toHaveBeenCalledWith("availability_degraded", 1, { reason: "sort" });
        expect(s.logger.metric).toHaveBeenCalledWith("availability_degraded", 1, { reason: "availabilityFilter" });
        expect(s.logger.metric).toHaveBeenCalledWith("availability_degraded", 1, { reason: "nameFilter" });
    });

    it("should not add the sort flag when the sort was already price, and omit meta.degraded when nothing degraded", async () => {
        const s = setup([cand(1)], { usable: false, cap: 0 });
        expect((await s.service.search(query({ sort: SearchSortKind.Price }))).meta.degraded).toBeUndefined();
        const healthy = setup([cand(1)], { cap: 0 });
        expect((await healthy.service.search(query())).meta.degraded).toBeUndefined();
    });

    it("should report nameFilter whenever a name is supplied (slice 2 has no name index)", async () => {
        const s = setup([cand(1)], { cap: 0 });
        s.scoreTable.set(1001, NOW + HOUR);
        expect((await s.service.search(query({ name: SEARCH_NAME }))).meta.degraded).toEqual([DegradedPart.NameFilter]);
    });

    it("should page the degraded price order and issue degraded cursors that only a degraded request accepts", async () => {
        const s = setup([cand(1, 300), cand(2, 100), cand(3, 200)], { usable: false, cap: 0 });
        const first = await s.service.search(query());
        expect(decodeDiscoveryCursor(first.meta.nextCursor!, SECRET, DiscoveryCursorKind.Degraded)).toEqual({ k: "degraded", v: 200, id: 3 });
        expect(ids(await s.service.search(query({ cursor: first.meta.nextCursor! })))).toEqual([1]);
        const healthy = setup([cand(1, 300), cand(2, 100), cand(3, 200)], { cap: 0 });
        await expect(healthy.service.search(query({ cursor: first.meta.nextCursor! }))).rejects.toMatchObject({ code: "ValidationFailed", details: [{ field: "cursor", issue: "does not match the requested sort" }] });
    });

    it("should reject an earliest cursor presented while Redis is unusable (400, restart the list)", async () => {
        const healthy = setup([cand(1), cand(2), cand(3)], { cap: 0 });
        const first = await healthy.service.search(query());
        const down = setup([cand(1), cand(2), cand(3)], { usable: false, cap: 0 });
        await expect(down.service.search(query({ cursor: first.meta.nextCursor! }))).rejects.toMatchObject({ code: "ValidationFailed", details: [{ field: "cursor" }] });
    });

    it("should rerun degraded when an index command fails mid-request and still return 200", async () => {
        const s = setup([cand(1, 300), cand(2, 100)], { cap: 0 });
        s.index.scores.mockResolvedValue(undefined);
        const result = await s.service.search(query({ limit: 10 }));
        expect(ids(result)).toEqual([2, 1]);
        expect(result.meta.degraded).toEqual([DegradedPart.Sort]);
    });

    it("should keep a price cursor valid across a mid-request index failure", async () => {
        const s = setup([cand(1, 300), cand(2, 100), cand(3, 200)], { cap: 0 });
        s.index.scores.mockResolvedValue(undefined);
        const first = await s.service.search(query({ sort: SearchSortKind.Price }));
        expect(first.meta.degraded).toBeUndefined();
        expect(ids(await s.service.search(query({ sort: SearchSortKind.Price, cursor: first.meta.nextCursor! })))).toEqual([1]);
    });

    it("should ignore an index failure of the window plan by dropping the window and flagging it", async () => {
        const s = setup([cand(1)], { cap: 0 });
        s.index.scores.mockResolvedValue(undefined);
        const result = await s.service.search(query({ availableFrom: new Date(NOW + HOUR).toISOString() }));
        expect(result.meta.degraded).toEqual([DegradedPart.Sort, DegradedPart.AvailabilityFilter]);
        expect(ids(result)).toEqual([1]);
    });
});

describe("DiscoveryService.search hydration (AV-R22) and privacy (AV-R29)", () => {
    it("should hydrate the whole page with one batched call", async () => {
        const s = setup([cand(1), cand(2)], { cap: 0 });
        const result = await s.service.search(query());
        expect(s.identity.getUsersBatch).toHaveBeenCalledTimes(1);
        expect(s.identity.getUsersBatch.mock.calls[0]?.[0]).toEqual([1001, 1002]);
        expect(result.hydrated.get(1001)?.displayName).toBe(SECRET_NAME);
    });

    it("should keep every row with an empty hydration map when Identity fails (Case 2, never a 5xx)", async () => {
        const s = setup([cand(1), cand(2)], { cap: 0 });
        s.identity.getUsersBatch.mockRejectedValue(new Error("identity down"));
        const result = await s.service.search(query());
        expect(ids(result)).toEqual([1, 2]);
        expect(result.hydrated.size).toBe(0);
    });

    it("should drop rows whose Identity status is not active but compute the cursor from the fetched page", async () => {
        const s = setup([cand(1), cand(2), cand(3)], { cap: 0 });
        s.identity.getUsersBatch.mockImplementation((userIds: number[]) => Promise.resolve({
            users: new Map(userIds.map((id) => [id, hydratedUser(id === 1001 ? "suspended" : "active")])), degraded: false }));
        const result = await s.service.search(query());
        expect(ids(result)).toEqual([2]);
        expect(result.meta).toMatchObject({ count: 1, hasMore: true, nextCursor: expect.any(String) });
        expect(decodeDiscoveryCursor(result.meta.nextCursor!, SECRET, DiscoveryCursorKind.Earliest).id).toBe(2);
    });

    it("should drop rows whose public view vanished between the page and the view load", async () => {
        const s = setup([cand(1), cand(2)], { cap: 0 });
        s.doctors.findPublicViews.mockResolvedValue(new Map([[1002, view(cand(2))]]));
        expect(ids(await s.service.search(query()))).toEqual([2]);
    });

    it("should never log display names or the name query", async () => {
        const s = setup([cand(1), cand(2)], { cap: 1 });
        await s.service.search(query({ name: SEARCH_NAME }));
        const text = JSON.stringify(s.logged);
        expect(text).not.toContain(SECRET_NAME);
        expect(text).not.toContain(SEARCH_NAME);
        expect(text).not.toContain("synthetic.invalid");
    });
});

describe("DiscoveryService.getDoctor (AV-R21)", () => {
    const target = cand(7);
    it("should answer 404 for an unknown id and for a non-bookable doctor when the caller is a patient", async () => {
        const unknown = setup([]);
        await expect(unknown.service.getDoctor(patient, 1007, {})).rejects.toMatchObject({ code: "NotFound" });
        const hidden = setup([target]);
        hidden.doctors.findPublicViews.mockResolvedValue(new Map([[1007, view(target, { bookable: false })]]));
        await expect(hidden.service.getDoctor(patient, 1007, {})).rejects.toMatchObject({ code: "NotFound" });
        expect(hidden.availability.listSlots).not.toHaveBeenCalled();
        expect(hidden.identity.getUsersBatch).not.toHaveBeenCalled();
    });

    it("should show an admin a non-bookable profile without computing any slot", async () => {
        const s = setup([target]);
        s.doctors.findPublicViews.mockResolvedValue(new Map([[1007, view(target, { bookable: false })]]));
        const result = await s.service.getDoctor(admin, 1007, {});
        expect(result).toMatchObject({ admin: true, nextAvailableAt: null, slots: [] });
        expect(result.view.bookable).toBe(false);
        expect(s.availability.listSlots).not.toHaveBeenCalled();
    });

    it("should preview the first five slots of the shortest active type, ties by lowest id, from the shared slot list", async () => {
        const s = setup([target]);
        s.doctors.findPublicViews.mockResolvedValue(new Map([[1007, view(target, { activeTypes: [type(30, 45), type(20, 15), type(10, 15)] })]]));
        const slots = Array.from({ length: 8 }, (_, position) => ({ startMs: NOW + (position + 1) * HOUR, endMs: NOW + (position + 1) * HOUR + 900_000 }));
        s.availability.listSlots.mockResolvedValue(slots as never);
        const result = await s.service.getDoctor(patient, 1007, { timezone: "Africa/Cairo" });
        expect(s.availability.listSlots).toHaveBeenCalledWith(expect.objectContaining({ profileId: 7, userId: 1007, timezone: "UTC" }), { id: 10, durationMinutes: 15 }, "2027-01-04", "2027-01-18");
        expect(result.slots).toEqual(slots.slice(0, 5));
        expect(result.nextAvailableAt).toBe(NOW + HOUR);
        expect(result.timezone).toBe("Africa/Cairo");
        expect(result.admin).toBe(false);
    });

    it("should drop preview slots outside the next 14 days and return null when none remain", async () => {
        const s = setup([target]);
        s.availability.listSlots.mockResolvedValue([{ startMs: NOW - HOUR, endMs: NOW }, { startMs: NOW + 14 * DAY, endMs: NOW + 14 * DAY + HOUR }] as never);
        const result = await s.service.getDoctor(patient, 1007, {});
        expect(result.slots).toEqual([]);
        expect(result.nextAvailableAt).toBeNull();
    });

    it("should hydrate once and degrade to an undefined hydration when Identity fails", async () => {
        const s = setup([target]);
        s.identity.getUsersBatch.mockRejectedValue(new Error("identity down"));
        const result = await s.service.getDoctor(patient, 1007, {});
        expect(result.hydrated).toBeUndefined();
        expect(s.identity.getUsersBatch).toHaveBeenCalledTimes(1);
    });

    it("should load the views with one batched call keyed by user id", async () => {
        const s = setup([target]);
        await s.service.getDoctor(patient, 1007, {});
        expect(s.doctors.findPublicViews).toHaveBeenCalledWith([1007]);
    });
});

describe("encodeDiscoveryCursor is stable for the service (sanity)", () => {
    it("should issue a cursor that carries no doctor data beyond the position", () => {
        const cursor = encodeDiscoveryCursor({ k: DiscoveryCursorKind.Price, v: 1, id: 2 }, SECRET);
        expect(Buffer.from(cursor.split(".")[0] ?? "", "base64url").toString()).toBe('{"k":"price","v":1,"id":2}');
    });
});
