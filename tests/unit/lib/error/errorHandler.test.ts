import express from "express";
import type { NextFunction, Request, Response } from "express";
import request from "supertest";
import { errorHandler } from "../../../../src/lib/error/errorHandler";
import { Conflict, NotFound } from "../../../../src/lib/error/errors";
import { AppError } from "../../../../src/lib/error/AppError";
import { captureLogs } from "../../../helpers/log-capture";
import type { LogCapture } from "../../../helpers/types";

const REQUEST_ID = "0b6f3d8e-1c2a-4e5f-9a7b-3c4d5e6f7a8b";

/** Minimal harness: a fixed request id, the JSON parser, one throwing route, and the unit under test. */
function harness(route: (req: Request, res: Response, next: NextFunction) => void, onErrorCode?: (code: unknown) => void) {
    const app = express();
    app.use((req, res, next) => {
        req.requestId = REQUEST_ID;
        res.on("finish", () => onErrorCode?.((res.locals as { errorCode?: unknown }).errorCode));
        next();
    });
    app.use(express.json({ limit: "100kb", strict: true, type: "application/json" }));
    app.all("/t", route);
    app.use(errorHandler);
    return app;
}

describe("lib/error/errorHandler", () => {
    let logs: LogCapture;
    beforeEach(() => {
        logs = captureLogs();
    });
    afterEach(() => {
        logs.restore();
    });

    it("should render the envelope with status and code when an AppError is thrown (F4)", async () => {
        const res = await request(
            harness(() => {
                throw NotFound;
            }),
        ).get("/t");

        expect(res.status).toBe(404);
        expect(res.body).toEqual({
            success: false,
            error: { code: "NotFound", message: "Resource not found", details: [], requestId: REQUEST_ID },
        });
    });

    it("should include an empty details array when the error has none", async () => {
        const res = await request(
            harness(() => {
                throw Conflict;
            }),
        ).get("/t");
        expect(res.body.error.details).toEqual([]);
    });

    it("should render details when the AppError carries them", async () => {
        const res = await request(
            harness(() => {
                throw Conflict.withDetails([{ field: "slug", issue: "is taken" }]);
            }),
        ).get("/t");
        expect(res.body.error.details).toEqual([{ field: "slug", issue: "is taken" }]);
    });

    it("should merge extra members next to error when withExtra is used", async () => {
        const res = await request(
            harness(() => {
                throw Conflict.withExtra({ conflicts: { consultationIds: [1, 2], count: 2 } });
            }),
        ).get("/t");
        expect(res.status).toBe(409);
        expect(res.body.conflicts).toEqual({ consultationIds: [1, 2], count: 2 });
        expect(res.body.error.code).toBe("Conflict");
        expect(Object.keys(res.body).sort()).toEqual(["conflicts", "error", "success"]);
    });

    it("should return 400 ValidationFailed when JSON is malformed (F5)", async () => {
        const res = await request(harness((_req, res) => res.end()))
            .post("/t")
            .set("Content-Type", "application/json")
            .send('{"complaintText": "SYNTHETIC-COMPLAINT-7731",');

        expect(res.status).toBe(400);
        expect(res.body.error).toEqual({
            code: "ValidationFailed",
            message: "Request validation failed",
            details: [{ field: "body", issue: "must be valid JSON" }],
            requestId: REQUEST_ID,
        });
        expect(JSON.stringify(res.body)).not.toContain("SYNTHETIC-COMPLAINT-7731");
        expect(logs.text()).not.toContain("SYNTHETIC-COMPLAINT-7731");
    });

    it("should return 400 ValidationFailed when the payload is too large (F5)", async () => {
        const res = await request(harness((_req, res) => res.end()))
            .post("/t")
            .set("Content-Type", "application/json")
            .send(JSON.stringify({ blob: "x".repeat(101 * 1024) }));

        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe("ValidationFailed");
        expect(res.body.error.details).toEqual([{ field: "body", issue: "must not exceed 100kb" }]);
    });

    it("should return 400 ValidationFailed with 'could not be read' when the charset is unsupported (F5)", async () => {
        const res = await request(harness((_req, res) => res.end()))
            .post("/t")
            .set("Content-Type", "application/json; charset=klingon-8")
            .send("{}");

        expect(res.status).toBe(400);
        expect(res.body.error.details).toEqual([{ field: "body", issue: "could not be read" }]);
    });

    it("should return 500 InternalError without the original message when an unknown error is thrown (F4)", async () => {
        const res = await request(
            harness(() => {
                throw new Error("SELECT password_hash FROM secret_table -- synthetic internals");
            }),
        ).get("/t");

        expect(res.status).toBe(500);
        expect(res.body).toEqual({
            success: false,
            error: { code: "InternalError", message: "An unexpected error occurred", details: [], requestId: REQUEST_ID },
        });
        expect(res.text).not.toContain("secret_table");
        expect(res.text).not.toContain("stack");
    });

    it("should return 500 InternalError when a non-Error value is thrown", async () => {
        const res = await request(
            harness((_req, _res, next) => {
                next("synthetic string failure");
            }),
        ).get("/t");
        expect(res.status).toBe(500);
        expect(res.body.error.code).toBe("InternalError");
        expect(res.text).not.toContain("synthetic string failure");
    });

    it("should log the stack when an unknown error is thrown", async () => {
        await request(
            harness(() => {
                throw new Error("synthetic unknown failure");
            }),
        ).get("/t");

        const line = logs.lines().find((entry) => entry.message === "unhandled_error");
        expect(line).toBeDefined();
        expect(line?.level).toBe("error");
        expect(line?.requestId).toBe(REQUEST_ID);
        expect(line?.route).toBe("GET /t"); // L7
        expect(line?.status).toBe(500);
        const error = line?.error as { name: string; message?: string; stack?: string };
        expect(error.name).toBe("Error");
        expect(error.message).toBe("synthetic unknown failure");
        expect(error.stack?.split("\n")[1]).toMatch(/^\s+at /);
    });

    it("should log a database error without its message or the rejected value when an unknown error is a pg error (F7)", async () => {
        await request(
            harness(() => {
                throw Object.assign(new Error('invalid input syntax for type integer: "SYNTHETIC-COMPLAINT-7731"'), {
                    code: "22P02",
                    severity: "ERROR",
                });
            }),
        ).get("/t");

        const line = logs.lines().find((entry) => entry.message === "unhandled_error");
        expect(line?.error).toMatchObject({ name: "Error", code: "22P02", severity: "ERROR" });
        expect(logs.text()).not.toContain("SYNTHETIC-COMPLAINT-7731");
    });

    it("should not call next or print a raw stack when headers were already sent (parity b)", () => {
        const next = jest.fn();
        const res = { headersSent: true, end: jest.fn() } as unknown as Response;
        errorHandler(new Error("late failure"), { requestId: REQUEST_ID } as Request, res, next);
        expect(next).not.toHaveBeenCalled();
        expect((res.end as jest.Mock).mock.calls).toHaveLength(1);
        expect(logs.lines().filter((entry) => entry.message === "error_after_headers_sent")).toHaveLength(1);
    });

    it("should log a 5xx AppError at error level and not log a 4xx AppError", async () => {
        const custom5xx = new AppError("InternalError", 500, "An unexpected error occurred");
        await request(
            harness(() => {
                throw custom5xx;
            }),
        ).get("/t");
        await request(
            harness(() => {
                throw Conflict;
            }),
        ).get("/t");

        const errorLines = logs.lines().filter((entry) => entry.message === "unhandled_error");
        expect(errorLines).toHaveLength(1);
        expect(errorLines[0]).toMatchObject({ code: "InternalError", route: "GET /t", status: 500 });
    });

    it("should not write a second body when headers were already sent", async () => {
        const res = await request(
            harness((_req, res, next) => {
                res.status(200);
                res.write("partial");
                next(new Error("late failure"));
            }),
        ).get("/t");

        expect(res.status).toBe(200);
        expect(res.text).toBe("partial");
        expect(logs.lines().find((entry) => entry.message === "error_after_headers_sent")).toMatchObject({
            route: "GET /t", // L7
            status: 200,
        });
    });

    it("should set res.locals.errorCode when rendering an error", async () => {
        const codes: unknown[] = [];
        await request(
            harness(
                () => {
                    throw Conflict;
                },
                (code) => codes.push(code),
            ),
        ).get("/t");
        expect(codes).toEqual(["Conflict"]);
    });
});

/** Foundation issue #5: a malformed percent-encoded path parameter used to be a 500 with the raw value logged. */
describe("regression #5: lib/error/errorHandler client errors", () => {
    let logs: LogCapture;
    beforeEach(() => {
        logs = captureLogs();
    });
    afterEach(() => {
        logs.restore();
    });

    it("should map a URIError to 400 ValidationFailed with the path detail and no log line", async () => {
        const app = harness(() => {
            const error = new URIError("Failed to decode param '%E0%A4%A'");
            (error as URIError & { status: number }).status = 400;
            throw error;
        });
        const res = await request(app).get("/t");
        expect(res.status).toBe(400);
        expect(res.body.error).toEqual({
            code: "ValidationFailed",
            message: "Request validation failed",
            details: [{ field: "path", issue: "must be valid percent-encoding" }],
            requestId: REQUEST_ID,
        });
        expect(logs.lines()).toEqual([]);
        expect(logs.text()).not.toContain("%E0%A4%A");
    });

    it("should map a URIError from a real Express 5 :param route to 400 without echoing the raw value", async () => {
        const app = express();
        app.use((req, _res, next) => {
            req.requestId = REQUEST_ID;
            next();
        });
        app.get("/things/:value", (_req, res) => {
            res.json({ ok: true });
        });
        app.use(errorHandler);
        const res = await request(app).get("/things/%E0%A4%A");
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe("ValidationFailed");
        expect(JSON.stringify(res.body)).not.toContain("%E0%A4%A");
        expect(logs.text()).not.toContain("%E0%A4%A");
        expect(logs.lines().some((line) => line.message === "unhandled_error")).toBe(false);
    });

    it("should map a non-AppError with status 404 to NotFound and other 4xx to ValidationFailed without echoing the message", async () => {
        const cases: Array<[Record<string, unknown>, number, string, unknown[]]> = [
            [{ status: 404 }, 404, "NotFound", []],
            [{ statusCode: 404 }, 404, "NotFound", []],
            [{ status: 413 }, 400, "ValidationFailed", [{ field: "request", issue: "could not be processed" }]],
            [{ statusCode: 415 }, 400, "ValidationFailed", [{ field: "request", issue: "could not be processed" }]],
        ];
        for (const [props, status, code, details] of cases) {
            const app = harness(() => {
                throw Object.assign(new Error("SYNTHETIC-RAW-VALUE-6610 in the message"), { name: "LibraryError" }, props);
            });
            const res = await request(app).get("/t");
            expect(res.status).toBe(status);
            expect(res.body.error.code).toBe(code);
            expect(res.body.error.details).toEqual(details);
            expect(JSON.stringify(res.body)).not.toContain("SYNTHETIC-RAW-VALUE-6610");
        }
        const mapped = logs.lines().filter((line) => line.message === "client_error_mapped");
        expect(mapped).toHaveLength(4);
        expect(mapped[0]).toMatchObject({ level: "warn", name: "LibraryError", status: 404 });
        expect(logs.text()).not.toContain("SYNTHETIC-RAW-VALUE-6610");
    });

    it.each<[string, Record<string, unknown>]>([
        ["no status", {}],
        ["a 5xx status", { status: 503 }],
        ["a 3xx status", { status: 302 }],
        ["a non-integer status", { status: 404.5 }],
        ["a string status", { status: "404" }],
    ])("should keep 500 InternalError for a non-AppError with %s", async (_label, props) => {
        const app = harness(() => {
            throw Object.assign(new Error("boom"), props);
        });
        const res = await request(app).get("/t");
        expect(res.status).toBe(500);
        expect(res.body.error.code).toBe("InternalError");
        expect(logs.lines().some((line) => line.message === "unhandled_error")).toBe(true);
    });
});
