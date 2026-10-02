import express from "express";
import request from "supertest";
import { noStore } from "../../../../src/lib/http/no-store";
import { sendNoContent, sendSuccess } from "../../../../src/lib/http/response";

describe("lib/http/response", () => {
    it("should send success with data and no meta when meta is omitted", async () => {
        const app = express().get("/t", (_req, res) => sendSuccess(res, { id: 1 }));
        const res = await request(app).get("/t");
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ success: true, data: { id: 1 } });
        expect(Object.keys(res.body)).not.toContain("meta");
    });

    it("should include meta when provided", async () => {
        const meta = { nextCursor: null, hasMore: false, count: 0 };
        const app = express().get("/t", (_req, res) => sendSuccess(res, [], { meta }));
        const res = await request(app).get("/t");
        expect(res.body).toEqual({ success: true, data: [], meta });
    });

    it.each([201, 202] as const)("should use status %p when it is provided", async (status) => {
        const app = express().post("/t", (_req, res) => sendSuccess(res, { ok: true }, { status }));
        const res = await request(app).post("/t");
        expect(res.status).toBe(status);
        expect(res.body.success).toBe(true);
    });

    it("should send 204 with no body when sendNoContent is called", async () => {
        const app = express().delete("/t", (_req, res) => sendNoContent(res));
        const res = await request(app).delete("/t");
        expect(res.status).toBe(204);
        expect(res.text).toBe("");
    });

    it("should set Cache-Control no-store when noStore is applied", async () => {
        const app = express().get("/t", noStore(), (_req, res) => sendSuccess(res, { ok: true }));
        const res = await request(app).get("/t");
        expect(res.headers["cache-control"]).toBe("no-store");
    });

    it("should not set Cache-Control no-store when noStore is not applied", async () => {
        const app = express().get("/t", (_req, res) => sendSuccess(res, { ok: true }));
        const res = await request(app).get("/t");
        expect(res.headers["cache-control"]).not.toBe("no-store");
    });
});
