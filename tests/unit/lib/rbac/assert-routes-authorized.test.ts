import express, { Router } from "express";
import type { RequestHandler } from "express";
import { userGuard } from "../../../../src/lib/auth/user-guard";
import { sealRouter } from "../../../../src/lib/http/route-pattern";
import { assertRoutesAuthorized } from "../../../../src/lib/rbac/assert-routes-authorized";
import { authorize } from "../../../../src/lib/rbac/authorize";
import { noStore } from "../../../../src/lib/http/no-store";
import { rateLimit } from "../../../../src/lib/rate-limit/rate-limit";
import { byIp } from "../../../../src/lib/rate-limit/subjects";
import { markPreAuth, markProbeExempt } from "../../../../src/lib/rbac/markers";
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

    it("should throw middleware_without_policy for a terminal router.use(path, fn) inside a module router (H1 b)", () => {
        const moduleRouter = Router();
        moduleRouter.get("/ok", userGuard(), authorize(POLICY), handler);
        moduleRouter.use("/secret", handler);
        const app = Router();
        app.use("/api", sealRouter(moduleRouter));
        expect(() => assertRoutesAuthorized(app)).toThrow(/^middleware_without_policy: /);
    });

    it("should throw middleware_without_policy for unmarked router-level middleware, even at the top level (H1 b)", () => {
        const router = Router();
        router.use((_req, _res, next) => next());
        router.get("/ok", userGuard(), authorize(POLICY), handler);
        expect(() => assertRoutesAuthorized(router)).toThrow(/^middleware_without_policy: /);
    });

    it("should pass router-level middleware only when it is marked pre-auth or is an error handler (H1 b)", () => {
        const moduleRouter = Router();
        moduleRouter.use(noStore());
        moduleRouter.use(markPreAuth((_req, _res, next) => next()));
        moduleRouter.get("/ok", userGuard(), authorize(POLICY), handler);
        const app = Router();
        app.use("/api", sealRouter(moduleRouter)); // sealRouter appends a 4-arity error layer
        expect(() => assertRoutesAuthorized(app)).not.toThrow();
    });

    it("should throw handler_before_authorize when a handler runs between the guard and authorize (H1 a)", () => {
        const router = Router();
        router.get("/x", userGuard(), handler, authorize(POLICY));
        expect(() => assertRoutesAuthorized(router)).toThrow("handler_before_authorize: GET /x");
    });

    it("should throw handler_before_authorize when a handler runs before the guard (H1 a)", () => {
        const router = Router();
        router.post("/x", handler, userGuard(), authorize(POLICY), handler);
        expect(() => assertRoutesAuthorized(router)).toThrow("handler_before_authorize: POST /x");
    });

    it("should accept pre-auth middleware (rateLimit by IP, noStore) before the guard", () => {
        const router = Router();
        router.get(
            "/x",
            rateLimit({ name: "assert_test", limit: 10, windowMs: 1_000, subject: byIp }),
            noStore(),
            userGuard(),
            authorize(POLICY),
            handler,
        );
        expect(() => assertRoutesAuthorized(router)).not.toThrow();
    });

    it("should walk a mounted Express 5 sub-app through its app.router (H1 c)", () => {
        const subApp = express();
        subApp.get("/inside", handler);
        const router = Router();
        router.use("/x", subApp);
        expect(() => assertRoutesAuthorized(router)).toThrow("route_without_policy: GET /inside");

        const guardedApp = express();
        guardedApp.get("/inside", userGuard(), authorize(POLICY), handler);
        const ok = Router();
        ok.use("/x", guardedApp);
        expect(() => assertRoutesAuthorized(ok)).not.toThrow();
    });

    it("should throw for a sub-app mounted with app.use, which Express hides behind a wrapper (H1 c)", () => {
        const subApp = express();
        subApp.get("/inside", userGuard(), authorize(POLICY), handler);
        const app = express();
        app.use("/x", subApp);
        expect(() => assertRoutesAuthorized(app.router)).toThrow("middleware_without_policy: mounted_app under /");
    });

    it("should check each method of a router.route() chain separately: authorized GET, bare POST (H1 d)", () => {
        const router = Router();
        router.route("/s").get(userGuard(), authorize(POLICY), handler).post(handler);
        expect(() => assertRoutesAuthorized(router)).toThrow("route_without_policy: POST /s");
    });

    it("should check each method of a router.route() chain separately: guard on GET, authorize on POST (H1 d)", () => {
        const router = Router();
        router.route("/s").get(userGuard(), handler).post(authorize(POLICY), handler);
        expect(() => assertRoutesAuthorized(router)).toThrow("route_without_policy: GET /s");
    });

    it("should count .all entries as part of every method's chain (H1 d)", () => {
        const guardedAll = Router();
        guardedAll.route("/s").all(userGuard(), authorize(POLICY)).get(handler).post(handler);
        expect(() => assertRoutesAuthorized(guardedAll)).not.toThrow();

        const trailingAll = Router();
        trailingAll.route("/s").get(userGuard(), authorize(POLICY), handler).all(handler);
        expect(() => assertRoutesAuthorized(trailingAll)).toThrow("route_without_policy: ALL /s");
    });

    describe("param callbacks (review 2026-10-03, router.param bypass)", () => {
        const loadById = (_req: unknown, _res: unknown, next: () => void): void => next();

        it("should throw param_callback_without_policy when a module router registers router.param", () => {
            const moduleRouter = Router();
            moduleRouter.param("id", loadById);
            moduleRouter.get("/records/:id", userGuard(), authorize(POLICY), handler);
            const app = Router();
            app.use("/api", sealRouter(moduleRouter));
            expect(() => assertRoutesAuthorized(app, "/api")).toThrow("param_callback_without_policy: id under /api");
        });

        it("should throw param_callback_without_policy when app.param is registered on the root app", () => {
            const app = express();
            app.param("consultationId", loadById);
            app.get("/consultations/:consultationId", userGuard(), authorize(POLICY), handler);
            expect(() => assertRoutesAuthorized(app.router)).toThrow(
                "param_callback_without_policy: consultationId under /",
            );
        });

        it("should throw param_callback_without_policy when a mounted sub-app registers app.param", () => {
            const subApp = express();
            subApp.param("id", loadById);
            subApp.get("/inside/:id", userGuard(), authorize(POLICY), handler);
            const router = Router();
            router.use("/x", subApp);
            expect(() => assertRoutesAuthorized(router)).toThrow("param_callback_without_policy: id under /");
        });

        it("should throw param_callback_without_policy for a probe-exempt router with a param callback", () => {
            const health = Router();
            health.param("probe", loadById);
            health.get("/live/:probe", handler);
            const app = Router();
            app.use("/health", markProbeExempt(sealRouter(health)));
            expect(() => assertRoutesAuthorized(app)).toThrow("param_callback_without_policy: probe under /");
        });

        it("should pass guarded :param routes on routers, sub-apps, and the root when no param callback is registered", () => {
            const moduleRouter = Router();
            moduleRouter.get("/records/:id", userGuard(), authorize(POLICY), handler);
            const subApp = express();
            subApp.get("/inside/:id", userGuard(), authorize(POLICY), handler);
            const app = express();
            app.use("/api", sealRouter(moduleRouter));
            app.router.use("/sub", subApp);
            expect(() => assertRoutesAuthorized(app.router)).not.toThrow();
        });
    });

    it("should pass a router.route() chain whose every method is guarded and authorized", () => {
        const router = Router();
        router
            .route("/s")
            .get(userGuard(), authorize(POLICY), handler)
            .post(userGuard(), authorize(POLICY), handler);
        expect(() => assertRoutesAuthorized(router)).not.toThrow();
    });
});
