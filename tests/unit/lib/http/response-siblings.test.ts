import express from "express";
import request from "supertest";
import { sendSuccess } from "../../../../src/lib/http/response";

describe("sendSuccess siblings", () => {
    it("should render siblings next to data and keep success true", async () => {
        const app = express().get("/t", (_req, res) => sendSuccess(res, { id: 1 }, { status: 202, siblings: { identitySync: "pending" } }));
        const res = await request(app).get("/t");
        expect(res.status).toBe(202);
        expect(res.body).toEqual({ success: true, identitySync: "pending", data: { id: 1 } });
    });

    it("should never let a sibling replace success or data", async () => {
        const app = express().get("/t", (_req, res) => sendSuccess(res, { id: 1 }, { siblings: { success: false, data: "hijacked", extra: 1 } }));
        const res = await request(app).get("/t");
        expect(res.body).toEqual({ success: true, data: { id: 1 }, extra: 1 });
    });

    it("should render siblings together with meta", async () => {
        const meta = { nextCursor: null, hasMore: false, count: 0 };
        const app = express().get("/t", (_req, res) => sendSuccess(res, [], { meta, siblings: { note: "n" } }));
        expect((await request(app).get("/t")).body).toEqual({ note: "n", success: true, data: [], meta });
    });

    it("should add no extra member when siblings are omitted", async () => {
        const app = express().get("/t", (_req, res) => sendSuccess(res, { id: 1 }));
        expect(Object.keys((await request(app).get("/t")).body).sort()).toEqual(["data", "success"]);
    });
});
