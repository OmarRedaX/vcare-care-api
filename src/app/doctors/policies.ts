import { doctorNotSuspendedCheck } from "./checks";
import type { DoctorsService } from "./service/doctors.service";
import type { DoctorsPolicies } from "./types";

export function buildDoctorsPolicies(service: Pick<DoctorsService, "isLocallySuspended">): DoctorsPolicies {
    const accountState = { statuses: { doctor: ["pending", "active", "rejected"] as const } };
    return {
        apply: { kind: "user", roles: ["doctor"], owner: { kind: "self" }, accountState },
        getMe: { kind: "user", roles: ["doctor"], owner: { kind: "self" }, accountState },
        updateMe: { kind: "user", roles: ["doctor"], owner: { kind: "self" }, accountState,
            checks: [doctorNotSuspendedCheck(service)] },
        getApplication: { kind: "user", roles: ["doctor"], owner: { kind: "self" }, accountState },
    };
}
