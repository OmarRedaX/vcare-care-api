import { AvailabilityChangeListener } from "../../../../src/app/availability/service/availability-change.listener";
import type { NextAvailableIndex } from "../../../../src/app/availability/service/next-available.index";
import { DoctorChangeKind } from "../../../../src/app/doctors/enums";

describe("AvailabilityChangeListener", () => {
    it("should delegate all three change ports to the same doctor index", async () => {
        const invalidate = jest.fn().mockResolvedValue(undefined);
        const listener = new AvailabilityChangeListener({ invalidate } as unknown as NextAvailableIndex);
        await listener.onScheduleChanged({ doctorProfileId: 9, doctorUserId: 202, kind: "working_hours" as never });
        await listener.onConsultationChanged({ doctorUserId: 203, consultationId: 1, kind: "booked" as never });
        await listener.onDoctorChanged({ doctorUserId: 204, kind: DoctorChangeKind.TimezoneChanged });
        expect(invalidate.mock.calls).toEqual([[202], [203], [204]]);
    });

    it("should resolve every port when the index rejects unexpectedly", async () => {
        const invalidate = jest.fn().mockRejectedValue(new Error("synthetic Redis failure"));
        const listener = new AvailabilityChangeListener({ invalidate } as unknown as NextAvailableIndex);
        await expect(listener.onScheduleChanged({ doctorProfileId: 9, doctorUserId: 202, kind: "working_hours" as never })).resolves.toBeUndefined();
        await expect(listener.onConsultationChanged({ doctorUserId: 202, consultationId: 1, kind: "booked" as never })).resolves.toBeUndefined();
        await expect(listener.onDoctorChanged({ doctorUserId: 202, kind: DoctorChangeKind.TimezoneChanged })).resolves.toBeUndefined();
        expect(invalidate).toHaveBeenCalledTimes(3);
    });
});
