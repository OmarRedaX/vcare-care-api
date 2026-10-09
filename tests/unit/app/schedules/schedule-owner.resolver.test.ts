import type { Knex } from "knex";
import { DoctorProfile } from "../../../../src/app/doctors/entity/doctor-profile.entity";
import { buildScheduleOwnerResolver } from "../../../../src/app/doctors/schedule-owner.resolver";
import type { DoctorsService } from "../../../../src/app/doctors/service/doctors.service";

const profile = (changes: Partial<DoctorProfile> = {}): DoctorProfile => new DoctorProfile({
    id: 9, userId: 202, timezone: "Africa/Cairo", currency: "EGP", suspendedAt: null, ...changes,
});
const conn = { id: "conn" } as unknown as Knex;
const trx = { id: "trx" } as unknown as Knex.Transaction;

describe("buildScheduleOwnerResolver", () => {
    it("should not resolve DoctorsService at construction, only at call time", async () => {
        const getDoctors = jest.fn();
        const resolver = buildScheduleOwnerResolver(getDoctors);
        expect(getDoctors).not.toHaveBeenCalled();
        getDoctors.mockReturnValue({ findProfileForSchedule: jest.fn().mockResolvedValue(profile()) });
        await resolver.find(202, conn);
        expect(getDoctors).toHaveBeenCalledTimes(1);
    });

    it("should map a profile to a ScheduleOwner through findProfileForSchedule with the given connection", async () => {
        const findProfileForSchedule = jest.fn().mockResolvedValue(profile());
        const resolver = buildScheduleOwnerResolver(() => ({ findProfileForSchedule }) as unknown as DoctorsService);
        await expect(resolver.find(202, conn)).resolves.toEqual({ profileId: 9, userId: 202, timezone: "Africa/Cairo", currency: "EGP", isSuspended: false });
        expect(findProfileForSchedule).toHaveBeenCalledWith(202, conn);
    });

    it("should map the lock through lockProfileForSchedule with the transaction and report isSuspended from suspendedAt", async () => {
        const lockProfileForSchedule = jest.fn().mockResolvedValue(profile({ suspendedAt: new Date("2027-01-01T00:00:00Z") }));
        const resolver = buildScheduleOwnerResolver(() => ({ lockProfileForSchedule }) as unknown as DoctorsService);
        await expect(resolver.lock(202, trx)).resolves.toMatchObject({ profileId: 9, isSuspended: true });
        expect(lockProfileForSchedule).toHaveBeenCalledWith(202, trx);
    });

    it("should return undefined when the doctor has no live profile", async () => {
        const doctors = { findProfileForSchedule: jest.fn().mockResolvedValue(undefined), lockProfileForSchedule: jest.fn().mockResolvedValue(undefined) };
        const resolver = buildScheduleOwnerResolver(() => doctors as unknown as DoctorsService);
        await expect(resolver.find(1, conn)).resolves.toBeUndefined();
        await expect(resolver.lock(1, trx)).resolves.toBeUndefined();
    });
});
