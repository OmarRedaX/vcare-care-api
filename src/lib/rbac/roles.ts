import type { AccountStatus, Role } from "../types/types";

/** Every role a user token may carry (identity parity; equal to the `Role` union — unit-tested). */
export const ROLES: readonly Role[] = ["patient", "doctor", "admin"];

/** Every account status a user token may carry (identity parity; equal to the `AccountStatus` union). */
export const ACCOUNT_STATUSES: readonly AccountStatus[] = ["pending", "active", "rejected", "suspended"];

export function isRole(value: unknown): value is Role {
    return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

export function isAccountStatus(value: unknown): value is AccountStatus {
    return typeof value === "string" && (ACCOUNT_STATUSES as readonly string[]).includes(value);
}
