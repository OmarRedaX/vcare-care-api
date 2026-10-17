import "reflect-metadata";
import type { RequestHandler, Router } from "express";
import { buildSessionsPolicies } from "../../../../src/app/sessions/policies";
import { buildSessionsRouter } from "../../../../src/app/sessions/routes";
import { assertRoutesAuthorized } from "../../../../src/lib/rbac/assert-routes-authorized";
import { isAuthorizeHandler, isGuardHandler, isPreAuthHandler } from "../../../../src/lib/rbac/markers";
import type { AccessContext, OwnershipRule } from "../../../../src/lib/rbac/types";
import { contractOperationBlock, inlineLists } from "../../../helpers/contract";

type Role = "patient" | "doctor" | "admin";
const ctx = (role: Role, userId: number, params: Record<string, string>): AccessContext => ({ auth: { userId, role, status: "active", emailVerified: true }, params });
const resolve = (owner: OwnershipRule, context: AccessContext) => {
    if (owner.kind !== "resolver") throw new Error("expected a resolver");
    return owner.resolve(context);
};

const rows = {
    isParticipant: jest.fn((id: number, userId: number) => Promise.resolve(id === 7 && (userId === 101 || userId === 202))),
    isAssignedDoctor: jest.fn((id: number, userId: number) => Promise.resolve(id === 7 && userId === 202)),
};
const suspended = new Set<number>();
const doctors = { isLocallySuspended: (userId: number) => Promise.resolve(suspended.has(userId)) };
const policies = buildSessionsPolicies(doctors, rows);

const OPERATIONS = [
    ["join", "/api/consultations/{id}/join", "patch"], ["start", "/api/consultations/{id}/start", "patch"], ["complete", "/api/consultations/{id}/complete", "patch"],
    ["noShow", "/api/consultations/{id}/no-show", "patch"], ["waitingRoom", "/api/consultations/waiting-room", "get"], ["calendar", "/api/consultations/calendar", "get"],
] as const;

describe("sessions policies", () => {
    it.each(OPERATIONS)("should declare the %s roles from the contract", (name, path, method) => {
        expect([...policies[name].roles]).toEqual(inlineLists(contractOperationBlock(path, method), "x-roles")[0]);
    });

    it("should never let an admin join, start, complete or read the doctor views, and never a patient anything but join", () => {
        for (const name of ["join", "start", "complete", "waitingRoom", "calendar"] as const) expect(policies[name].roles).not.toContain("admin");
        for (const name of ["start", "complete", "noShow", "waitingRoom", "calendar"] as const) expect(policies[name].roles).not.toContain("patient");
        expect(policies.join.roles).toEqual(["patient", "doctor"]);
        expect(policies.noShow.roles).toEqual(["doctor", "admin"]);
    });

    it("should apply the live local-suspension check on every route and audit the no-show as an admin action", () => {
        for (const [name] of OPERATIONS) expect(policies[name].checks?.map((check) => check.name)).toEqual(["doctor_not_suspended"]);
        expect(policies.noShow.audit).toBe("admin-action");
        expect(policies.join.audit).toBeUndefined();
    });

    it("should check suspension for doctors only so an admin no-show stays possible", async () => {
        const check = policies.noShow.checks?.[0];
        expect(check?.appliesTo).toEqual(["doctor"]);
        suspended.add(202);
        expect(await check?.run(ctx("doctor", 202, { id: "7" }))).toBe("deny-forbidden");
        suspended.clear();
        expect(await check?.run(ctx("doctor", 202, { id: "7" }))).toBe("allow");
    });

    it("should use self ownership for the doctor views", () => {
        expect(policies.waitingRoom.owner).toEqual({ kind: "self" });
        expect(policies.calendar.owner).toEqual({ kind: "self" });
    });

    it("should hide a non-numeric id from every role with 404", async () => {
        for (const name of ["join", "start", "complete", "noShow"] as const) {
            for (const params of [{ id: "abc" }, { id: "0" }, { id: "-1" }, {}] as Array<Record<string, string>>) expect(await resolve(policies[name].owner, ctx("doctor", 202, params))).toBe("deny-not-found");
        }
        expect(await resolve(policies.noShow.owner, ctx("admin", 303, { id: "abc" }))).toBe("deny-not-found");
    });

    it("should allow the participants to join and hide the row from anyone else", async () => {
        expect(await resolve(policies.join.owner, ctx("patient", 101, { id: "7" }))).toBe("allow");
        expect(await resolve(policies.join.owner, ctx("doctor", 202, { id: "7" }))).toBe("allow");
        expect(await resolve(policies.join.owner, ctx("patient", 102, { id: "7" }))).toBe("deny-not-found");
        expect(await resolve(policies.join.owner, ctx("doctor", 204, { id: "7" }))).toBe("deny-not-found");
    });

    it("should allow only the assigned doctor to start and complete, and the assigned doctor or any admin to mark a no-show", async () => {
        for (const name of ["start", "complete"] as const) {
            expect(await resolve(policies[name].owner, ctx("doctor", 202, { id: "7" }))).toBe("allow");
            expect(await resolve(policies[name].owner, ctx("doctor", 204, { id: "7" }))).toBe("deny-not-found");
        }
        expect(await resolve(policies.noShow.owner, ctx("doctor", 202, { id: "7" }))).toBe("allow");
        expect(await resolve(policies.noShow.owner, ctx("doctor", 204, { id: "7" }))).toBe("deny-not-found");
        rows.isAssignedDoctor.mockClear();
        expect(await resolve(policies.noShow.owner, ctx("admin", 303, { id: "999999" }))).toBe("allow");
        expect(rows.isAssignedDoctor).not.toHaveBeenCalled();
    });
});

interface Layer { route?: { path: string; stack: Array<{ method?: string; handle: RequestHandler }> } }
const layers = (router: Router): Layer[] => (router as unknown as { stack: Layer[] }).stack;
const chain = (router: Router, method: string, path: string): RequestHandler[] => {
    const layer = layers(router).find((item) => item.route?.path === path && item.route.stack.some((entry) => entry.method === method));
    if (layer?.route === undefined) throw new Error(`${method} ${path} missing`);
    return layer.route.stack.map((entry) => entry.handle);
};
const kind = (handler: RequestHandler): string => isGuardHandler(handler) ? "guard" : isAuthorizeHandler(handler) ? "authorize" : isPreAuthHandler(handler) ? "limiter" : "other";

describe("buildSessionsRouter", () => {
    const router = buildSessionsRouter();

    it("should compose guard, authorize, limiter(s) and handler, with no idempotency middleware, on every route", () => {
        expect(chain(router, "get", "/consultations/waiting-room").map(kind)).toEqual(["guard", "authorize", "limiter", "other"]);
        expect(chain(router, "get", "/consultations/calendar").map(kind)).toEqual(["guard", "authorize", "limiter", "other"]);
        expect(chain(router, "patch", "/consultations/:id/join").map(kind)).toEqual(["guard", "authorize", "limiter", "other"]);
        expect(chain(router, "patch", "/consultations/:id/start").map(kind)).toEqual(["guard", "authorize", "limiter", "other"]);
        expect(chain(router, "patch", "/consultations/:id/complete").map(kind)).toEqual(["guard", "authorize", "limiter", "limiter", "other"]);
        expect(chain(router, "patch", "/consultations/:id/no-show").map(kind)).toEqual(["guard", "authorize", "limiter", "limiter", "other"]);
    });

    it("should register the two literals before any id route and exactly the six operations", () => {
        const registered = layers(router).filter((layer) => layer.route !== undefined).flatMap((layer) => layer.route!.stack.map((entry) => `${entry.method ?? ""} ${layer.route!.path}`));
        expect([...new Set(registered)]).toEqual(["get /consultations/waiting-room", "get /consultations/calendar", "patch /consultations/:id/join",
            "patch /consultations/:id/start", "patch /consultations/:id/complete", "patch /consultations/:id/no-show"]);
    });

    it("should pass assertRoutesAuthorized", () => {
        expect(() => assertRoutesAuthorized(router)).not.toThrow();
    });
});
