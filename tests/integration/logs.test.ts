import { randomUUID } from "node:crypto";
import request from "supertest";
import { TOKENS } from "../../src/lib/di/tokens";
import { logger } from "../../src/lib/logger/logger";
import { buildTestApps, withContainerOverrides } from "../helpers/app";
import { closeDb, truncateAll } from "../helpers/db";
import { captureLogs, expectNoSensitiveStrings } from "../helpers/log-capture";
import { closeRedis, createUnreachableRedis, ensureRedisReady } from "../helpers/redis";
import { buildEnvelopeRouter, buildIdempotencyRouter } from "../helpers/test-routers";

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

    // PRODUCT BUG (privacy, CLAUDE.md → Privacy and logging): pg embeds the rejected VALUE in its error message
    // (`invalid input syntax for type integer: "<value>"`), and serializeError (src/lib/logger/logger.ts:25-37)
    // keeps `message` and `stack`, which errorHandler logs as `unhandled_error` (src/lib/error/errorHandler.ts:49).
    // Any request value that reaches a failing query is therefore written to the logs verbatim.
    test.failing("should not leak a request value into logs when Postgres rejects it in an unhandled error (F7)", async () => {
        const { publicApp } = apps();
        const capture = captureLogs();
        let status: number;
        try {
            status = (await request(publicApp).post("/api/__test/db-cast").send({ value: COMPLAINT })).status;
        } finally {
            capture.restore();
        }
        expect(status).toBe(500);
        expect(capture.lines().some((line) => line.message === "unhandled_error")).toBe(true);
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
});
