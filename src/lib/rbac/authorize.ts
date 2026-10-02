import type { RequestHandler } from "express";
import type { AppError } from "../error/AppError";
import { EmailNotVerified, Forbidden, NotFound, Unauthorized } from "../error/errors";
import { captureRoute, routeLabel } from "../http/route-pattern";
import type { Logger } from "../logger/logger";
import { logger as rootLogger } from "../logger/logger";
import type { AccountStatus } from "../types/types";
import { markAuthorize } from "./markers";
import { isAccountStatus, isRole } from "./roles";
import type { AccessContext, AccessDenialReason, Policy } from "./types";

const NAME_PATTERN = /^[a-z][a-z0-9_]*$/;
const DEFAULT_STATUSES: readonly AccountStatus[] = ["active"];

function invalid(reason: string): Error {
    return new Error(`policy_invalid: ${reason}`);
}

/** Boot-time policy validation: a malformed policy stops the process, it never fails open at request time. */
function assertValidPolicy(policy: Policy): void {
    if (policy.kind !== "user") {
        throw invalid("kind must be user");
    }
    if (policy.roles.length === 0) {
        throw invalid("roles must not be empty");
    }
    if (new Set(policy.roles).size !== policy.roles.length) {
        throw invalid("roles must not repeat");
    }
    if (!policy.roles.every(isRole)) {
        throw invalid("unknown role");
    }

    switch (policy.owner.kind) {
        case "none":
        case "self":
            break;
        case "resolver":
            if (!NAME_PATTERN.test(policy.owner.name)) {
                throw invalid("resolver name must be snake_case");
            }
            break;
        default:
            throw invalid("unknown ownership rule");
    }

    for (const [role, statuses] of Object.entries(policy.accountState?.statuses ?? {})) {
        if (!isRole(role) || !policy.roles.includes(role)) {
            throw invalid(`statuses key ${role} is not a policy role`);
        }
        if (statuses === undefined || statuses.length === 0) {
            throw invalid(`statuses for ${role} must not be empty`);
        }
        if (!statuses.every(isAccountStatus)) {
            throw invalid(`statuses for ${role} contain an unknown status`);
        }
        if (statuses.includes("suspended")) {
            // No Care route admits a suspended account.
            throw invalid(`statuses for ${role} must not contain suspended`);
        }
    }

    const checkNames = new Set<string>();
    for (const check of policy.checks ?? []) {
        if (!NAME_PATTERN.test(check.name)) {
            throw invalid("check name must be snake_case");
        }
        if (checkNames.has(check.name)) {
            throw invalid(`duplicate check ${check.name}`);
        }
        checkNames.add(check.name);
        if (check.appliesTo.length === 0 || !check.appliesTo.every((role) => policy.roles.includes(role))) {
            throw invalid(`check ${check.name} must apply to a non-empty subset of the policy roles`);
        }
    }
}

/** A frozen copy of the path params; Express 5 wildcard params (`*splat`) are arrays of segments, joined by `/`. */
function pathParams(params: Readonly<Record<string, string | string[]>>): Readonly<Record<string, string>> {
    const copy: Record<string, string> = {};
    for (const [name, value] of Object.entries(params)) {
        copy[name] = Array.isArray(value) ? value.join("/") : value;
    }
    return Object.freeze(copy);
}

/**
 * Deny-by-default authorization (access spec §3.4.3; CLAUDE.md → Authorization — RBAC and ownership). Runs after a
 * guard set `req.auth`; decides in this order: principal 401 → role 403 → account status 403 (default `active`;
 * `suspended` never) → email 403 `EmailNotVerified` → policy checks 403 → ownership 404/403. Status, email, and checks
 * run BEFORE ownership, so a caller who may not act at all cannot probe whether a private id exists. Resolvers and
 * checks see only `auth` and the path params, never the body. Each denial logs `access_denied` with a reason and the
 * route pattern — never ids. A resolver or check that throws → 500 through the error handler.
 *
 * Throws at construction (= route registration = boot) for a missing (`route_without_policy`) or invalid
 * (`policy_invalid: …`) policy.
 */
export function authorize(policy: Policy | undefined, logger: Logger = rootLogger): RequestHandler {
    if (policy === undefined) {
        throw new Error("route_without_policy");
    }
    assertValidPolicy(policy);

    const handler: RequestHandler = async (req, res, next) => {
        captureRoute(req, res);

        const deny = (error: AppError, reason: AccessDenialReason): void => {
            logger.info("access_denied", { reason, route: routeLabel(req) });
            next(error);
        };

        const auth = req.auth;
        if (auth === undefined) {
            deny(Unauthorized, "unauthenticated");
            return;
        }
        if (!policy.roles.includes(auth.role)) {
            deny(Forbidden, "role");
            return;
        }
        const statuses = policy.accountState?.statuses?.[auth.role] ?? DEFAULT_STATUSES;
        if (!statuses.includes(auth.status)) {
            deny(Forbidden, "status");
            return;
        }
        if (policy.accountState?.emailVerified === true && !auth.emailVerified) {
            deny(EmailNotVerified, "email_unverified");
            return;
        }

        const ctx: AccessContext = { auth: { ...auth }, params: pathParams(req.params) };

        for (const check of policy.checks ?? []) {
            if (!check.appliesTo.includes(auth.role)) {
                continue;
            }
            const outcome = await check.run(ctx);
            if (outcome !== "allow") {
                // `deny-forbidden` or anything unexpected: fail closed.
                deny(Forbidden, `check:${check.name}`);
                return;
            }
        }

        if (policy.owner.kind === "resolver") {
            const decision = await policy.owner.resolve(ctx);
            if (decision === "deny-not-found") {
                deny(NotFound, "ownership_not_found");
                return;
            }
            if (decision === "deny-forbidden") {
                deny(Forbidden, "ownership_forbidden");
                return;
            }
            if (decision !== "allow") {
                deny(Forbidden, "ownership_unknown");
                return;
            }
        }

        next();
    };

    return markAuthorize(handler);
}
