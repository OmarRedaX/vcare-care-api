import type { RequestHandler, Router } from "express";
import { AUDIT_POLICIES } from "../../../../src/app/audit/policies";
import { buildAuditRouter } from "../../../../src/app/audit/routes";
import { assertRoutesAuthorized } from "../../../../src/lib/rbac/assert-routes-authorized";
import { authorize } from "../../../../src/lib/rbac/authorize";
import { isAuthorizeHandler, isGuardHandler, isPreAuthHandler } from "../../../../src/lib/rbac/markers";
import { contractOperationBlock, inlineLists } from "../../../helpers/contract";

interface Layer { route?: { path: string; stack: Array<{ method?: string; handle: RequestHandler }> } }
const layers = (router: Router): Layer[] => (router as unknown as { stack: Layer[] }).stack;
const kind = (handler: RequestHandler): string => isGuardHandler(handler) ? "guard" : isAuthorizeHandler(handler) ? "authorize" : isPreAuthHandler(handler) ? "limiter" : "other";

describe("AUDIT_POLICIES", () => {
    const contract = contractOperationBlock("/api/audit-logs", "get");

    it("should list only admin with owner none and no account-state override, as the contract declares", () => {
        expect(AUDIT_POLICIES.list).toEqual({ kind: "user", roles: ["admin"], owner: { kind: "none" } });
        expect(inlineLists(contract, "x-roles")[0]).toEqual(["admin"]);
        expect(contract).toContain("x-ownership: none");
        expect(AUDIT_POLICIES.list.accountState).toBeUndefined();
        expect(AUDIT_POLICIES.list.checks).toBeUndefined();
    });

    it("should declare no audit class because a read writes no audit row", () => {
        expect(AUDIT_POLICIES.list.audit).toBeUndefined();
        expect(contract).not.toContain("x-audit");
    });

    it("should name no doctor, patient, or wildcard role", () => {
        expect(AUDIT_POLICIES.list.roles).toHaveLength(1);
        expect(AUDIT_POLICIES.list.roles).not.toContain("doctor");
        expect(AUDIT_POLICIES.list.roles).not.toContain("patient");
    });

    it("should define exactly the list policy and build through authorize", () => {
        expect(Object.keys(AUDIT_POLICIES)).toEqual(["list"]);
        expect(() => authorize(AUDIT_POLICIES.list)).not.toThrow();
    });
});

describe("buildAuditRouter", () => {
    const router = buildAuditRouter();
    const routes = layers(router).filter((layer) => layer.route !== undefined);

    it("should compose GET /audit-logs as guard, authorize, per-user limiter after authorize, handler", () => {
        const route = routes.find((layer) => layer.route?.path === "/audit-logs");
        expect(route?.route?.stack.map((entry) => entry.method)).toEqual(["get", "get", "get", "get"]);
        expect(route?.route?.stack.map((entry) => kind(entry.handle))).toEqual(["guard", "authorize", "limiter", "other"]);
    });

    it("should mount noStore before the route", () => {
        const all = layers(router);
        const noStoreIndex = all.findIndex((layer) => layer.route === undefined);
        const routeIndex = all.findIndex((layer) => layer.route?.path === "/audit-logs");
        expect(noStoreIndex).toBeGreaterThanOrEqual(0);
        expect(noStoreIndex).toBeLessThan(routeIndex);
    });

    it("should register exactly one route, GET only", () => {
        expect(routes).toHaveLength(1);
        expect(routes[0]?.route?.stack.every((entry) => entry.method === "get")).toBe(true);
    });

    it("should pass assertRoutesAuthorized", () => {
        expect(() => assertRoutesAuthorized(router)).not.toThrow();
    });
});
