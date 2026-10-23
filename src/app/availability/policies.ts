import type { AvailabilityPolicies } from "./types";

/** Discovery data is public to patients and admins (ownership none); the doctor role is refused by `authorize`. */
export const AVAILABILITY_POLICIES: AvailabilityPolicies = {
    slots: { kind: "user", roles: ["patient", "admin"], owner: { kind: "none" } },
    search: { kind: "user", roles: ["patient", "admin"], owner: { kind: "none" } },
    getDoctor: { kind: "user", roles: ["patient", "admin"], owner: { kind: "none" } },
};
