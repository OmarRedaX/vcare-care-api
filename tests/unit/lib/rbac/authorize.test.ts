import express from "express";
import type { RequestHandler } from "express";
import request from "supertest";
import { errorHandler } from "../../../../src/lib/error/errorHandler";
import { logger as rootLogger } from "../../../../src/lib/logger/logger";
import { authorize } from "../../../../src/lib/rbac/authorize";
import { isAuthorizeHandler, isGuardHandler } from "../../../../src/lib/rbac/markers";
import type { AccessCheck, AccessContext, OwnershipDecision, UserPolicy } from "../../../../src/lib/rbac/types";
import { requestId } from "../../../../src/lib/request-id/request-id";
import type { AccountStatus, AuthContext, Role } from "../../../../src/lib/types/types";
import { fakeLogger } from "../../../helpers/fake-logger";

function auth(role: Role, overrides?: Partial<AuthContext>): AuthContext {
    return { userId: 101, role, status: "active", emailVerified: true, ...overrides };
}

/**
 * Unit harness: a stand-in guard puts the principal on `req.auth` (the real guard is tested separately), then
 * `authorize(policy)` and a 200 handler. The logger is a collaborator (fake).
 */
function harness(policy: UserPolicy, principal: AuthContext | undefined) {
    const log = fakeLogger();
    const handled = jest.fn();
    const app = express();
    app.use(requestId());
    app.use(express.json());
    const setAuth: RequestHandler = (req, _res, next) => {
        if (principal !== undefined) {
            req.auth = principal;
        }
        next();
    };
    const all = express.Router();
    all.get("/things/:id", setAuth, authorize(policy, log.logger), (_req, res) => {
        handled();
        res.json({ ok: true });
    });
    all.post("/things/:id", setAuth, authorize(policy, log.logger), (_req, res) => {
        handled();
        res.json({ ok: true });
    });
    app.use("/api", all);
    app.use(errorHandler);
    return { app, log, handled };
}

const base = (overrides?: Partial<UserPolicy>): UserPolicy => ({
    kind: "user",
    roles: ["patient", "doctor", "admin"],
    owner: { kind: "none" },
    ...overrides,
});

const resolverReturning = (decision: string) =>
    jest.fn((_ctx: AccessContext) => Promise.resolve(decision as OwnershipDecision));

describe("lib/rbac/authorize — construction (A8)", () => {
    it("should throw route_without_policy when the policy is undefined", () => {
        expect(() => authorize(undefined)).toThrow("route_without_policy");
    });

    const check = (name: string, appliesTo: Role[]): AccessCheck => ({
        name,
        appliesTo,
        run: () => Promise.resolve("allow"),
    });

    it.each<[string, () => UserPolicy]>([
        ["kind is not user", () => ({ ...base(), kind: "service" }) as unknown as UserPolicy],
        ["roles are empty", () => base({ roles: [] })],
        ["roles repeat", () => base({ roles: ["admin", "admin"] })],
        ["a role is unknown", () => base({ roles: ["superuser" as Role] })],
        ["the ownership kind is unknown", () => base({ owner: { kind: "anyone" } as unknown as UserPolicy["owner"] })],
        [
            "a resolver name is not snake_case",
            () => base({ owner: { kind: "resolver", name: "Owner-Check", resolve: resolverReturning("allow") } }),
        ],
        ["a statuses key is not a policy role", () => base({ roles: ["doctor"], accountState: { statuses: { patient: ["active"] } } })],
        ["a status list is empty", () => base({ accountState: { statuses: { doctor: [] } } })],
        ["a status is unknown", () => base({ accountState: { statuses: { doctor: ["banned" as AccountStatus] } } })],
        ["a status list contains suspended", () => base({ accountState: { statuses: { doctor: ["active", "suspended"] } } })],
        ["a check applies to no role", () => base({ checks: [check("blocked", [])] })],
        ["a check applies to a role outside the policy", () => base({ roles: ["doctor"], checks: [check("blocked", ["patient"])] })],
        ["check names repeat", () => base({ checks: [check("blocked", ["doctor"]), check("blocked", ["admin"])] })],
        ["a check name is not snake_case", () => base({ checks: [check("Blocked", ["doctor"])] })],
    ])("should throw policy_invalid when %s", (_label, make) => {
        expect(() => authorize(make())).toThrow(/^policy_invalid: /);
    });

    it("should return a handler carrying AUTHORIZE_MARKER and not GUARD_MARKER", () => {
        const handler = authorize(base());
        expect(isAuthorizeHandler(handler)).toBe(true);
        expect(isGuardHandler(handler)).toBe(false);
    });
});

describe("lib/rbac/authorize — per request (A9, A10)", () => {
    it("should return 401 Unauthorized when req.auth is missing", async () => {
        const { app, handled, log } = harness(base(), undefined);
        const res = await request(app).get("/api/things/1");
        expect(res.status).toBe(401);
        expect(res.body.error.code).toBe("Unauthorized");
        expect(handled).not.toHaveBeenCalled();
        expect(log.info).toHaveBeenCalledWith("access_denied", { reason: "unauthenticated", route: "GET /api/things/:id" });
    });

    it("should return 403 Forbidden when the role is not listed", async () => {
        const { app, log } = harness(base({ roles: ["admin"] }), auth("patient"));
        const res = await request(app).get("/api/things/1");
        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe("Forbidden");
        expect(log.info).toHaveBeenCalledWith("access_denied", { reason: "role", route: "GET /api/things/:id" });
    });

    it.each<[AccountStatus, number]>([
        ["active", 200],
        ["pending", 403],
        ["rejected", 403],
        ["suspended", 403],
    ])("should default to active only: status %s → %i", async (status, expected) => {
        const { app } = harness(base(), auth("doctor", { status }));
        expect((await request(app).get("/api/things/1")).status).toBe(expected);
    });

    it.each<[AccountStatus, number]>([
        ["pending", 200],
        ["active", 200],
        ["rejected", 200],
        ["suspended", 403],
    ])("should apply per-role statuses for onboarding policies: doctor %s → %i", async (status, expected) => {
        const onboarding = base({ roles: ["doctor"], accountState: { statuses: { doctor: ["pending", "active", "rejected"] } } });
        const { app, log } = harness(onboarding, auth("doctor", { status }));
        const res = await request(app).get("/api/things/1");
        expect(res.status).toBe(expected);
        if (expected === 403) {
            expect(res.body.error.code).toBe("Forbidden");
            expect(log.info).toHaveBeenCalledWith("access_denied", expect.objectContaining({ reason: "status" }));
        }
    });

    it("should keep the default active-only rule for a role without its own status list", async () => {
        const policy = base({ roles: ["doctor", "patient"], accountState: { statuses: { doctor: ["pending", "active"] } } });
        expect((await request(harness(policy, auth("patient", { status: "pending" })).app).get("/api/things/1")).status).toBe(403);
        expect((await request(harness(policy, auth("doctor", { status: "pending" })).app).get("/api/things/1")).status).toBe(200);
    });

    it("should return 403 EmailNotVerified when emailVerified is required and ev is false", async () => {
        const policy = base({ roles: ["patient"], accountState: { emailVerified: true } });
        const denied = await request(harness(policy, auth("patient", { emailVerified: false })).app).get("/api/things/1");
        expect(denied.status).toBe(403);
        expect(denied.body.error).toMatchObject({ code: "EmailNotVerified", message: "Verify your email before booking" });
        expect((await request(harness(policy, auth("patient")).app).get("/api/things/1")).status).toBe(200);
        // Without the requirement, ev=false is irrelevant.
        expect((await request(harness(base(), auth("patient", { emailVerified: false })).app).get("/api/things/1")).status).toBe(200);
    });

    it("should run only the checks that apply to the role and deny with Forbidden", async () => {
        const run = jest.fn((ctx: AccessContext): Promise<"allow" | "deny-forbidden"> =>
            Promise.resolve(ctx.auth.userId === 9001 ? "deny-forbidden" : "allow"),
        );
        const policy = base({ roles: ["doctor", "admin"], checks: [{ name: "test_blocked_doctor", appliesTo: ["doctor"], run }] });

        const blocked = harness(policy, auth("doctor", { userId: 9001 }));
        const res = await request(blocked.app).get("/api/things/1");
        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe("Forbidden");
        expect(blocked.log.info).toHaveBeenCalledWith("access_denied", {
            reason: "check:test_blocked_doctor",
            route: "GET /api/things/:id",
        });

        expect((await request(harness(policy, auth("doctor", { userId: 7 })).app).get("/api/things/1")).status).toBe(200);
        run.mockClear();
        expect((await request(harness(policy, auth("admin", { userId: 9001 })).app).get("/api/things/1")).status).toBe(200);
        expect(run).not.toHaveBeenCalled(); // the check does not apply to admins
    });

    it("should deny with Forbidden when a check returns an unexpected value (fail closed)", async () => {
        const run = jest.fn(() => Promise.resolve("maybe" as "allow"));
        const policy = base({ checks: [{ name: "odd_check", appliesTo: ["patient"], run }] });
        expect((await request(harness(policy, auth("patient")).app).get("/api/things/1")).status).toBe(403);
    });

    it.each<[string, number, string | undefined, string]>([
        ["allow", 200, undefined, ""],
        ["deny-not-found", 404, "NotFound", "ownership_not_found"],
        ["deny-forbidden", 403, "Forbidden", "ownership_forbidden"],
        ["perhaps", 403, "Forbidden", "ownership_unknown"],
    ])("should map the resolver decision %p to %i", async (decision, status, code, reason) => {
        const resolve = resolverReturning(decision);
        const { app, log } = harness(base({ owner: { kind: "resolver", name: "test_owner", resolve } }), auth("patient"));
        const res = await request(app).get("/api/things/42");
        expect(res.status).toBe(status);
        if (code !== undefined) {
            expect(res.body.error.code).toBe(code);
            expect(log.info).toHaveBeenCalledWith("access_denied", { reason, route: "GET /api/things/:id" });
        }
        expect(resolve).toHaveBeenCalledTimes(1);
    });

    it("should not call a resolver for none or self ownership", async () => {
        const self = harness(base({ owner: { kind: "self" } }), auth("patient"));
        expect((await request(self.app).get("/api/things/1")).status).toBe(200);
    });

    it.each<[string, Partial<UserPolicy>, AuthContext]>([
        ["the status is not allowed", {}, auth("patient", { status: "pending" })],
        ["the email is unverified", { accountState: { emailVerified: true } }, auth("patient", { emailVerified: false })],
        [
            "a check denies",
            { checks: [{ name: "always_deny", appliesTo: ["patient"], run: () => Promise.resolve("deny-forbidden") }] },
            auth("patient"),
        ],
        ["the role is not listed", { roles: ["admin"] }, auth("patient")],
    ])("should never reach the ownership resolver when %s (A9: no existence probing)", async (_label, overrides, principal) => {
        const resolve = resolverReturning("deny-not-found");
        const policy = base({ ...overrides, owner: { kind: "resolver", name: "test_owner", resolve } });
        const res = await request(harness(policy, principal).app).get("/api/things/42");
        expect(res.status).toBe(403);
        expect(resolve).not.toHaveBeenCalled();
    });

    it("should pass only a copy of auth and the frozen path params to resolvers and checks, never the body (A10)", async () => {
        const seen: AccessContext[] = [];
        const resolve = jest.fn((ctx: AccessContext) => {
            seen.push(ctx);
            return Promise.resolve<OwnershipDecision>("allow");
        });
        const run = jest.fn((ctx: AccessContext) => {
            seen.push(ctx);
            return Promise.resolve<"allow">("allow");
        });
        const principal = auth("patient");
        const policy = base({
            owner: { kind: "resolver", name: "test_owner", resolve },
            checks: [{ name: "probe", appliesTo: ["patient"], run }],
        });
        const res = await request(harness(policy, principal).app)
            .post("/api/things/42")
            .send({ ownerUserId: 101, userId: 999, role: "admin" });

        expect(res.status).toBe(200);
        expect(seen).toHaveLength(2);
        for (const ctx of seen) {
            expect(Object.keys(ctx).sort()).toEqual(["auth", "params"]);
            expect(ctx.auth).toEqual(principal);
            expect(ctx.auth).not.toBe(principal);
            expect(ctx.params).toEqual({ id: "42" });
            expect(Object.isFrozen(ctx.params)).toBe(true);
            expect(JSON.stringify(ctx)).not.toContain("ownerUserId");
        }
    });

    it("should return 500 InternalError when a resolver or a check throws", async () => {
        const unhandled = jest.spyOn(rootLogger, "error").mockImplementation(() => undefined);
        const failing = jest.fn(() => Promise.reject(new Error("synthetic db down")));
        const viaResolver = harness(base({ owner: { kind: "resolver", name: "test_owner", resolve: failing } }), auth("patient"));
        const viaCheck = harness(base({ checks: [{ name: "boom", appliesTo: ["patient"], run: failing }] }), auth("patient"));
        for (const { app, handled } of [viaResolver, viaCheck]) {
            const res = await request(app).get("/api/things/1");
            expect(res.status).toBe(500);
            expect(res.body.error.code).toBe("InternalError");
            expect(handled).not.toHaveBeenCalled();
        }
        expect(unhandled).toHaveBeenCalledWith("unhandled_error", expect.anything());
        unhandled.mockRestore();
    });

    it("should log access_denied with a reason and the route pattern but no ids", async () => {
        const { app, log } = harness(
            base({ owner: { kind: "resolver", name: "test_owner", resolve: resolverReturning("deny-not-found") } }),
            auth("patient", { userId: 424242 }),
        );
        await request(app).get("/api/things/987654");
        expect(log.info).toHaveBeenCalledTimes(1);
        expect(log.text()).not.toContain("424242");
        expect(log.text()).not.toContain("987654");
    });
});
