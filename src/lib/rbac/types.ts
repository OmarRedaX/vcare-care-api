import type { AccountStatus, AuthContext, Role } from "../types/types";

/** What an ownership resolver decides. `deny-not-found` hides a private resource's existence (404). */
export type OwnershipDecision = "allow" | "deny-not-found" | "deny-forbidden";

/**
 * Everything a resolver or check may see: the verified principal and the path params. Never the request body, so a
 * body id can never influence an ownership decision (A10).
 */
export interface AccessContext {
    auth: AuthContext;
    params: Readonly<Record<string, string>>;
}

export type OwnershipResolver = (ctx: AccessContext) => Promise<OwnershipDecision>;

export type OwnershipRule =
    /** The role check is sufficient (`x-ownership: none`). */
    | { kind: "none" }
    /** `/me` routes: the service acts only on `auth.userId`. */
    | { kind: "self" }
    /** DB-backed predicate (`x-ownership: <name>`). */
    | { kind: "resolver"; name: string; resolve: OwnershipResolver };

/** An extra DB-backed condition (e.g. the doctors module's `doctor_not_suspended`). */
export interface AccessCheck {
    /** snake_case; logged as the `access_denied` reason `check:<name>`. */
    name: string;
    appliesTo: readonly Role[];
    run: (ctx: AccessContext) => Promise<"allow" | "deny-forbidden">;
}

export interface AccountStateRule {
    /** Allowed token statuses per listed role; default `["active"]`. `suspended` is never allowed. */
    statuses?: Partial<Record<Role, readonly AccountStatus[]>>;
    /** `true` → a token with `ev=false` gets `403 EmailNotVerified`. */
    emailVerified?: boolean;
}

/** Declarative (mirrors `x-audit`); the module's service writes the rows. */
export type AuditClass = "clinical-read" | "clinical-write" | "admin-action";

export interface UserPolicy {
    kind: "user";
    /** Explicit; no wildcard — a new role gets nothing until a policy names it. */
    roles: readonly Role[];
    /** Mandatory, even when `{ kind: "none" }`. */
    owner: OwnershipRule;
    accountState?: AccountStateRule;
    checks?: readonly AccessCheck[];
    audit?: AuditClass;
}

/** The doctors module adds `ServicePolicy` (`{ kind: "service"; scope }`) with the service guard. */
export type Policy = UserPolicy;

/** The `access_denied` log reason (never ids). */
export type AccessDenialReason =
    | "unauthenticated"
    | "role"
    | "status"
    | "email_unverified"
    | `check:${string}`
    | "ownership_not_found"
    | "ownership_forbidden"
    | "ownership_unknown";

/** The minimal Express 5 router-layer view `assertRoutesAuthorized` reads. */
export interface RouteLayer {
    handle?: unknown;
    /** The handler's function name (Express sets it); used only in boot error messages. */
    name?: string;
    /** On a route's own stack: the lower-case verb, or `undefined` for `.all(...)`. */
    method?: string;
    route?: {
        path?: unknown;
        methods?: Record<string, boolean | undefined>;
        stack?: readonly RouteLayer[];
    };
}

/** One method's handler chain of a route, as Express dispatches it (`.all` entries interleaved in order). */
export interface RouteChain {
    label: string;
    handlers: readonly unknown[];
}
