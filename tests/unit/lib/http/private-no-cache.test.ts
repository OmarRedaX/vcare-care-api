import express from "express";
import request from "supertest";
import { privateNoCache } from "../../../../src/lib/http/private-no-cache";

describe("lib/http/private-no-cache", () => {
    it("should set Cache-Control private, no-cache when the middleware is applied", async () => {
        const app = express();
        app.use("/covered", privateNoCache());
        app.get("/covered/x", (_req, res) => {
            res.status(200).json({ ok: true });
        });
        const res = await request(app).get("/covered/x");
        expect(res.status).toBe(200);
        expect(res.headers["cache-control"]).toBe("private, no-cache");
    });

    it("should not set Cache-Control when the middleware is absent", async () => {
        const app = express();
        app.use("/covered", privateNoCache());
        app.get("/other", (_req, res) => {
            res.status(200).json({ ok: true });
        });
        const res = await request(app).get("/other");
        expect(res.status).toBe(200);
        expect(res.headers["cache-control"]).toBeUndefined();
    });
});
