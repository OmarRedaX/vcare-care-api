import type { Knex } from "knex";
import type { ScheduleOwner, ScheduleOwnerResolver } from "../schedules/types";
import type { DoctorProfile } from "./entity/doctor-profile.entity";
import type { DoctorsService } from "./service/doctors.service";

function toOwner(profile: DoctorProfile | undefined): ScheduleOwner | undefined {
    return profile === undefined ? undefined : {
        profileId: profile.id, userId: profile.userId, timezone: profile.timezone, currency: profile.currency,
        isSuspended: profile.suspendedAt !== null,
    };
}

/**
 * `schedules` needs the caller's profile from `doctors`, while `doctors` needs `schedules` for `isBookable`.
 * The `DoctorsService` lookup is lazy (at call time), so neither constructor needs the other at construction.
 */
export function buildScheduleOwnerResolver(getDoctors: () => DoctorsService): ScheduleOwnerResolver {
    return {
        async find(userId: number, conn: Knex): Promise<ScheduleOwner | undefined> {
            return toOwner(await getDoctors().findProfileForSchedule(userId, conn));
        },
        async lock(userId: number, trx: Knex.Transaction): Promise<ScheduleOwner | undefined> {
            return toOwner(await getDoctors().lockProfileForSchedule(userId, trx));
        },
    };
}
