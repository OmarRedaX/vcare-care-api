import type { Logger } from "../logger/logger";

export type Role = "patient" | "doctor" | "admin";

export type AccountStatus = "pending" | "active" | "rejected" | "suspended";

/** Set by `lib/auth`'s user guard from a verified user token — never from a caller-supplied header. */
export interface AuthContext {
    userId: number;
    role: Role;
    status: AccountStatus;
    emailVerified: boolean;
}

/** Set by `lib/auth`'s service guard from a verified service token. */
export interface ServiceContext {
    clientId: string;
    scopes: string[];
}

export interface RequestExtensions {
    requestId: string;
    log: Logger;
    auth?: AuthContext;
    service?: ServiceContext;
}
