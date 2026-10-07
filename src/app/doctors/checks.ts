import type { AccessCheck } from "../../lib/rbac/types";
import type { DoctorsService } from "./service/doctors.service";

export function doctorNotSuspendedCheck(service: Pick<DoctorsService, "isLocallySuspended">): AccessCheck {
    return { name: "doctor_not_suspended", appliesTo: ["doctor"],
        run: async ({ auth }) => await service.isLocallySuspended(auth.userId) ? "deny-forbidden" : "allow" };
}
