import type { AvailabilityPolicies } from "./types";

export const AVAILABILITY_POLICIES: AvailabilityPolicies = {
    slots: { kind: "user", roles: ["patient", "admin"], owner: { kind: "none" } },
};
