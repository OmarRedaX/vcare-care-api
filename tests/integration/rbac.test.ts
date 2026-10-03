import { randomUUID } from "node:crypto";
import type { Express } from "express";
import request from "supertest";
import { redis } from "../../src/lib/redis/redis";
import { buildTestApps } from "../helpers/app";
import { expectErrorEnvelope, expectSuccessEnvelope } from "../helpers/contract";
import { closeDb, truncateAll } from "../helpers/db";
import { startFakeJwks, withFakeJwksCache } from "../helpers/fake-jwks";
import { closeRedis, ensureRedisReady, flushByPrefix } from "../helpers/redis";
import { buildAccessTestRouter } from "../helpers/test-routers";
import { signExpiredUserToken, signUserToken } from "../helpers/tokens";
import type { FakeJwks } from "../helpers/types";

jest.setTimeout(30_000);

type Method = "get" | "post";
type Principal = "none" | "patient" | "doctor" | "admin";

interface Expectation {
    status: number;
    code?: string;
}

/**
 * RBAC per route (CLAUDE.md → Testing policy) over the test-only routes of spec §9.3, through the real
 * userGuard → authorize chain, real Postgres (ownership resolver and check run real queries), and real Redis.
 */
describe("RBAC matrix (integration: test-only routes of spec §9.3)", () => {
    let fake: FakeJwks;
    let app: Express;

    beforeAll(async () => {
        await ensureRedisReady();
        await truncateAll();
        fake = await startFakeJwks(["k1"]);
        app = buildTestApps({ publicRouters: [{ path: "/api", router: buildAccessTestRouter() }] }).publicApp;
    });

    beforeEach(async () => {
        await flushByPrefix(["idem:"]);
    });

    afterAll(async () => {
        await flushByPrefix(["idem:"]);
        await fake.close();
        await closeRedis();
        await closeDb();
    });

    const token = (claims: Record<string, unknown>): Promise<string> => signUserToken(fake.key("k1"), claims);

    const PRINCIPALS: Record<Exclude<Principal, "none">, Record<string, unknown>> = {
        patient: { sub: "101", role: "patient" },
        doctor: { sub: "202", role: "doctor" },
        admin: { sub: "303", role: "admin" },
    };

    async function send(method: Method, path: string, bearer?: string): Promise<request.Response> {
        const req = method === "get" ? request(app).get(path) : request(app).post(path).send({});
        return bearer === undefined ? req : req.set("Authorization", `Bearer ${bearer}`);
    }

    function expectOutcome(res: request.Response, expected: Expectation, label: string): void {
        expect({ label, status: res.status }).toEqual({ label, status: expected.status });
        if (expected.code !== undefined) {
            expectErrorEnvelope(res.body, expected.code, res.headers["x-request-id"]);
        } else {
            expectSuccessEnvelope(res.body);
        }
    }

    const MATRIX: Array<[Method, string, Record<Principal, Expectation>]> = [
        [
            "get",
            "/api/__test/access/any",
            { none: { status: 401, code: "Unauthorized" }, patient: { status: 200 }, doctor: { status: 200 }, admin: { status: 200 } },
        ],
        [
            "get",
            "/api/__test/access/admin",
            {
                none: { status: 401, code: "Unauthorized" },
                patient: { status: 403, code: "Forbidden" },
                doctor: { status: 403, code: "Forbidden" },
                admin: { status: 200 },
            },
        ],
        [
            "get",
            "/api/__test/access/onboarding",
            {
                none: { status: 401, code: "Unauthorized" },
                patient: { status: 403, code: "Forbidden" },
                doctor: { status: 200 },
                admin: { status: 403, code: "Forbidden" },
            },
        ],
        [
            "post",
            "/api/__test/access/verified",
            {
                none: { status: 401, code: "Unauthorized" },
                patient: { status: 201 },
                doctor: { status: 403, code: "Forbidden" },
                admin: { status: 403, code: "Forbidden" },
            },
        ],
        [
            "get",
            "/api/__test/access/owned/1",
            {
                none: { status: 401, code: "Unauthorized" },
                patient: { status: 200 }, // user 101 owns resource 1
                doctor: { status: 403, code: "Forbidden" }, // user 202 is not the owner; doctors see 403
                admin: { status: 403, code: "Forbidden" }, // role not listed
            },
        ],
        [
            "get",
            "/api/__test/access/checked",
            {
                none: { status: 401, code: "Unauthorized" },
                patient: { status: 403, code: "Forbidden" },
                doctor: { status: 200 },
                admin: { status: 200 },
            },
        ],
    ];

    it.each(MATRIX)("should apply the role matrix to %s %s (A9)", async (method, path, expected) => {
        await withFakeJwksCache(fake, async () => {
            expectOutcome(await send(method, path), expected.none, "none");
            for (const principal of ["patient", "doctor", "admin"] as const) {
                expectOutcome(await send(method, path, await token(PRINCIPALS[principal])), expected[principal], principal);
            }
        });
    });

    it.each(MATRIX.map(([method, path]) => [method, path] as const))(
        "should return 401 TokenExpired on %s %s for an expired token of an allowed role",
        async (method, path) => {
            await withFakeJwksCache(fake, async () => {
                const res = await send(method, path, await signExpiredUserToken(fake.key("k1"), { sub: "101", role: "patient" }));
                expect(res.status).toBe(401);
                expectErrorEnvelope(res.body, "TokenExpired");
            });
        },
    );

    it("should let pending and rejected doctors onboard but deny a suspended doctor and a pending patient", async () => {
        await withFakeJwksCache(fake, async () => {
            const path = "/api/__test/access/onboarding";
            for (const status of ["pending", "active", "rejected"]) {
                expect((await send("get", path, await token({ sub: "202", role: "doctor", status }))).status).toBe(200);
            }
            const suspended = await send("get", path, await token({ sub: "202", role: "doctor", status: "suspended" }));
            expectOutcome(suspended, { status: 403, code: "Forbidden" }, "suspended doctor");
            const pendingPatient = await send("get", path, await token({ sub: "101", role: "patient", status: "pending" }));
            expectOutcome(pendingPatient, { status: 403, code: "Forbidden" }, "pending patient");
        });
    });

    it.each(["pending", "rejected", "suspended"])(
        "should deny a %s account on every active-only route",
        async (status) => {
            await withFakeJwksCache(fake, async () => {
                for (const [method, path] of [
                    ["get", "/api/__test/access/any"],
                    ["get", "/api/__test/access/admin"],
                    ["post", "/api/__test/access/verified"],
                    ["get", "/api/__test/access/owned/1"],
                    ["get", "/api/__test/access/checked"],
                ] as const) {
                    const role = path.endsWith("admin") ? "admin" : path.endsWith("checked") ? "doctor" : "patient";
                    const res = await send(method, path, await token({ sub: "101", role, status }));
                    expectOutcome(res, { status: 403, code: "Forbidden" }, `${status} ${path}`);
                }
            });
        },
    );

    it("should return 403 EmailNotVerified for ev=false and 201 for ev=true on the verified route", async () => {
        await withFakeJwksCache(fake, async () => {
            const unverified = await send("post", "/api/__test/access/verified", await token({ sub: "101", role: "patient", ev: false }));
            expectOutcome(unverified, { status: 403, code: "EmailNotVerified" }, "ev=false");
            expect(unverified.body.error.message).toBe("Verify your email before booking");
            const verified = await send("post", "/api/__test/access/verified", await token({ sub: "101", role: "patient", ev: true }));
            expectOutcome(verified, { status: 201 }, "ev=true");
            expect(verified.body.data).toEqual({ userId: 101, role: "patient" });
        });
    });

    it("should key idempotency by the verified principal user:<id> on the verified route", async () => {
        await withFakeJwksCache(fake, async () => {
            const key = randomUUID();
            const patientA = await token({ sub: "101", role: "patient" });
            const first = await request(app)
                .post("/api/__test/access/verified")
                .set("Authorization", `Bearer ${patientA}`)
                .set("Idempotency-Key", key)
                .send({ note: "a" });
            const replay = await request(app)
                .post("/api/__test/access/verified")
                .set("Authorization", `Bearer ${patientA}`)
                .set("Idempotency-Key", key)
                .send({ note: "a" });
            expect(first.status).toBe(201);
            expect(replay.status).toBe(201);
            expect(replay.body).toEqual(first.body);
            expect(await redis.exists(`idem:POST /api/__test/access/verified:user:101:${key}`)).toBe(1);

            // Another principal with the same key and a different body is independent (no 422).
            const patientB = await request(app)
                .post("/api/__test/access/verified")
                .set("Authorization", `Bearer ${await token({ sub: "102", role: "patient" })}`)
                .set("Idempotency-Key", key)
                .send({ note: "b" });
            expect(patientB.status).toBe(201);
            expect(patientB.body.data).toEqual({ userId: 102, role: "patient" });
        });
    });

    it("should allow the owner, hide the resource from a patient non-owner (404), and forbid a doctor non-owner (403)", async () => {
        await withFakeJwksCache(fake, async () => {
            const cases: Array<[string, Record<string, unknown>, Expectation]> = [
                ["/api/__test/access/owned/1", { sub: "101", role: "patient" }, { status: 200 }],
                ["/api/__test/access/owned/2", { sub: "102", role: "patient" }, { status: 200 }],
                ["/api/__test/access/owned/1", { sub: "101", role: "doctor" }, { status: 200 }],
                ["/api/__test/access/owned/1", { sub: "102", role: "patient" }, { status: 404, code: "NotFound" }],
                ["/api/__test/access/owned/2", { sub: "102", role: "doctor" }, { status: 200 }],
                ["/api/__test/access/owned/2", { sub: "101", role: "doctor" }, { status: 403, code: "Forbidden" }],
                ["/api/__test/access/owned/3", { sub: "101", role: "patient" }, { status: 404, code: "NotFound" }],
                ["/api/__test/access/owned/3", { sub: "101", role: "doctor" }, { status: 404, code: "NotFound" }],
                ["/api/__test/access/owned/abc", { sub: "101", role: "patient" }, { status: 404, code: "NotFound" }],
                ["/api/__test/access/owned/01", { sub: "101", role: "patient" }, { status: 404, code: "NotFound" }],
            ];
            for (const [path, claims, expected] of cases) {
                expectOutcome(await send("get", path, await token(claims)), expected, `${String(claims.role)} ${String(claims.sub)} ${path}`);
            }
        });
    });

    it("should still answer 404 when a non-owner sends a body claiming ownership (A10)", async () => {
        await withFakeJwksCache(fake, async () => {
            const res = await request(app)
                .get("/api/__test/access/owned/1")
                .set("Authorization", `Bearer ${await token({ sub: "102", role: "patient" })}`)
                .set("X-User-Id", "101")
                .send({ ownerUserId: 101, userId: 101 });
            expectOutcome(res, { status: 404, code: "NotFound" }, "body claims ownership");
        });
    });

    it("should deny a pending patient with 403 before any ownership query, even on a resource it does not own (A9)", async () => {
        await withFakeJwksCache(fake, async () => {
            for (const path of ["/api/__test/access/owned/1", "/api/__test/access/owned/2", "/api/__test/access/owned/999"]) {
                const res = await send("get", path, await token({ sub: "101", role: "patient", status: "pending" }));
                // A resolver run would have answered 404 for 2 and 999: 403 proves the status check came first.
                expectOutcome(res, { status: 403, code: "Forbidden" }, path);
            }
        });
    });

    it("should block doctor 9001 on the checked route, allow other doctors, and not apply the check to admins", async () => {
        await withFakeJwksCache(fake, async () => {
            const path = "/api/__test/access/checked";
            expectOutcome(await send("get", path, await token({ sub: "9001", role: "doctor" })), { status: 403, code: "Forbidden" }, "doctor 9001");
            expectOutcome(await send("get", path, await token({ sub: "9002", role: "doctor" })), { status: 200 }, "doctor 9002");
            expectOutcome(await send("get", path, await token({ sub: "9001", role: "admin" })), { status: 200 }, "admin 9001");
        });
    });
});
