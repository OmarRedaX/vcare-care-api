import { doctorNotSuspendedCheck } from "../doctors/checks";
import type { DoctorsService } from "../doctors/service/doctors.service";
import type { SchedulesPolicies } from "./types";

/**
 * Roles `doctor`, ownership `self`, token `status=active` and the live local-suspension check on all eight routes
 * (`x-roles`, `x-ownership`, `x-account-state`). `audit: "admin-action"` mirrors `x-audit` on the operations that can
 * affect bookings.
 */
export function buildSchedulesPolicies(doctors: Pick<DoctorsService, "isLocallySuspended">): SchedulesPolicies {
    const base = {
        kind: "user" as const, roles: ["doctor"] as const, owner: { kind: "self" as const },
        accountState: { statuses: { doctor: ["active"] as const } }, checks: [doctorNotSuspendedCheck(doctors)],
    };
    return {
        getWorkingHours: base,
        replaceWorkingHours: { ...base, audit: "admin-action" },
        listExceptions: base,
        createException: { ...base, audit: "admin-action" },
        deleteException: { ...base, audit: "admin-action" },
        listTypes: base,
        createType: base,
        updateType: base,
    };
}
