/**
 * availability search and profile (slice S2) — real Postgres, real Redis, real wiring; only Identity (fake HTTP server) and JWKS are fake.
 *
 * Rule map: AV-R2 (RBAC), AV-R14 (candidate parity with isBookable), AV-R15 (filters), AV-R16 (window defaults and 400s are in
 * availability-search-pagination), AV-R20 (nameFilter fallback), AV-R21 (profile), AV-R22 (Case 2 hydration), AV-R26 (rate limits are unit
 * and rate-limit suites), AV-R27 (name filter: headline term and the no-index fallback here, the index-backed cases in the slice 3 suite), AV-R29 (no names in logs). Contract conformance reads contracts/openapi.yaml.
 */
import { DateTime } from "luxon";
import { toDoctorProfile } from "../../src/app/doctors/doctor-profile.mapper";
import { isBookable } from "../../src/app/doctors/service/doctors.service";
import { useAvailabilityHarness } from "../helpers/availability-harness";
import type { DoctorSeed } from "../helpers/availability-seed";
import { seedDoctor, seedSpecialty } from "../helpers/availability-seed";
import { contractResponseCodes, expectErrorEnvelope, expectPaginationMeta, inlineLists, schemaBlock } from "../helpers/contract";
import { ownerDb } from "../helpers/db";
import type { FakeIdentityUser } from "../helpers/fake-identity-server";
import { captureLogs } from "../helpers/log-capture";

jest.setTimeout(60_000);

const SUITE = "availability-search";
const NAME = (id: number): string => `Dr Fixture Name ${id}`;
const AVATAR = (id: number): string => `https://example.test/avatar-${id}.png`;

describe("availability search and profile (integration)", () => {
    const a = useAvailabilityHarness(SUITE);

    async function doctor(seed: DoctorSeed, identity: Partial<FakeIdentityUser> | false = {}): Promise<number> {
        const profileId = await seedDoctor(seed);
        if (identity !== false) {
            a.h.identityServer.users.set(seed.userId, { id: seed.userId, fullName: NAME(seed.userId), avatarUrl: AVATAR(seed.userId), status: "active", ...identity });
        }
        return profileId;
    }
    const ids = (body: { data: Array<{ userId: number }> }): number[] => body.data.map((item) => item.userId);
    const sorted = (list: number[]): number[] => [...list].sort((x, y) => x - y);
    const identityBatchCalls = (): number => a.h.identityServer.calls.filter((call) => call.path.startsWith("/internal/users?ids=")).length;

    describe("RBAC (AV-R2)", () => {
        beforeEach(async () => { await doctor({ userId: 501 }); });

        it("should return 200 for patient and admin and refuse the doctor role when searching", async () => {
            for (const actor of ["patient", "admin", "unverified"] as const) {
                const response = await a.search({}, actor);
                expect(response.status).toBe(200);
                expect(ids(response.body)).toEqual([501]);
            }
            const doctorResponse = await a.search({}, "doctor");
            expect(doctorResponse.status).toBe(403);
            expectErrorEnvelope(doctorResponse.body, "Forbidden");
        });

        it("should return 401 when the bearer is missing or expired and 403 when the token status is not active on search", async () => {
            const missing = await a.getWith("/api/doctors");
            expect(missing.status).toBe(401);
            expectErrorEnvelope(missing.body, "Unauthorized");
            const now = Math.floor(Date.now() / 1000);
            const expired = await a.getWith("/api/doctors", await a.h.signFor(101, "patient", "active", { iat: now - 1500, exp: now - 600 }));
            expect(expired.status).toBe(401);
            expectErrorEnvelope(expired.body, "TokenExpired");
            for (const status of ["pending", "suspended", "rejected"] as const) {
                const response = await a.getWith("/api/doctors", await a.h.signFor(101, "patient", status));
                expect(response.status).toBe(403);
                expectErrorEnvelope(response.body, "Forbidden");
            }
            expect((await a.search({}, "suspendedPatient")).status).toBe(403);
        });

        it("should apply the same role and token rules to the profile route", async () => {
            for (const actor of ["patient", "admin"] as const) expect((await a.profile(501, actor)).status).toBe(200);
            expect((await a.profile(501, "doctor")).status).toBe(403);
            expect((await a.getWith("/api/doctors/501")).status).toBe(401);
            expect((await a.profile(501, "suspendedPatient")).status).toBe(403);
        });

        it("should leave /doctors/me to the doctors router: a patient or admin gets its 403, never a profile lookup", async () => {
            for (const actor of ["patient", "admin"] as const) {
                const response = await a.get("/api/doctors/me", actor);
                expect(response.status).toBe(403);
                expectErrorEnvelope(response.body, "Forbidden");
            }
        });

        it("should trust only the verified token and ignore caller-supplied identity headers when searching", async () => {
            const response = await a.search({}, "doctor").set("X-User-Id", "101").set("X-Role", "patient");
            expect(response.status).toBe(403);
        });
    });

    describe("profile (AV-R21)", () => {
        it("should show a patient only a bookable doctor and show an admin any live profile with status", async () => {
            await doctor({ userId: 510 });
            await doctor({ userId: 511, suspended: true });
            await doctor({ userId: 512, types: [{ minutes: 30, active: false }] });
            await doctor({ userId: 513, deleted: true });
            await doctor({ userId: 514, accepting: false });
            await doctor({ userId: 515, verification: "submitted" });
            const bookable = await a.profile(510, "patient");
            expect(bookable.status).toBe(200);
            expect(bookable.body.data.status).toBeUndefined();
            for (const userId of [511, 512, 514, 515, 513, 999]) {
                const response = await a.profile(userId, "patient");
                expect(response.status).toBe(404);
                expectErrorEnvelope(response.body, "NotFound");
            }
            const admin = await a.profile(510, "admin");
            expect(admin.body.data.status).toBe("bookable");
            for (const userId of [511, 512, 514, 515]) {
                const response = await a.profile(userId, "admin");
                expect(response.status).toBe(200);
                expect(response.body.data.status).toBe("not_bookable");
                expect(response.body.data.nextAvailableAt).toBeNull();
                expect(response.body.data.nextAvailableSlots).toEqual([]);
            }
            expectErrorEnvelope((await a.profile(513, "admin")).body, "NotFound");
            expectErrorEnvelope((await a.profile(999, "admin")).body, "NotFound");
        });

        it("should return 404 for a path id that is not a positive integer and 400 for a bad or oversized timezone", async () => {
            await doctor({ userId: 520 });
            for (const bad of ["abc", "0", "-5", "1.5", "007x"]) {
                for (const actor of ["patient", "admin"] as const) {
                    const response = await a.get(`/api/doctors/${bad}`, actor);
                    expect(response.status).toBe(404);
                    expectErrorEnvelope(response.body, "NotFound");
                }
            }
            for (const zone of ["Mars/Base", "A".repeat(65), ""]) {
                const response = await a.get(`/api/doctors/520?timezone=${encodeURIComponent(zone)}`);
                expect(response.status).toBe(400);
                expectErrorEnvelope(response.body, "ValidationFailed");
            }
            const unknownKey = await a.get("/api/doctors/520?foo=1");
            expect(unknownKey.status).toBe(400);
        });

        it("should list active types only, the first five slots of the shortest type rendered in the requested zone, and no internal state", async () => {
            await doctor({ userId: 530, hours: { start: "00:00", end: "24:00" }, types: [{ name: "Long visit", minutes: 60 }, { name: "Quick visit", minutes: 15 }, { name: "Retired visit", minutes: 5, active: false }],
                languages: ["en", "ar"] });
            const response = await a.profile(530, "patient", "America/New_York");
            expect(response.status).toBe(200);
            const data = response.body.data;
            expect(data.consultationTypes.map((type: { name: string }) => type.name).sort()).toEqual(["Long visit", "Quick visit"]);
            expect(data.languages).toEqual(["ar", "en"]);
            expect(data.nextAvailableSlots).toHaveLength(5);
            const starts = data.nextAvailableSlots.map((slot: { startsAt: string }) => Date.parse(slot.startsAt));
            expect(starts).toEqual([...starts].sort((x: number, y: number) => x - y));
            starts.forEach((start: number, position: number) => { if (position > 0) expect(start - starts[position - 1]).toBe(15 * 60_000); });
            for (const slot of data.nextAvailableSlots) {
                expect(slot.timezone).toBe("America/New_York");
                expect(slot.startsAtLocal).toMatch(/-0[45]:00$/);
                expect(Date.parse(slot.endsAt) - Date.parse(slot.startsAt)).toBe(15 * 60_000);
            }
            expect(data.nextAvailableAt).toBe(data.nextAvailableSlots[0].startsAt);
            const quick = (data.consultationTypes as Array<{ id: number; name: string }>).find((type) => type.name === "Quick visit")!;
            const from = new Date(starts[0] - 60_000).toISOString();
            const slots = await a.get(`/api/doctors/530/slots?typeId=${quick.id}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(new Date(starts[0] + 86_400_000).toISOString())}&timezone=America/New_York`);
            expect(slots.body.data.slice(0, 5)).toEqual(data.nextAvailableSlots);
            for (const forbidden of ["verificationStatus", "identitySyncStatus", "suspendedAt", "suspensionReason", "reviewNote", "defaultSlotMinutes", "decidedAt", "reviewedBy"]) {
                expect(data).not.toHaveProperty(forbidden);
            }
        });

        it("should render the preview in UTC when no timezone is given and the caller has no patient profile", async () => {
            await doctor({ userId: 531, hours: { start: "00:00", end: "24:00" } });
            const response = await a.profile(531);
            expect(response.body.data.nextAvailableSlots[0].timezone).toBe("UTC");
        });

        it("should break ties between equally short types by lowest id when computing the preview", async () => {
            await doctor({ userId: 532, hours: { start: "00:00", end: "24:00" }, types: [{ name: "Twin B", minutes: 20 }, { name: "Twin A", minutes: 20 }] });
            const response = await a.profile(532);
            const data = response.body.data;
            expect(Date.parse(data.nextAvailableSlots[1].startsAt) - Date.parse(data.nextAvailableSlots[0].startsAt)).toBe(20 * 60_000);
        });

        it("should drop a booked slot from the preview immediately because the consultation listener bumps the version", async () => {
            await doctor({ userId: 202, hours: { start: "00:00", end: "24:00" }, timezone: "Africa/Cairo" });
            const typeId = Number((await ownerDb("consultation_types").first("id"))?.id);
            const first = (await a.profile(202)).body.data.nextAvailableSlots[0].startsAt as string;
            const farSlot = (await a.profile(202)).body.data.nextAvailableSlots[4].startsAt as string;
            const booked = await a.h.book("patient", { doctorId: 202, typeId, startsAt: farSlot, complaintText: "SYNTHETIC-PREVIEW-BOOKING-1", patientTimezone: "UTC" });
            expect(booked.status).toBe(201);
            const after = (await a.profile(202)).body.data;
            expect(after.nextAvailableSlots.map((slot: { startsAt: string }) => slot.startsAt)).not.toContain(farSlot);
            expect(after.nextAvailableSlots[0].startsAt).toBe(first);
            expect(after.nextAvailableSlots).toHaveLength(5);
        });
    });

    describe("candidate set (AV-R14)", () => {
        it("should return exactly the profiles for which isBookable holds when the fixture mixes every non-bookable state", async () => {
            await doctor({ userId: 601 });
            await doctor({ userId: 602, suspended: true });
            await doctor({ userId: 603, accepting: false });
            await doctor({ userId: 604, verification: "submitted" });
            await doctor({ userId: 605, verification: "rejected" });
            await doctor({ userId: 606, verification: "draft" });
            await doctor({ userId: 607, sync: "pending" });
            await doctor({ userId: 608, sync: "failed" });
            await doctor({ userId: 609, sync: "not_required" });
            await doctor({ userId: 610, deleted: true });
            await doctor({ userId: 611, types: [{ minutes: 30, active: false }] });
            await doctor({ userId: 612, types: [{ minutes: 30, deleted: true }] });
            await doctor({ userId: 613, types: [{ minutes: 30, active: false }, { minutes: 45 }] });
            await doctor({ userId: 614, hours: false });
            const rows = await ownerDb("doctor_profiles").select("*").whereNull("deleted_at");
            const active = await ownerDb("consultation_types").select("doctor_profile_id").where({ is_active: true }).whereNull("deleted_at");
            const withType = new Set(active.map((row) => Number(row.doctor_profile_id)));
            const expected = sorted(rows.filter((row) => isBookable(toDoctorProfile(row), withType.has(Number(row.id)))).map((row) => Number(row.user_id)));
            expect(expected).toEqual([601, 613, 614]);
            const viaReader = await a.reader.listCandidates({});
            expect(sorted(viaReader.items.map((candidate) => candidate.userId))).toEqual(expected);
            const bookableList = await a.reader.listBookableForIndex();
            expect(sorted(bookableList.items.map((item) => item.userId))).toEqual(expected);
            for (const sort of ["price", "experience", "earliest_availability"]) {
                const response = await a.search({ sort, limit: 100 });
                expect(sorted(ids(response.body))).toEqual(expected);
            }
            // Admins search the same bookable set: the non-bookable profiles are visible only through the profile route.
            expect(sorted(ids((await a.search({ sort: "price", limit: 100 }, "admin")).body))).toEqual(expected);
            // A doctor who becomes bookable (or stops being) changes the result at once.
            await ownerDb("doctor_profiles").where({ user_id: 602 }).update({ suspended_at: null, suspension_reason: null });
            await ownerDb("doctor_profiles").where({ user_id: 601 }).update({ is_accepting_patients: false });
            expect(sorted(ids((await a.search({ sort: "price", limit: 100 })).body))).toEqual([602, 613, 614]);
        });
    });

    describe("filters (AV-R15)", () => {
        let cardio: number;
        let derm: number;
        beforeEach(async () => {
            cardio = await seedSpecialty("cardiology", "Synthetic Cardiology");
            derm = await seedSpecialty("dermatology", "Synthetic Dermatology");
            await doctor({ userId: 701, fee: 500, languages: ["ar", "en"], specialtyIds: [cardio] });
            await doctor({ userId: 702, fee: 1000, languages: ["en"], specialtyIds: [derm] });
            await doctor({ userId: 703, fee: 1500, languages: ["fr"], specialtyIds: [cardio, derm] });
            await doctor({ userId: 704, fee: 2000, languages: ["ar"] });
            await doctor({ userId: 705, fee: 1000 });
            // Non-bookable doctors never match any filter.
            await doctor({ userId: 706, fee: 500, languages: ["en"], specialtyIds: [cardio], suspended: true });
            await doctor({ userId: 707, fee: 500, languages: ["en"], specialtyIds: [cardio], accepting: false });
        });
        const search = async (params: Record<string, string | number>): Promise<number[]> => {
            const response = await a.search({ ...params, sort: "price", limit: 100 });
            expect(response.status).toBe(200);
            return sorted(ids(response.body));
        };

        it("should match one specialty by slug and nothing for an unknown slug", async () => {
            expect(await search({ specialty: "cardiology" })).toEqual([701, 703]);
            expect(await search({ specialty: "dermatology" })).toEqual([702, 703]);
            const unknown = await a.search({ specialty: "no-such-specialty" });
            expect(unknown.status).toBe(200);
            expect(unknown.body.data).toEqual([]);
            expect(unknown.body.meta).toMatchObject({ count: 0, hasMore: false, nextCursor: null });
        });

        it("should match a language code and reject a malformed one", async () => {
            expect(await search({ language: "en" })).toEqual([701, 702]);
            expect(await search({ language: "ar" })).toEqual([701, 704]);
            expect(await search({ language: "fr" })).toEqual([703]);
            expect(await search({ language: "zz" })).toEqual([]);
            for (const bad of ["english", "E", "EN", "e1", ""]) {
                const response = await a.search({ language: bad });
                expect(response.status).toBe(400);
                expectErrorEnvelope(response.body, "ValidationFailed");
            }
        });

        it("should compare the fee amount inclusively and reject minFee above maxFee", async () => {
            expect(await search({ minFee: 1000 })).toEqual([702, 703, 704, 705]);
            expect(await search({ maxFee: 1000 })).toEqual([701, 702, 705]);
            expect(await search({ minFee: 1000, maxFee: 1000 })).toEqual([702, 705]);
            expect(await search({ minFee: 0, maxFee: 0 })).toEqual([]);
            const reversed = await a.search({ minFee: 1001, maxFee: 1000 });
            expect(reversed.status).toBe(400);
            expectErrorEnvelope(reversed.body, "ValidationFailed");
            expect(reversed.body.error.details).toEqual([expect.objectContaining({ field: "minFee" })]);
            for (const [key, value] of [["minFee", -1], ["maxFee", -1], ["minFee", "abc"], ["maxFee", "1.5"], ["minFee", 2147483648]] as const) {
                expect((await a.search({ [key]: value })).status).toBe(400);
            }
        });

        it("should intersect every filter when they are combined", async () => {
            expect(await search({ specialty: "cardiology", language: "en", maxFee: 600 })).toEqual([701]);
            expect(await search({ specialty: "dermatology", language: "fr" })).toEqual([703]);
            expect(await search({ specialty: "cardiology", language: "fr", minFee: 2000 })).toEqual([]);
            expect(await search({ language: "ar", minFee: 1500 })).toEqual([704]);
        });

        it("should reject unknown query keys, an unknown sort and an out-of-range limit", async () => {
            for (const query of ["foo=1", "sort=newest", "limit=0", "limit=101", "limit=abc", "cursor=" + "x".repeat(1025), "specialty="]) {
                const response = await a.get(`/api/doctors?${query}`);
                expect(response.status).toBe(400);
                expectErrorEnvelope(response.body, "ValidationFailed");
            }
        });
    });

    describe("name filter (AV-R27): headline term and the no-index fallback", () => {
        beforeEach(async () => {
            await doctor({ userId: 801, headline: "Cardiologist Synthetic Ali" });
            await doctor({ userId: 802, headline: "Dermatology expert" }, { fullName: "Cardio Fixture Person" });
            await doctor({ userId: 803, headline: "Dermatology specialist" });
        });

        it("should match a headline prefix case-insensitively and report nameFilter as degraded while no name index exists", async () => {
            for (const name of ["cardio", "CARDIO", "Cardiologist Synthetic", "cardiologist   synthetic  ali"]) {
                const response = await a.search({ name, sort: "price" });
                expect(response.status).toBe(200);
                expect(ids(response.body)).toEqual([801]);
                expect(response.body.meta.degraded).toEqual(["nameFilter"]);
            }
            const many = await a.search({ name: "dermatology", sort: "price" });
            expect(sorted(ids(many.body))).toEqual([802, 803]);
        });

        it("should not match the Identity display name while no name index exists and say so", async () => {
            const response = await a.search({ name: "Cardio Fixture" });
            expect(response.status).toBe(200);
            expect(ids(response.body)).not.toContain(802);
            expect(response.body.meta.degraded).toEqual(["nameFilter"]);
        });

        it("should match the display name through the index once the sweep built it, without reporting nameFilter", async () => {
            expect(await a.sweep()).toBe("done");
            for (const name of ["Cardio Fixture", "cardio   FIXTURE person", "CARDIO"]) {
                const response = await a.search({ name, sort: "price" });
                expect(response.status).toBe(200);
                expect(ids(response.body)).toContain(802);
                expect(response.body.meta).not.toHaveProperty("degraded");
            }
            expect(ids((await a.search({ name: "Cardio Fixture", sort: "price" })).body)).toEqual([802]);
            expect(sorted(ids((await a.search({ name: "cardio", sort: "price" })).body))).toEqual([801, 802]);
        });

        it("should match only a headline prefix, not a word inside the headline", async () => {
            expect(ids((await a.search({ name: "synthetic" })).body)).toEqual([]);
        });

        it("should omit meta.degraded when no name is requested", async () => {
            const response = await a.search({});
            expect(response.body.meta).not.toHaveProperty("degraded");
        });

        it("should reject a name shorter than two characters after trimming and control characters", async () => {
            for (const name of ["a", "%20a%20", "%20%20", "ab%07", "ab%00cd", "ab%0Acd"]) {
                const response = await a.get(`/api/doctors?name=${name}`);
                expect(response.status).toBe(400);
                expectErrorEnvelope(response.body, "ValidationFailed");
            }
            expect((await a.search({ name: "x".repeat(101) })).status).toBe(400);
        });

        it("should bind the name as a SQL parameter when it carries quote and wildcard characters", async () => {
            for (const name of ["'; DROP TABLE doctor_profiles; --", "%%", "_a", "ab\\"]) {
                expect((await a.search({ name })).status).toBe(200);
            }
            expect(Number((await ownerDb("doctor_profiles").count("* as n").first())?.n)).toBe(3);
        });
    });

    describe("Case 2 hydration (AV-R22)", () => {
        beforeEach(async () => {
            for (const userId of [901, 902, 903, 904]) await doctor({ userId, fee: userId });
        });

        it("should map fullName to displayName and hydrate a whole page with one batched Identity call", async () => {
            const response = await a.search({ sort: "price" });
            expect(response.status).toBe(200);
            expect(response.body.data.map((item: { displayName: string }) => item.displayName)).toEqual([901, 902, 903, 904].map(NAME));
            expect(response.body.data.every((item: { profileHydrated: boolean }) => item.profileHydrated)).toBe(true);
            expect(response.body.data[0].avatarUrl).toBe(AVATAR(901));
            expect(identityBatchCalls()).toBe(1);
            const again = await a.search({ sort: "price" });
            expect(again.body.data[0].displayName).toBe(NAME(901));
            expect(identityBatchCalls()).toBe(1);
        });

        it("should return 200 with profileHydrated false and unchanged fees when Identity is down", async () => {
            a.h.identityServer.options.down = true;
            const response = await a.search({ sort: "price" });
            expect(response.status).toBe(200);
            expect(response.body.data).toHaveLength(4);
            for (const item of response.body.data) {
                expect(item).toMatchObject({ displayName: null, avatarUrl: null, profileHydrated: false });
                expect(item.consultationFee.amount).toBeGreaterThan(0);
            }
            expect(response.body.meta.degraded).toBeUndefined();
        });

        it("should return 200 with profileHydrated false when Identity answers slower than the 2 s attempt budget", async () => {
            a.h.identityServer.options.slowMs = 2_600;
            const started = Date.now();
            const response = await a.search({ sort: "price" });
            expect(response.status).toBe(200);
            expect(response.body.data.every((item: { profileHydrated: boolean }) => !item.profileHydrated)).toBe(true);
            expect(Date.now() - started).toBeLessThan(15_000);
        });

        it("should return 200 with profileHydrated false when Identity fails or answers a malformed body", async () => {
            a.h.identityServer.options.batchFailures = 10;
            const failing = await a.search({ sort: "price" });
            expect(failing.status).toBe(200);
            expect(failing.body.data.every((item: { profileHydrated: boolean }) => !item.profileHydrated)).toBe(true);
            await a.h.resetRateLimits();
            delete a.h.identityServer.options.batchFailures;
            a.h.identityServer.options.malformed = true;
            const malformed = await a.search({ sort: "price" });
            expect(malformed.status).toBe(200);
            expect(malformed.body.data.every((item: { profileHydrated: boolean }) => !item.profileHydrated)).toBe(true);
        });

        it("should serve cached display names when Identity goes down after a successful page", async () => {
            expect((await a.search({ sort: "price" })).body.data[0].displayName).toBe(NAME(901));
            a.h.identityServer.options.down = true;
            const response = await a.search({ sort: "price" });
            expect(response.status).toBe(200);
            expect(response.body.data[0]).toMatchObject({ displayName: NAME(901), profileHydrated: true });
        });

        it("should keep a doctor Identity does not know with profileHydrated false", async () => {
            a.h.identityServer.users.delete(902);
            const response = await a.search({ sort: "price" });
            const missing = response.body.data.find((item: { userId: number }) => item.userId === 902);
            expect(missing).toMatchObject({ displayName: null, avatarUrl: null, profileHydrated: false });
            expect(response.body.data.find((item: { userId: number }) => item.userId === 901).profileHydrated).toBe(true);
        });

        it("should drop a doctor whose Identity status is not active and compute the cursor from the fetched page", async () => {
            a.h.identityServer.users.get(902)!.status = "suspended";
            const response = await a.search({ sort: "price", limit: 3 });
            expect(ids(response.body)).toEqual([901, 903]);
            expect(response.body.meta.count).toBe(2);
            expect(response.body.meta.hasMore).toBe(true);
            expect(response.body.meta.nextCursor).toEqual(expect.any(String));
            const next = await a.search({ sort: "price", limit: 3, cursor: response.body.meta.nextCursor });
            expect(ids(next.body)).toEqual([904]);
            expect(next.body.meta).toMatchObject({ hasMore: false, nextCursor: null, count: 1 });
        });

        it("should not expose the Identity account status on any item", async () => {
            const response = await a.search({ sort: "price" });
            for (const item of response.body.data) expect(item).not.toHaveProperty("status");
        });
    });

    describe("contract conformance", () => {
        it("should return the DoctorProfile shape, the PaginationMeta, the request id and only declared status codes", async () => {
            const specialty = await seedSpecialty("cardiology", "Synthetic Cardiology");
            await doctor({ userId: 1001, fee: 700, languages: ["ar", "en"], specialtyIds: [specialty], years: 12 });
            const required = inlineLists(schemaBlock("DoctorProfile"), "required")[0]!;
            const hydrated = inlineLists(schemaBlock("HydratedUserFields"), "required")[0]!;
            const slotKeys = inlineLists(schemaBlock("Slot"), "required")[0]!;
            const typeKeys = inlineLists(schemaBlock("ConsultationType"), "required")[0]!;
            const specialtyKeys = inlineLists(schemaBlock("SpecialtyRef"), "required")[0]!;
            const allowedSearchKeys = [...required, ...hydrated].sort();

            const search = await a.search({});
            expect(search.status).toBe(200);
            expect(search.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
            expect(search.body.success).toBe(true);
            expectPaginationMeta(search.body.meta);
            const item = search.body.data[0];
            expect(Object.keys(item).sort()).toEqual(allowedSearchKeys);
            expect(item).toMatchObject({ userId: 1001, yearsExperience: 12, languages: ["ar", "en"], consultationFee: { amount: 700, currency: "EGP" },
                timezone: "UTC", isAcceptingPatients: true, displayName: NAME(1001), profileHydrated: true });
            expect(item.nextAvailableAt).toMatch(/Z$/);
            expect(Object.keys(item.specialties[0]).sort()).toEqual([...specialtyKeys].sort());
            expect(Object.keys(item.consultationTypes[0]).sort()).toEqual([...typeKeys].sort());

            const profile = await a.profile(1001);
            expect(profile.status).toBe(200);
            expect(Object.keys(profile.body.data).sort()).toEqual([...allowedSearchKeys, "nextAvailableSlots"].sort());
            for (const slot of profile.body.data.nextAvailableSlots) expect(Object.keys(slot).sort()).toEqual([...slotKeys].sort());
            const adminProfile = await a.profile(1001, "admin");
            expect(Object.keys(adminProfile.body.data).sort()).toEqual([...allowedSearchKeys, "nextAvailableSlots", "status"].sort());

            const observed = new Map<string, number>();
            const record = (path: string, status: number): void => { observed.set(`${path} ${status}`, status); };
            const searchCodes = contractResponseCodes("/api/doctors", "get");
            const profileCodes = contractResponseCodes("/api/doctors/{doctorUserId}", "get");
            const check = async (path: string, codes: string[], request: () => PromiseLike<{ status: number; body: unknown }>, code?: string): Promise<void> => {
                const response = await request();
                record(path, response.status);
                expect(codes).toContain(String(response.status));
                if (code !== undefined) expectErrorEnvelope(response.body, code);
            };
            await check("search", searchCodes, () => a.search({ sort: "bogus" }), "ValidationFailed");
            await check("search", searchCodes, () => a.search({}, "doctor"), "Forbidden");
            await check("search", searchCodes, () => a.getWith("/api/doctors"), "Unauthorized");
            await check("search", searchCodes, () => a.search({ cursor: "tampered.cursor" }), "ValidationFailed");
            await check("profile", profileCodes, () => a.profile(424242), "NotFound");
            await check("profile", profileCodes, () => a.get("/api/doctors/1001?timezone=Nope"), "ValidationFailed");
            await check("profile", profileCodes, () => a.profile(1001, "doctor"), "Forbidden");
            await check("profile", profileCodes, () => a.getWith("/api/doctors/1001"), "Unauthorized");
            expect(searchCodes).not.toContain("404");
            expect(searchCodes).toEqual(expect.arrayContaining(["200", "400", "401", "403", "429", "500"]));
            expect(profileCodes).toEqual(expect.arrayContaining(["200", "400", "401", "403", "404", "429", "500"]));
        });

        it("should answer 429 RateLimited with the declared envelope once the search budget is spent", async () => {
            await doctor({ userId: 1002 });
            const user = await a.h.signFor(1099, "patient", "active");
            let limited: { status: number; body: unknown; headers: Record<string, string> } | undefined;
            let allowed = 0;
            for (let i = 0; i < 130 && limited === undefined; i += 1) {
                const response = await a.getWith("/api/doctors", user);
                if (response.status === 429) limited = response;
                else allowed += 1;
            }
            expect(limited?.status).toBe(429);
            expectErrorEnvelope(limited?.body, "RateLimited");
            expect(Number(limited?.headers["retry-after"])).toBeGreaterThanOrEqual(1);
            // The IP limiter (60 a minute) trips first, and each route owns its own bucket pair: the profile route is still open.
            expect(allowed).toBe(60);
            expect((await a.getWith("/api/doctors/1002", user)).status).toBe(200);
        });
    });

    describe("privacy of logs (AV-R29)", () => {
        it("should write no display name, avatar URL, name query or cursor to the logs when searching with Identity healthy, down, and Redis down", async () => {
            await doctor({ userId: 1101, headline: "Synthetic searchable headline", fee: 100 });
            await doctor({ userId: 1102, headline: "Synthetic searchable headline two", fee: 200 });
            const capture = captureLogs();
            let cursor = "";
            try {
                const first = await a.search({ sort: "price", limit: 1, name: "synthetic searchable" });
                cursor = first.body.meta.nextCursor as string;
                expect(first.status).toBe(200);
                await a.search({ sort: "price", limit: 1, cursor, name: "synthetic searchable" });
                await a.profile(1101);
                a.h.identityServer.options.down = true;
                await a.h.resetRateLimits();
                await a.search({});
                await a.profile(1102, "admin");
                await a.withRedisDown(async () => {
                    expect((await a.search({ name: "synthetic searchable" })).status).toBe(200);
                    expect((await a.profile(1101)).status).toBe(200);
                });
                const window = DateTime.now().plus({ hours: 1 }).toUTC().toISO();
                await a.search({ availableFrom: window });
            } finally { capture.restore(); }
            const text = capture.text();
            expect(capture.lines().length).toBeGreaterThan(3);
            expect(capture.lines().some((line) => line.message === "request_completed")).toBe(true);
            for (const secret of [NAME(1101), NAME(1102), AVATAR(1101), AVATAR(1102), "Dr Fixture Name", "avatar-1101", "synthetic searchable", cursor]) {
                expect(text).not.toContain(secret);
            }
        });
    });
});
