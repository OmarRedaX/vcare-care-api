import { randomUUID } from "node:crypto";
import request from "supertest";
import { TOKENS } from "../../src/lib/di/tokens";
import { logger } from "../../src/lib/logger/logger";
import { buildTestApps, withContainerOverrides } from "../helpers/app";
import { closeDb, truncateAll } from "../helpers/db";
import { captureLogs, expectNoSensitiveStrings } from "../helpers/log-capture";
import { closeRedis, createUnreachableRedis, ensureRedisReady } from "../helpers/redis";
import { JWKS_PATH, startFakeJwks, withFakeJwksCache } from "../helpers/fake-jwks";
import {
    AUDIT_CLINICAL_FIXTURE,
    buildAccessTestRouter,
    buildAuditTestRouter,
    buildEnvelopeRouter,
    buildIdempotencyRouter,
    buildNestedRouter,
} from "../helpers/test-routers";
import { signExpiredUserToken, signUserToken, tamperToken } from "../helpers/tokens";
import type { FakeJwks } from "../helpers/types";

jest.setTimeout(20_000);

const COMPLAINT = "SYNTHETIC-COMPLAINT-7731";
const EMAIL = "synthetic.patient@example.test";
const TOKEN = "synthetic-bearer-token-5521";

function apps() {
    return buildTestApps({
        publicRouters: [
            { path: "/api", router: buildEnvelopeRouter() },
            { path: "/api", router: buildIdempotencyRouter() },
        ],
    });
}

/**
 * `.env.test` runs at LOG_LEVEL=warn, which would hide `request_completed` (info) and make "nothing leaked" a
 * vacuous claim. The root logger's level is raised to debug for this suite (restored afterwards) so every line
 * the request pipeline can write is actually written and inspected.
 */
describe("privacy of captured logs (integration)", () => {
    beforeAll(async () => {
        await ensureRedisReady();
        await truncateAll();
    });

    beforeEach(() => {
        jest.replaceProperty(logger as unknown as { level: string }, "level", "debug");
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    afterAll(async () => {
        await closeRedis();
        await closeDb();
    });

    it("should contain no synthetic complaint or email fixture strings in captured logs when requests with those values in bodies fail validation, fail JSON parsing, and throw (F7)", async () => {
        const { publicApp } = apps();
        const auth = `Bearer ${TOKEN}`;
        const capture = captureLogs();
        const statuses: number[] = [];
        try {
            // 1. DTO validation failure (unknown property carrying clinical text + PII).
            statuses.push(
                (
                    await request(publicApp)
                        .post(`/api/__test/echo?email=${encodeURIComponent(EMAIL)}`)
                        .set("Authorization", auth)
                        .send({ name: COMPLAINT, count: 2, item: { label: EMAIL }, complaintText: COMPLAINT, email: EMAIL })
                ).status,
            );
            // 2. Malformed JSON whose raw text carries the fixtures.
            statuses.push(
                (
                    await request(publicApp)
                        .post("/api/__test/echo")
                        .set("Authorization", auth)
                        .set("Content-Type", "application/json")
                        .send(`{"complaintText": "${COMPLAINT}", "email": "${EMAIL}",`)
                ).status,
            );
            // 3. An unhandled error thrown while the body carries the fixtures.
            statuses.push(
                (
                    await request(publicApp)
                        .post("/api/__test/boom")
                        .set("Authorization", auth)
                        .send({ complaintText: COMPLAINT, email: EMAIL })
                ).status,
            );
            // 4. A successful request whose body carries the fixtures.
            statuses.push(
                (
                    await request(publicApp)
                        .post("/api/__test/echo")
                        .set("Authorization", auth)
                        .set("Cookie", `session=${TOKEN}`)
                        .send({ name: "ok", count: 1, item: { label: "ok" } })
                ).status,
            );
        } finally {
            capture.restore();
        }

        expect(statuses).toEqual([400, 400, 500, 201]);

        // The pipeline really logged each request (so the absence below is meaningful) …
        const completed = capture.lines().filter((line) => line.message === "request_completed");
        expect(completed.map((line) => line.status)).toEqual([400, 400, 500, 201]);
        expect(completed.map((line) => line.code)).toEqual(["ValidationFailed", "ValidationFailed", "InternalError", undefined]);
        expect(capture.lines().some((line) => line.message === "unhandled_error")).toBe(true);

        // … and nothing sensitive reached stdout/stderr.
        expectNoSensitiveStrings(capture, [COMPLAINT, EMAIL, TOKEN, "Bearer ", "email=", "/api/__test/echo?"]);
    });

    // Regression (was known bug 1, review Critical): pg embeds the rejected VALUE in its error message
    // (`invalid input syntax for type integer: "<value>"`) and V8 repeats it in the lazily formatted stack header.
    // serializeError now drops the message of database errors and rebuilds the stack from frames only.
    it.each([
        ["22P02", "int", COMPLAINT],
        ["22007", "timestamptz", COMPLAINT],
        ["22008", "date", "1990-02-30"],
    ])(
        "should not leak a request value into logs when Postgres rejects it with %s in an unhandled error (F7)",
        async (code, type, value) => {
            const { publicApp } = apps();
            const capture = captureLogs();
            let status: number;
            try {
                status = (await request(publicApp).post("/api/__test/db-cast").send({ value, type })).status;
            } finally {
                capture.restore();
            }
            expect(status).toBe(500);
            const unhandled = capture.lines().find((line) => line.message === "unhandled_error");
            expect(unhandled?.error).toMatchObject({ code });
            expectNoSensitiveStrings(capture, [value]);
        },
    );

    it("should not leak a request value into logs when a CHECK constraint rejects it in an unhandled error (F7)", async () => {
        const { publicApp } = apps();
        const capture = captureLogs();
        let status: number;
        try {
            status = (await request(publicApp).post("/api/__test/db-check").send({ value: COMPLAINT })).status;
        } finally {
            capture.restore();
        }
        expect(status).toBe(500);
        const unhandled = capture.lines().find((line) => line.message === "unhandled_error");
        expect(unhandled?.error).toMatchObject({ code: "23514", constraint: "chk_check_probe_short" });
        expectNoSensitiveStrings(capture, [COMPLAINT]);
    });

    it("should never log the Idempotency-Key when idempotency is skipped because Redis is down", async () => {
        const unreachable = createUnreachableRedis();
        const key = randomUUID();
        const capture = captureLogs();
        try {
            await withContainerOverrides([{ token: TOKENS.Redis, value: unreachable }], async () => {
                const { publicApp } = apps();
                const res = await request(publicApp)
                    .post("/api/__test/idem")
                    .set("Idempotency-Key", key)
                    .send({ complaintText: COMPLAINT });
                expect(res.status).toBe(201);
            });
        } finally {
            capture.restore();
            unreachable.disconnect();
        }

        const skipped = capture.lines().find((line) => line.message === "idempotency_skipped");
        expect(skipped).toMatchObject({ level: "warn", route: "POST /api/__test/idem", reason: "redis_not_ready" });
        expect(
            capture.lines().some((line) => line.message === "metric" && line.metric === "idempotency_skipped"),
        ).toBe(true);
        expectNoSensitiveStrings(capture, [key, COMPLAINT]);
    });

    it("should carry the response's X-Request-Id on a log line written by a test service called from a route (AsyncLocalStorage)", async () => {
        const { publicApp } = apps();
        const capture = captureLogs();
        let first;
        let second;
        try {
            [first, second] = await Promise.all([
                request(publicApp).get("/api/__test/context"),
                request(publicApp).get("/api/__test/context").set("X-Request-Id", "6fa459ea-ee8a-4ca4-894e-db77e160355e"),
            ]);
        } finally {
            capture.restore();
        }

        const serviceLines = capture.lines().filter((line) => line.message === "test_service_called");
        expect(serviceLines).toHaveLength(2);
        expect(serviceLines.map((line) => line.requestId).sort()).toEqual(
            [first.headers["x-request-id"], second.headers["x-request-id"]].sort(),
        );
        expect(second.headers["x-request-id"]).toBe("6fa459ea-ee8a-4ca4-894e-db77e160355e");

        // The request log line for the same request carries the same id.
        const completed = capture.lines().filter((line) => line.message === "request_completed");
        expect(completed.map((line) => line.requestId).sort()).toEqual(serviceLines.map((line) => line.requestId).sort());
        expect(completed[0]).toMatchObject({ route: "/api/__test/context", method: "GET", service: "care-service" });
    });

    describe("access: tokens, RBAC, audit, JWKS failures", () => {
        const KID = "kid-log-probe-5521";
        const JTI = "jti-log-probe-8812";
        let fake: FakeJwks;

        beforeAll(async () => {
            fake = await startFakeJwks([KID]);
        });

        afterAll(async () => {
            await fake.close();
        });

        function accessApp() {
            return buildTestApps({
                publicRouters: [
                    { path: "/api", router: buildAccessTestRouter() },
                    { path: "/api", router: buildAuditTestRouter() },
                    { path: "/api", router: buildNestedRouter() },
                ],
            }).publicApp;
        }

        it("regression #6: should keep the full mount prefix in request_completed.route when a nested router's handler throws", async () => {
            const app = accessApp();
            const admin = await signUserToken(fake.key(KID), { sub: "303", role: "admin" });
            const capture = captureLogs();
            try {
                await withFakeJwksCache(fake, async () => {
                    expect((await request(app).get("/api/__test/nested/inner/boom/42")).status).toBe(500);
                    expect(
                        (await request(app).get("/api/__test/nested/guarded/boom/42").set("Authorization", `Bearer ${admin}`)).status,
                    ).toBe(500);
                });
            } finally {
                capture.restore();
            }
            const routes = capture
                .lines()
                .filter((line) => line.message === "request_completed")
                .map((line) => line.route);
            expect(routes).toEqual(["/api/__test/nested/inner/boom/:id", "/api/__test/nested/guarded/boom/:id"]);
            // L7: the unhandled_error line itself names the route (on-call needs no join on requestId).
            const unhandled = capture.lines().filter((line) => line.message === "unhandled_error");
            expect(unhandled.map((line) => [line.route, line.status])).toEqual([
                ["GET /api/__test/nested/inner/boom/:id", 500],
                ["GET /api/__test/nested/guarded/boom/:id", 500],
            ]);
            expectNoSensitiveStrings(capture, ["/boom/42"]);
        });

        it("should never log a token, its parts, the Authorization header, the JWKS path, a kid, a jti, or an audit metadata value", async () => {
            const app = accessApp();
            const key = fake.key(KID);
            const tokens = {
                patient: await signUserToken(key, { sub: "101", role: "patient", jti: JTI }),
                admin: await signUserToken(key, { sub: "303", role: "admin", jti: JTI }),
                unverified: await signUserToken(key, { sub: "101", role: "patient", ev: false, jti: JTI }),
                suspended: await signUserToken(key, { sub: "202", role: "doctor", status: "suspended", jti: JTI }),
                expired: await signExpiredUserToken(key, { jti: JTI }),
                tampered: tamperToken(await signUserToken(key, { jti: JTI })),
                service: await signUserToken(key, { typ: "service", jti: JTI }),
            };
            const unknownKid = await signUserToken(key, { jti: JTI }, { header: { kid: "kid-unknown-log-probe-3307" } });
            const bearer = (token: string) => `Bearer ${token}`;

            const capture = captureLogs();
            const statuses: number[] = [];
            try {
                await withFakeJwksCache(fake, async ({ cache }) => {
                    const get = async (path: string, token?: string) => {
                        const req = request(app).get(path);
                        statuses.push((token === undefined ? await req : await req.set("Authorization", bearer(token))).status);
                    };
                    await get("/api/__test/access/any", tokens.patient); // 200
                    await get("/api/__test/access/admin", tokens.patient); // 403 role
                    await get("/api/__test/access/onboarding", tokens.suspended); // 403 status
                    await get("/api/__test/access/owned/2", tokens.patient); // 404 ownership
                    await get("/api/__test/access/any", tokens.expired); // 401 TokenExpired
                    await get("/api/__test/access/any", tokens.tampered); // 401
                    await get("/api/__test/access/any", tokens.service); // 401
                    await get("/api/__test/access/any", unknownKid); // 401 after a gated refetch
                    statuses.push(
                        (await request(app).post("/api/__test/access/verified").set("Authorization", bearer(tokens.unverified)).send({}))
                            .status,
                    ); // 403 EmailNotVerified
                    for (const body of [{}, { fail: true }, { invalid: true }]) {
                        statuses.push(
                            (await request(app).post("/api/__test/audit").set("Authorization", bearer(tokens.admin)).send(body)).status,
                        ); // 201, 500, 500
                    }

                    // JWKS failures: a 503 and a malformed body are logged with host and reason only.
                    fake.setMode("fail", { status: 503 });
                    await cache.refresh("interval");
                    fake.setMode("normal");
                    fake.setBody('{"keys":[{"kty":"OKP","x":"SYNTHETIC-JWKS-BODY-4410"}]}');
                    await cache.refresh("interval");
                    fake.setBody(undefined);
                });
            } finally {
                capture.restore();
            }

            expect(statuses).toEqual([200, 403, 403, 404, 401, 401, 401, 401, 403, 201, 500, 500]);
            // The pipeline really logged (so the absence below is meaningful).
            const messages = capture.lines().map((line) => line.message);
            expect(messages.filter((message) => message === "request_completed")).toHaveLength(12);
            expect(messages).toEqual(expect.arrayContaining(["access_denied", "jwks_refresh_failed", "unhandled_error", "jwks_refreshed"]));
            const denied = capture.lines().filter((line) => line.message === "access_denied");
            expect(denied.map((line) => line.reason)).toEqual(
                expect.arrayContaining(["role", "status", "ownership_not_found", "email_unverified"]),
            );
            expect(capture.lines().find((line) => line.message === "jwks_refresh_failed")).toMatchObject({
                host: new URL(fake.jwksUrl).host,
                reason: "http_status",
                status: 503,
            });

            const forbidden: string[] = [
                "Bearer ",
                JWKS_PATH,
                KID,
                "kid-unknown-log-probe-3307",
                JTI,
                '"reason":"synthetic"',
                AUDIT_CLINICAL_FIXTURE,
                "SYNTHETIC-JWKS-BODY-4410",
                ...Object.values(tokens).flatMap((token) => [token, ...token.split(".")]),
                unknownKid,
            ];
            expectNoSensitiveStrings(capture, forbidden);
            expect(capture.text().toLowerCase()).not.toContain("authorization");
        });
    });
});
