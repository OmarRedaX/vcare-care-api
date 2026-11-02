import type { AccountStateRule } from "../../lib/rbac/types";
import type { HelpArticlesPolicies } from "./types";

/**
 * Reading help is not a practising action: a doctor applying (pending) or fixing a rejected application needs the platform rules
 * (ADR 0027 D4, same allowance as GET /specialties). Patient and admin default to active. A suspended token is never admitted.
 * Row visibility (published, own audience, live) is a query predicate on the verified role, not an ownership resolver.
 */
const READER_STATES: AccountStateRule = { statuses: { doctor: ["pending", "active", "rejected"] } };

export const HELP_ARTICLES_POLICIES: HelpArticlesPolicies = {
    list: { kind: "user", roles: ["patient", "doctor", "admin"], owner: { kind: "none" }, accountState: READER_STATES },
    get: { kind: "user", roles: ["patient", "doctor", "admin"], owner: { kind: "none" }, accountState: READER_STATES },
    create: { kind: "user", roles: ["admin"], owner: { kind: "none" }, audit: "admin-action" },
    update: { kind: "user", roles: ["admin"], owner: { kind: "none" }, audit: "admin-action" },
    remove: { kind: "user", roles: ["admin"], owner: { kind: "none" }, audit: "admin-action" },
};
