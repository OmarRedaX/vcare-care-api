import type { PatientsPolicies } from "./types";

export const PATIENTS_POLICIES: PatientsPolicies = {
    getMe: { kind: "user", roles: ["patient"], owner: { kind: "self" }, audit: "clinical-read" },
    updateMe: { kind: "user", roles: ["patient"], owner: { kind: "self" }, audit: "clinical-write" },
};
