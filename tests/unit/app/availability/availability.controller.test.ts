import type { Request, Response } from "express";
import { AvailabilityController } from "../../../../src/app/availability/controller/availability.controller";
import type { AvailabilityService } from "../../../../src/app/availability/service/availability.service";
import type { DiscoveryService } from "../../../../src/app/availability/service/discovery.service";

describe("AvailabilityController.slots", () => {
    const start = Date.parse("2027-01-04T09:00:00Z");
    const query = { typeId: "7", from: "2027-01-04T08:00:00Z", to: "2027-01-04T11:00:00Z", timezone: "Africa/Cairo" };
    const auth = { userId: 101, role: "patient", status: "active", emailVerified: true };

    function setup() {
        const getSlots = jest.fn().mockResolvedValue({ slots: [{ startMs: start, endMs: start + 1_800_000 }],
            fromMs: start - 3_600_000, toMs: start + 7_200_000, timezone: "Africa/Cairo", doctorTimezone: "UTC" });
        const controller = new AvailabilityController({ getSlots } as unknown as AvailabilityService, {} as unknown as DiscoveryService);
        const req = { params: { doctorUserId: "202" }, query, auth } as unknown as Request;
        const json = jest.fn();
        const status = jest.fn().mockReturnValue({ json });
        const res = { status } as unknown as Response;
        return { controller, req, status, json, getSlots, res };
    }

    it("should validate and delegate a slots query then render the response and window metadata", async () => {
        const s = setup();
        await s.controller.slots(s.req, s.res);
        expect(s.getSlots).toHaveBeenCalledWith(auth, 202, { typeId: 7, from: query.from, to: query.to, timezone: "Africa/Cairo" });
        expect(s.status).toHaveBeenCalledWith(200);
        expect(s.json).toHaveBeenCalledWith({ success: true, data: [{ startsAt: "2027-01-04T09:00:00.000Z", endsAt: "2027-01-04T09:30:00.000Z",
            startsAtLocal: expect.any(String), endsAtLocal: expect.any(String), timezone: "Africa/Cairo" }],
        meta: { from: "2027-01-04T08:00:00.000Z", to: "2027-01-04T11:00:00.000Z", timezone: "Africa/Cairo", doctorTimezone: "UTC", count: 1 } });
    });

    it("should reject an invalid doctor id before the service is called", async () => {
        const s = setup();
        s.req.params.doctorUserId = "bad";
        await expect(s.controller.slots(s.req, s.res)).rejects.toMatchObject({ code: "NotFound" });
        expect(s.getSlots).not.toHaveBeenCalled();
    });

    it("should reject an invalid query before the service is called", async () => {
        const s = setup();
        s.req.query.typeId = "invalid";
        await expect(s.controller.slots(s.req, s.res)).rejects.toMatchObject({ code: "ValidationFailed" });
        expect(s.getSlots).not.toHaveBeenCalled();
    });
});

describe("AvailabilityController.search and getDoctor", () => {
    const auth = { userId: 101, role: "patient", status: "active", emailVerified: true };
    const view = {
        profile: { id: 9, userId: 202, headline: "Synthetic headline", bio: null, yearsExperience: 4, consultationFeeAmount: 150, currency: "EGP", timezone: "Africa/Cairo", isAcceptingPatients: true },
        languages: ["ar", "en"], specialties: [{ id: 3, slug: "cardiology", name: "Cardiology", isPrimary: true }], bookable: true,
        activeTypes: [{ id: 5, name: "First visit", durationMinutes: 30, price: 150, currency: "EGP", isActive: true, createdAt: new Date(0), updatedAt: new Date(0) }],
    };

    function setup() {
        const search = jest.fn().mockResolvedValue({ items: [{ view, nextAvailableAt: Date.parse("2027-01-04T09:00:00Z") }], hydrated: new Map(),
            meta: { nextCursor: null, hasMore: false, count: 1, degraded: ["sort"] } });
        const getDoctor = jest.fn().mockResolvedValue({ view, hydrated: { displayName: "Synthetic Name", avatarUrl: null, status: "active" }, nextAvailableAt: null,
            slots: [{ startMs: Date.parse("2027-01-04T09:00:00Z"), endMs: Date.parse("2027-01-04T09:30:00Z") }], timezone: "Africa/Cairo", admin: true });
        const controller = new AvailabilityController({} as unknown as AvailabilityService, { search, getDoctor } as unknown as DiscoveryService);
        const req = { params: { doctorUserId: "202" }, query: {}, auth } as unknown as Request;
        const json = jest.fn();
        const status = jest.fn().mockReturnValue({ json });
        return { controller, req, res: { status } as unknown as Response, search, getDoctor, json, status };
    }

    it("should validate the query, delegate and render items with hydration flags and meta.degraded", async () => {
        const s = setup();
        s.req.query = { sort: "price", limit: "5", minFee: "10", name: "an" };
        await s.controller.search(s.req, s.res);
        expect(s.search).toHaveBeenCalledWith(expect.objectContaining({ sort: "price", limit: 5, minFee: 10, name: "an" }));
        const body = s.json.mock.calls[0]?.[0] as { success: boolean; data: Array<Record<string, unknown>>; meta: Record<string, unknown> };
        expect(body.success).toBe(true);
        expect(body.data[0]).toMatchObject({ userId: 202, displayName: null, avatarUrl: null, profileHydrated: false, nextAvailableAt: "2027-01-04T09:00:00.000Z", languages: ["ar", "en"] });
        expect(body.data[0]).not.toHaveProperty("nextAvailableSlots");
        expect(body.data[0]).not.toHaveProperty("status");
        expect(body.meta).toEqual({ nextCursor: null, hasMore: false, count: 1, degraded: ["sort"] });
    });

    it("should default the sort and the limit when the query is empty", async () => {
        const s = setup();
        await s.controller.search(s.req, s.res);
        expect(s.search).toHaveBeenCalledWith(expect.objectContaining({ sort: "earliest_availability", limit: 20 }));
    });

    it.each([{ unknown: "x" }, { sort: "rating" }, { limit: "0" }, { minFee: "-1" }, { language: "arabic" }, { name: "a" }, { name: "a\u0007b" }, { availableFrom: "tomorrow" }, { specialty: "" }])(
        "should reject the invalid search query %j before the service is called", async (query) => {
            const s = setup();
            s.req.query = query;
            await expect(s.controller.search(s.req, s.res)).rejects.toMatchObject({ code: "ValidationFailed" });
            expect(s.search).not.toHaveBeenCalled();
        });

    it("should render the profile with the slots preview in the caller zone and the admin status", async () => {
        const s = setup();
        s.req.query = { timezone: "Africa/Cairo" };
        await s.controller.getDoctor(s.req, s.res);
        expect(s.getDoctor).toHaveBeenCalledWith(auth, 202, { timezone: "Africa/Cairo" });
        const body = s.json.mock.calls[0]?.[0] as { data: Record<string, unknown> };
        expect(body.data).toMatchObject({ userId: 202, displayName: "Synthetic Name", profileHydrated: true, status: "bookable",
            nextAvailableSlots: [{ startsAt: "2027-01-04T09:00:00.000Z", timezone: "Africa/Cairo" }] });
        expect(body.data).not.toHaveProperty("defaultSlotMinutes");
        expect(body.data).not.toHaveProperty("verificationStatus");
    });

    it("should answer 404 for a path id that is not a positive integer and 400 for a bad timezone, without calling the service", async () => {
        const s = setup();
        s.req.params.doctorUserId = "me";
        await expect(s.controller.getDoctor(s.req, s.res)).rejects.toMatchObject({ code: "NotFound" });
        s.req.params.doctorUserId = "202";
        s.req.query = { timezone: "Not/AZone" };
        await expect(s.controller.getDoctor(s.req, s.res)).rejects.toMatchObject({ code: "ValidationFailed" });
        s.req.query = { timezone: "x".repeat(65) };
        await expect(s.controller.getDoctor(s.req, s.res)).rejects.toMatchObject({ code: "ValidationFailed" });
        expect(s.getDoctor).not.toHaveBeenCalled();
    });
});
