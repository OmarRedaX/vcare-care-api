import { Router } from "express";
import type { RequestHandler } from "express";
import { userGuard } from "../../../../src/lib/auth/user-guard";
import { sealRouter } from "../../../../src/lib/http/route-pattern";
import { assertRoutesAuthorized } from "../../../../src/lib/rbac/assert-routes-authorized";
import { authorize } from "../../../../src/lib/rbac/authorize";
import { markProbeExempt } from "../../../../src/lib/rbac/markers";
import type { UserPolicy } from "../../../../src/lib/rbac/types";

const POLICY: UserPolicy = { kind: "user", roles: ["admin"], owner: { kind: "none" } };
const handler: RequestHandler = (_req, res) => {
    res.json({ ok: true });
};

describe("lib/rbac/assertRoutesAuthorized (A8)", () => {
    it("should pass when every route is guarded and authorized", () => {
        const router = Router();
        router.get("/a", userGuard(), authorize(POLICY), handler);
        router.post("/b/:id", userGuard(), authorize(POLICY), handler);
        expect(() => assertRoutesAuthorized(sealRouter(router))).not.toThrow();
    });

    it("should throw route_without_policy naming method and path when a route lacks authorize", () => {
        const router = Router();
        router.get("/fine", userGuard(), authorize(POLICY), handler);
        router.patch("/things/:id", userGuard(), handler);
        expect(() => assertRoutesAuthorized(router)).toThrow("route_without_policy: PATCH /things/:id");
    });

    it("should throw route_without_policy for a route with no middleware at all", () => {
        const router = Router();
        router.delete("/open", handler);
        expect(() => assertRoutesAuthorized(router)).toThrow("route_without_policy: DELETE /open");
    });

    it("should throw route_without_guard when authorize precedes the guard", () => {
        const router = Router();
        router.get("/things", authorize(POLICY), userGuard(), handler);
        expect(() => assertRoutesAuthorized(router)).toThrow("route_without_guard: GET /things");
    });

    it("should throw route_without_guard when there is no guard at all", () => {
        const router = Router();
        router.get("/things", authorize(POLICY), handler);
        expect(() => assertRoutesAuthorized(router)).toThrow("route_without_guard: GET /things");
    });

    it("should walk nested routers", () => {
        const inner = Router();
        inner.put("/deep/:id", handler);
        const middle = Router();
        middle.use("/inner", inner);
        const outer = Router();
        outer.use("/middle", sealRouter(middle));
        expect(() => assertRoutesAuthorized(outer)).toThrow("route_without_policy: PUT /deep/:id");
    });

    it("should report the base path when one is given", () => {
        const router = Router();
        router.get("/x", handler);
        expect(() => assertRoutesAuthorized(router, "/api")).toThrow("route_without_policy: GET /api/x");
    });

    it("should report every method of a route registered with all", () => {
        const router = Router();
        router.all("/any", handler);
        expect(() => assertRoutesAuthorized(router)).toThrow(/^route_without_policy: .*\/any$/);
    });

    it("should skip probe-exempt routers", () => {
        const health = Router();
        health.get("/live", handler);
        const app = Router();
        app.use("/health", markProbeExempt(sealRouter(health)));
        expect(() => assertRoutesAuthorized(app)).not.toThrow();

        // Exemption is by marker only: an unmarked twin fails.
        const unmarked = Router();
        unmarked.get("/live", handler);
        const app2 = Router();
        app2.use("/health", unmarked);
        expect(() => assertRoutesAuthorized(app2)).toThrow("route_without_policy: GET /live");
    });

    it("should ignore router-level middleware that is not a route", () => {
        const router = Router();
        router.use((_req, _res, next) => next());
        router.get("/ok", userGuard(), authorize(POLICY), handler);
        expect(() => assertRoutesAuthorized(router)).not.toThrow();
    });
});
