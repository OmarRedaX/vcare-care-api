import type { Request, Response } from "express";
import { AvailabilityController } from "../../../../src/app/availability/controller/availability.controller";
import type { AvailabilityService } from "../../../../src/app/availability/service/availability.service";

describe("AvailabilityController.slots", () => {
    const start = Date.parse("2027-01-04T09:00:00Z");
    const query = { typeId: "7", from: "2027-01-04T08:00:00Z", to: "2027-01-04T11:00:00Z", timezone: "Africa/Cairo" };
    const auth = { userId: 101, role: "patient", status: "active", emailVerified: true };

    function setup() {
        const getSlots = jest.fn().mockResolvedValue({ slots: [{ startMs: start, endMs: start + 1_800_000 }],
            fromMs: start - 3_600_000, toMs: start + 7_200_000, timezone: "Africa/Cairo", doctorTimezone: "UTC" });
        const controller = new AvailabilityController({ getSlots } as unknown as AvailabilityService);
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
