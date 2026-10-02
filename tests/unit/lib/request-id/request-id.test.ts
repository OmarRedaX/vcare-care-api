import express from "express";
import request from "supertest";
import { currentRequestId } from "../../../../src/lib/logger/request-context";
import { requestId } from "../../../../src/lib/request-id/request-id";
import { UUID_PATTERN } from "../../../../src/pkg/utils/uuid";

function harness() {
    const app = express();
    app.use(requestId());
    app.get("/t", (req, res) => {
        res.json({
            reqId: req.requestId,
            ctxId: currentRequestId(),
            headerAtHandler: res.getHeader("X-Request-Id"),
            hasLog: typeof req.log?.info === "function",
        });
    });
    return app;
}

describe("lib/request-id/requestId", () => {
    it("should adopt the incoming id when it is a UUID (F3)", async () => {
        const id = "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed";
        const res = await request(harness()).get("/t").set("X-Request-Id", id);
        expect(res.headers["x-request-id"]).toBe(id);
        expect(res.body).toMatchObject({ reqId: id, ctxId: id });
    });

    it("should lower-case an upper-case UUID when adopting it (F3)", async () => {
        const id = "1B9D6BCD-BBFD-4B2D-9B5D-AB8DFBBD4BED";
        const res = await request(harness()).get("/t").set("X-Request-Id", id);
        expect(res.headers["x-request-id"]).toBe(id.toLowerCase());
    });

    it("should generate a UUID when the header is absent (F3)", async () => {
        const res = await request(harness()).get("/t");
        expect(res.headers["x-request-id"]).toMatch(UUID_PATTERN);
        expect(res.body.reqId).toBe(res.headers["x-request-id"]);
    });

    it.each(["not-a-uuid", "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed-extra", "' OR 1=1 --", "a".repeat(300)])(
        "should replace the header when it is not a UUID (%p) (F3)",
        async (incoming) => {
            const res = await request(harness()).get("/t").set("X-Request-Id", incoming);
            expect(res.headers["x-request-id"]).toMatch(UUID_PATTERN);
            expect(res.headers["x-request-id"]).not.toBe(incoming);
        },
    );

    it("should generate a distinct id per request when none is supplied", async () => {
        const app = harness();
        const [a, b] = await Promise.all([request(app).get("/t"), request(app).get("/t")]);
        expect(a.headers["x-request-id"]).not.toBe(b.headers["x-request-id"]);
    });

    it("should set the response header before calling next", async () => {
        const res = await request(harness()).get("/t");
        expect(res.body.headerAtHandler).toBe(res.headers["x-request-id"]);
        expect(res.body.hasLog).toBe(true);
    });
});
