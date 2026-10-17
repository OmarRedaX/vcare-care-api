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
    ["/api/admin", "/api/admin/doctors/1/suspend"],
    ["/api/audit-logs", "/api/audit-logs"],
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
});
