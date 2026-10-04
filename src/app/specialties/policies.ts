import type { SpecialtiesPolicies } from "./types";

export const SPECIALTIES_POLICIES: SpecialtiesPolicies = {
    list: {
        kind: "user",
        roles: ["patient", "doctor", "admin"],
        owner: { kind: "none" },
        accountState: { statuses: { doctor: ["pending", "active", "rejected"] } },
    },
    create: { kind: "user", roles: ["admin"], owner: { kind: "none" }, audit: "admin-action" },
    update: { kind: "user", roles: ["admin"], owner: { kind: "none" }, audit: "admin-action" },
};
