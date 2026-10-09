import type { RequestHandler, Router } from "express";
import { buildAdminDoctorsPolicies } from "../../../../src/app/admin-doctors/policies";
import { buildAdminDoctorsRouter } from "../../../../src/app/admin-doctors/routes";
import { assertRoutesAuthorized } from "../../../../src/lib/rbac/assert-routes-authorized";
import { isAuthorizeHandler, isGuardHandler, isPreAuthHandler } from "../../../../src/lib/rbac/markers";
import { contractOperationBlock, inlineLists } from "../../../helpers/contract";

interface Layer { route?: { path: string; stack: Array<{ method?: string; handle: RequestHandler }> } }
const layers = (router: Router): Layer[] => (router as unknown as { stack: Layer[] }).stack;
const chain = (router: Router, method: string, path: string): RequestHandler[] => {
    const layer = layers(router).find((item) => item.route?.path === path && item.route.stack.some((entry) => entry.method === method));
    if (layer?.route === undefined) throw new Error(`${method} ${path} missing`);
    return layer.route.stack.map((entry) => entry.handle);
};
const kind = (handler: RequestHandler): string => isGuardHandler(handler) ? "guard" : isAuthorizeHandler(handler) ? "authorize" : isPreAuthHandler(handler) ? "limiter" : "other";

const OPERATIONS = [["suspend", "/api/admin/doctors/{doctorUserId}/suspend"], ["reinstate", "/api/admin/doctors/{doctorUserId}/reinstate"]] as const;

describe("admin-doctors policies", () => {
    const policies = buildAdminDoctorsPolicies();

    it("should define exactly the two routes", () => {
        expect(Object.keys(policies).sort()).toEqual(["reinstate", "suspend"]);
    });

    it.each(OPERATIONS)("should declare %s as admin-only, no ownership, admin-action audit and the default active account state like the contract", (name, apiPath) => {
        const contract = contractOperationBlock(apiPath, "patch");
        expect(policies[name]).toEqual({ kind: "user", roles: ["admin"], owner: { kind: "none" }, audit: "admin-action" });
        expect(inlineLists(contract, "x-roles")[0]).toEqual(["admin"]);
        expect(contract).toContain("x-ownership: none");
        expect(contract).toContain("x-audit: admin-action");
        expect(policies[name].accountState).toBeUndefined();
        expect(policies[name].checks).toBeUndefined();
    });

    it.each(OPERATIONS)("should name no doctor or patient role and no wildcard on %s", (name) => {
        expect(policies[name].roles).not.toContain("doctor");
        expect(policies[name].roles).not.toContain("patient");
        expect(policies[name].roles).toHaveLength(1);
    });
});

describe("buildAdminDoctorsRouter", () => {
    const router = buildAdminDoctorsRouter();

    it.each(["suspend", "reinstate"])("should compose PATCH %s as guard, authorize, limiter, idempotency and handler", (action) => {
        expect(chain(router, "patch", `/admin/doctors/:doctorUserId/${action}`).map(kind)).toEqual(["guard", "authorize", "limiter", "other", "other"]);
    });

    it("should register exactly the two PATCH routes", () => {
        const registered = layers(router).filter((layer) => layer.route !== undefined).flatMap((layer) => layer.route!.stack.map((entry) => `${entry.method ?? ""} ${layer.route!.path}`));
        expect([...new Set(registered)].sort()).toEqual(["patch /admin/doctors/:doctorUserId/reinstate", "patch /admin/doctors/:doctorUserId/suspend"]);
    });

    it("should pass assertRoutesAuthorized and register no router.param", () => {
        expect(() => assertRoutesAuthorized(router)).not.toThrow();
        expect(Object.keys((router as unknown as { params?: object }).params ?? {})).toEqual([]);
    });
});
