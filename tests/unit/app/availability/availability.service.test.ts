import { DateTime } from "luxon";
import { AvailabilityService } from "../../../../src/app/availability/service/availability.service";
import type { NextAvailableIndex } from "../../../../src/app/availability/service/next-available.index";
import type { SlotInputsLoader } from "../../../../src/app/availability/service/slot-inputs.loader";
import type { DoctorDiscoveryReader } from "../../../../src/app/doctors/service/doctor-discovery.reader";
import type { PatientsService } from "../../../../src/app/patients/service/patients.service";
import type { SchedulesService } from "../../../../src/app/schedules/service/schedules.service";
import type { Env } from "../../../../src/lib/config/types";
import type { AuthContext } from "../../../../src/lib/types/types";

const now = DateTime.fromISO("2027-01-04T08:00:00Z").toMillis();
const from = DateTime.fromMillis(now).plus({ hours: 1 }).toISO()!;
const to = DateTime.fromMillis(now).plus({ hours: 3 }).toISO()!;
const patient: AuthContext = { userId: 101, role: "patient", status: "active", emailVerified: true };
const doctor = { profileId: 9, userId: 202, timezone: "UTC", bookableBase: true };
const type = { id: 7, durationMinutes: 30 };

describe("AvailabilityService.getSlots (AV-R1, AV-R6, AV-R7, AV-R9, AV-R12)", () => {
    function setup() {
        const findForSlots = jest.fn().mockResolvedValue(doctor);
        const findBookableType = jest.fn().mockResolvedValue(type);
        const findProfile = jest.fn().mockResolvedValue({ timezone: "Africa/Cairo" });
        const loadForSlots = jest.fn().mockResolvedValue({ timezone: "UTC", weekly: [{ weekday: 1, intervals: [{ startMinute: 540, endMinute: 660 }] }],
            exceptions: [], busy: [], durationMinutes: 30, typeId: 7 });
        const version = jest.fn().mockResolvedValue({ version: "2", usable: true });
        const readSlots = jest.fn().mockResolvedValue(undefined);
        const writeSlots = jest.fn().mockResolvedValue(undefined);
        const service = new AvailabilityService(
            { findForSlots } as unknown as DoctorDiscoveryReader, { findBookableType } as unknown as SchedulesService,
            { findProfile } as unknown as PatientsService, { loadForSlots } as unknown as SlotInputsLoader,
            { version, readSlots, writeSlots } as unknown as NextAvailableIndex,
            { BOOKING_HORIZON_DAYS: 60 } as Env, { now: () => now });
        return { service, findForSlots, findBookableType, findProfile, loadForSlots, version, readSlots, writeSlots };
    }

    it("should reject invalid windows before reading either owner", async () => {
        const s = setup();
        await expect(s.service.getSlots(patient, 202, { typeId: 7, from: to, to: from })).rejects.toMatchObject({ code: "ValidationFailed" });
        await expect(s.service.getSlots(patient, 202, { typeId: 7, from, to: DateTime.fromMillis(now).plus({ days: 15 }).toISO()! })).rejects.toMatchObject({ code: "ValidationFailed" });
        expect(s.findForSlots).not.toHaveBeenCalled();
    });

    it("should conceal unknown doctor, type, and non-bookable doctor as 404", async () => {
        const s = setup();
        s.findForSlots.mockResolvedValueOnce(undefined);
        await expect(s.service.getSlots(patient, 202, { typeId: 7, from, to })).rejects.toMatchObject({ code: "NotFound" });
        s.findBookableType.mockResolvedValueOnce(undefined);
        await expect(s.service.getSlots(patient, 202, { typeId: 7, from, to })).rejects.toMatchObject({ code: "NotFound" });
        s.findForSlots.mockResolvedValueOnce({ ...doctor, bookableBase: false });
        await expect(s.service.getSlots(patient, 202, { typeId: 7, from, to })).rejects.toMatchObject({ code: "NotFound" });
        expect(s.loadForSlots).not.toHaveBeenCalled();
    });

    it("should return an empty clipped window without loading inputs", async () => {
        const s = setup();
        const result = await s.service.getSlots(patient, 202, { typeId: 7, from: DateTime.fromMillis(now - 3_600_000).toISO()!, to: DateTime.fromMillis(now - 1_800_000).toISO()! });
        expect(result).toMatchObject({ fromMs: now, toMs: now, slots: [] });
        expect(s.loadForSlots).not.toHaveBeenCalled();
    });

    it("should use a viewer-independent UTC cache and render in the patient zone", async () => {
        const s = setup();
        const startMs = DateTime.fromISO("2027-01-04T09:00:00Z").toMillis();
        s.readSlots.mockResolvedValueOnce([{ startMs, endMs: startMs + 1_800_000 }]);
        const result = await s.service.getSlots(patient, 202, { typeId: 7, from, to });
        expect(result.slots).toHaveLength(1);
        expect(result.timezone).toBe("Africa/Cairo");
        expect(s.loadForSlots).not.toHaveBeenCalled();
        expect(s.readSlots).toHaveBeenCalledWith(202, "2", 7, "2027-01-04", "2027-01-04");
        const admin = await s.service.getSlots({ ...patient, role: "admin" }, 202, { typeId: 7, from, to, timezone: "America/New_York" });
        expect(admin.timezone).toBe("America/New_York");
        expect(s.findProfile).toHaveBeenCalledTimes(1);
    });

    it("should compute from owner readers when the cache is unusable", async () => {
        const s = setup();
        s.version.mockResolvedValue({ version: "0", usable: false });
        const result = await s.service.getSlots(patient, 202, { typeId: 7, from, to });
        expect(result.slots.map((slot) => slot.startMs)).toEqual([DateTime.fromISO("2027-01-04T09:00:00Z").toMillis(),
            DateTime.fromISO("2027-01-04T09:30:00Z").toMillis(), DateTime.fromISO("2027-01-04T10:00:00Z").toMillis(),
            DateTime.fromISO("2027-01-04T10:30:00Z").toMillis()]);
        expect(s.readSlots).not.toHaveBeenCalled();
        expect(s.writeSlots).not.toHaveBeenCalled();
    });
});
