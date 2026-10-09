import { Router } from "express";
import type { RequestHandler } from "express";
import request from "supertest";
import { createPublicApp } from "../../src/app";
import { createInternalApp } from "../../src/internal-app";
import { userGuard } from "../../src/lib/auth/user-guard";
import { authorize } from "../../src/lib/rbac/authorize";
import { buildInternalRoutes } from "../../src/internal-routes";
import type * as InternalRoutesModule from "../../src/internal-routes";
import { buildPublicRoutes } from "../../src/routes";
import type * as RoutesModule from "../../src/routes";
import { buildTestApps } from "../helpers/app";
import { expectErrorEnvelope, expectHealthLiveBody } from "../helpers/contract";
import { closeDb, truncateAll } from "../helpers/db";
import { closeRedis, ensureRedisReady } from "../helpers/redis";
import { buildEnvelopeRouter } from "../helpers/test-routers";

/**
 * `buildPublicRoutes`/`buildInternalRoutes` are wrapped in jest.fn that delegate to the REAL routers by default (the
 * specialties module is mounted by the real src/routes.ts); a test replaces them once (`mockReturnValueOnce`) to prove
 * an unpoliced route can never reach the real createPublicApp/createInternalApp. Everything else — health, middleware,
 * the boot assertion — is the real wiring.
 */
jest.mock("../../src/routes", () => {
    const actual = jest.requireActual<typeof RoutesModule>("../../src/routes");
    return { buildPublicRoutes: jest.fn(actual.buildPublicRoutes) };
});
jest.mock("../../src/internal-routes", () => {
    const actual = jest.requireActual<typeof InternalRoutesModule>("../../src/internal-routes");
    return { buildInternalRoutes: jest.fn(actual.buildInternalRoutes) };
});

const handler: RequestHandler = (_req, res) => {
    res.json({ ok: true });
};

describe("boot-time route authorization (integration: real app factories)", () => {
    beforeAll(async () => {
        await ensureRedisReady();
        await truncateAll();
    });

    afterAll(async () => {
        await closeRedis();
        await closeDb();
    });

    it("should throw route_without_policy from createPublicApp when a module route has no authorize (A8)", () => {
        const router = Router();
        router.get("/specialties", handler);
        jest.mocked(buildPublicRoutes).mockReturnValueOnce(router);
        expect(() => createPublicApp()).toThrow("route_without_policy: GET /specialties");
    });

    it("should throw route_without_guard from createPublicApp when authorize is not preceded by a guard (A8)", () => {
        const router = Router();
        router.post("/specialties", authorize({ kind: "user", roles: ["admin"], owner: { kind: "none" } }), handler);
        jest.mocked(buildPublicRoutes).mockReturnValueOnce(router);
        expect(() => createPublicApp()).toThrow("route_without_guard: POST /specialties");
    });

    it("should throw route_without_policy from createInternalApp for an unpoliced nested internal route (A8)", () => {
        const inner = Router();
        inner.get("/:userId/summary", userGuard(), handler);
        const router = Router();
        router.use("/doctors", inner);
        jest.mocked(buildInternalRoutes).mockReturnValueOnce(router);
        expect(() => createInternalApp()).toThrow("route_without_policy: GET /:userId/summary");
    });

    it("should throw middleware_without_policy from createPublicApp when a module router mounts a terminal handler with use (H1)", () => {
        const router = Router();
        router.get("/specialties", userGuard(), authorize({ kind: "user", roles: ["admin"], owner: { kind: "none" } }), handler);
        router.use("/specialties/export", handler);
        jest.mocked(buildPublicRoutes).mockReturnValueOnce(router);
        expect(() => createPublicApp()).toThrow(/^middleware_without_policy: /);
    });

    it("should throw handler_before_authorize from createPublicApp when a controller runs between guard and authorize (H1)", () => {
        const router = Router();
        router.get("/specialties", userGuard(), handler, authorize({ kind: "user", roles: ["admin"], owner: { kind: "none" } }));
        jest.mocked(buildPublicRoutes).mockReturnValueOnce(router);
        expect(() => createPublicApp()).toThrow("handler_before_authorize: GET /specialties");
    });

    it("should throw param_callback_without_policy from createPublicApp when a module router registers router.param (review 2026-10-03)", () => {
        const router = Router();
        router.param("id", (_req, _res, next) => next());
        router.get("/specialties/:id", userGuard(), authorize({ kind: "user", roles: ["admin"], owner: { kind: "none" } }), handler);
        jest.mocked(buildPublicRoutes).mockReturnValueOnce(router);
        expect(() => createPublicApp()).toThrow("param_callback_without_policy: id under /");
    });

    it("should throw route_without_policy at registration when a route passes an undefined policy (A8)", () => {
        expect(() => {
            const router = Router();
            router.get("/x", userGuard(), authorize(undefined), handler);
        }).toThrow("route_without_policy");
    });

    it("should boot with the real module routers (every production route guarded and authorized)", () => {
        expect(() => buildTestApps()).not.toThrow();
    });

    it("should boot with the real buildPublicRoutes and answer GET /api/specialties without a token with 401 (route mounted and guarded)", async () => {
        const { publicApp } = buildTestApps();
        const res = await request(publicApp).get("/api/specialties");
        expect(res.status).toBe(401);
        expectErrorEnvelope(res.body, "Unauthorized");
        for (const [method, path] of [["post", "/api/specialties"], ["patch", "/api/specialties/1"]] as const) {
            const denied = await request(publicApp)[method](path).send({ name: "Synthetic Name" });
            expect(denied.status).toBe(401);
        }
    });

    it("should answer GET /api/doctors/me without a token with 401 when the real router is mounted", async () => {
        const res = await request(buildTestApps().publicApp).get("/api/doctors/me");
        expect(res.status).toBe(401);
        expectErrorEnvelope(res.body, "Unauthorized", res.headers["x-request-id"]);
    });

    it("should answer every real schedules route without a token with 401 when the real router is mounted", async () => {
        const { publicApp } = buildTestApps();
        const routes = [
            ["get", "/api/doctors/me/working-hours"], ["put", "/api/doctors/me/working-hours"], ["get", "/api/doctors/me/exceptions"],
            ["post", "/api/doctors/me/exceptions"], ["delete", "/api/doctors/me/exceptions/1"], ["get", "/api/doctors/me/consultation-types"],
            ["post", "/api/doctors/me/consultation-types"], ["patch", "/api/doctors/me/consultation-types/1"],
        ] as const;
        for (const [method, path] of routes) {
            const res = await request(publicApp)[method](path).send(method === "get" || method === "delete" ? undefined : {});
            expect(res.status).toBe(401);
            expectErrorEnvelope(res.body, "Unauthorized", res.headers["x-request-id"]);
        }
    });

    it("should start with test routers that lack authorize because extraRouters are mounted after the check (A8)", async () => {
        const { publicApp, internalApp } = buildTestApps({
            publicRouters: [{ path: "/api", router: buildEnvelopeRouter() }],
            internalRouters: [{ path: "/internal", router: buildEnvelopeRouter() }],
        });
        expect((await request(publicApp).get("/api/__test/context")).status).toBe(200);
        expect((await request(internalApp).get("/internal/__test/context")).status).toBe(200);
    });

    it("should keep health reachable without a token on both listeners (probe-exempt)", async () => {
        const { publicApp, internalApp } = buildTestApps();
        for (const [app, path] of [
            [publicApp, "/api/health/live"],
            [internalApp, "/internal/health/live"],
        ] as const) {
            const res = await request(app).get(path);
            expect(res.status).toBe(200);
            expectHealthLiveBody(res.body);
        }
        for (const [app, path] of [
            [publicApp, "/api/health/ready"],
            [internalApp, "/internal/health/ready"],
        ] as const) {
            expect((await request(app).get(path)).status).toBe(200);
        }
    });
});
