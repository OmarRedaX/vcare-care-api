import type { Express } from "express";
import request from "supertest";
import { buildTestApps } from "../helpers/app";
import { contractNoStoreValue, expectErrorEnvelope } from "../helpers/contract";
import { closeDb } from "../helpers/db";
import { closeRedis } from "../helpers/redis";

jest.setTimeout(30_000);

/** One path per no-store prefix (src/routes.ts `NO_STORE_PREFIXES`); the body is unparseable JSON. */
const PREFIX_PATHS: ReadonlyArray<readonly [string, string]> = [
    ["/api/patients", "/api/patients/me"],
    ["/api/consultations", "/api/consultations"],
    ["/api/records", "/api/records/1"],
    ["/api/records", "/api/records/1/attachments/uploads"],
    ["/api/records", "/api/records/1/attachments/uploads/1/complete"],
    ["/api/records", "/api/records/1/attachments/1/download-url"],
    ["/api/admin", "/api/admin/doctors/1/suspend"],
    ["/api/admin", "/api/admin/applications/1/documents/1/download-url"],
    ["/api/audit-logs", "/api/audit-logs"],
];

/**
 * Presigned-URL routes. The doctor route gets no-store from the doctors router's `/doctors/me` middleware, which runs after body
 * parsing, so the malformed-JSON probe above cannot reach it: an unauthenticated call is refused by the guard, behind that middleware.
 * The admin route is also covered by `NO_STORE_PREFIXES` (`/api/admin`). The verification router's scoped `noStore()` is a second layer on both.
 */
const VERIFICATION_URL_PATHS: readonly string[] = [
    "/api/doctors/me/documents/1/download-url",
    "/api/admin/applications/1/documents/1/download-url",
];

describe("no-store prefixes (integration: real middleware chain)", () => {
    let app: Express;

    beforeAll(() => { app = buildTestApps().publicApp; });
    afterAll(async () => { await closeRedis(); await closeDb(); });

    it.each(PREFIX_PATHS)("should send Cache-Control no-store on a malformed-JSON 400 under %s", async (_prefix, path) => {
        const res = await request(app).post(path).set("Content-Type", "application/json").send("{ not json");
        expect(res.status).toBe(400);
        expectErrorEnvelope(res.body, "ValidationFailed", res.headers["x-request-id"]);
        expect(res.headers["cache-control"]).toBe(contractNoStoreValue());
    });

    it.each(VERIFICATION_URL_PATHS)("should send Cache-Control no-store on the 401 of the presigned-URL route %s", async (path) => {
        const res = await request(app).post(path).send({});
        expect(res.status).toBe(401);
        expectErrorEnvelope(res.body, "Unauthorized", res.headers["x-request-id"]);
        expect(res.headers["cache-control"]).toBe(contractNoStoreValue());
    });
});
