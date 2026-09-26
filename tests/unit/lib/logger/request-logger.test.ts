import { EventEmitter } from "node:events";
import type { NextFunction, Request, Response } from "express";
import { Logger } from "../../../../src/lib/logger/logger";
import { requestLogger } from "../../../../src/lib/logger/request-logger";

const REQUEST_ID = "5a3f9e1d-2b4c-4d6e-8f0a-1b2c3d4e5f60";

/** Fake req/res: the unit only reads a handful of fields and listens to `finish` / `close`. */
function setup(overrides: { method?: string; baseUrl?: string; routePath?: string; statusCode?: number; errorCode?: string; auth?: Request["auth"] } = {}) {
    const lines: Array<Record<string, unknown>> = [];
    const raw: string[] = [];
    const log = new Logger({
        level: "debug",
        service: "care-service",
        write: (line) => {
            raw.push(line);
            lines.push(JSON.parse(line) as Record<string, unknown>);
        },
    });

    const req = {
        method: overrides.method ?? "POST",
        baseUrl: overrides.baseUrl ?? "/api",
        url: "/api/consultations/42?email=synthetic.patient@example.test",
        originalUrl: "/api/consultations/42?email=synthetic.patient@example.test",
        query: { email: "synthetic.patient@example.test" },
        headers: { authorization: "Bearer synthetic-token-abc", "x-custom": "SYNTHETIC-HEADER-1" },
        body: { complaintText: "SYNTHETIC-COMPLAINT-7731" },
        requestId: REQUEST_ID,
        log,
        auth: overrides.auth,
        route: overrides.routePath === undefined ? undefined : { path: overrides.routePath },
    } as unknown as Request;

    const res = Object.assign(new EventEmitter(), {
        statusCode: overrides.statusCode ?? 200,
        locals: overrides.errorCode === undefined ? {} : { errorCode: overrides.errorCode },
    }) as unknown as Response & EventEmitter;

    const next = jest.fn() as NextFunction;
    requestLogger()(req, res, next);
    return { req, res, next, lines, raw };
}

describe("lib/logger/requestLogger", () => {
    it("should log route pattern, status, code, and durationMs when the response finishes", () => {
        const { res, next, lines } = setup({
            routePath: "/consultations/:id",
            statusCode: 409,
            errorCode: "SlotUnavailable",
            auth: { userId: 12, role: "patient", status: "active", emailVerified: true },
        });
        expect(next).toHaveBeenCalledTimes(1);

        res.emit("finish");

        expect(lines).toHaveLength(1);
        expect(lines[0]).toMatchObject({
            level: "info",
            message: "request_completed",
            requestId: REQUEST_ID,
            userId: 12,
            role: "patient",
            method: "POST",
            route: "/api/consultations/:id",
            status: 409,
            code: "SlotUnavailable",
        });
        expect(typeof lines[0]?.durationMs).toBe("number");
        expect(String(lines[0]?.durationMs)).toMatch(/^\d+(\.\d)?$/);
    });

    it('should log "unmatched" when no route matched', () => {
        const { res, lines } = setup({ statusCode: 404, errorCode: "NotFound" });
        res.emit("finish");
        expect(lines[0]?.route).toBe("unmatched");
    });

    it("should never log the URL, query, headers, or body when logging a request", () => {
        const { res, raw } = setup({ routePath: "/consultations/:id", statusCode: 500 });
        res.emit("finish");
        res.emit("close");
        const text = raw.join("");
        for (const fixture of [
            "synthetic.patient@example.test",
            "synthetic-token-abc",
            "SYNTHETIC-HEADER-1",
            "SYNTHETIC-COMPLAINT-7731",
            "/api/consultations/42",
        ]) {
            expect(text).not.toContain(fixture);
        }
    });

    it("should log at error when status is 5xx", () => {
        const { res, lines } = setup({ routePath: "/x", statusCode: 503 });
        res.emit("finish");
        expect(lines[0]?.level).toBe("error");
    });

    it("should log at debug when a health route succeeds", () => {
        const { res, lines } = setup({ baseUrl: "/api/health", routePath: "/ready", statusCode: 200, method: "GET" });
        res.emit("finish");
        expect(lines[0]).toMatchObject({ level: "debug", route: "/api/health/ready" });
    });

    it("should log at error when a health route fails with 5xx", () => {
        const { res, lines } = setup({ baseUrl: "/api/health", routePath: "/ready", statusCode: 503, method: "GET" });
        res.emit("finish");
        expect(lines[0]?.level).toBe("error");
    });

    it("should log request_aborted when the connection closes before finish", () => {
        const { res, lines } = setup({ routePath: "/consultations/:id" });
        res.emit("close");
        res.emit("finish");
        expect(lines).toHaveLength(1);
        expect(lines[0]).toMatchObject({
            level: "warn",
            message: "request_aborted",
            requestId: REQUEST_ID,
            method: "POST",
            route: "/api/consultations/:id",
        });
    });

    it("should log exactly one line when both finish and close fire", () => {
        const { res, lines } = setup({ routePath: "/x" });
        res.emit("finish");
        res.emit("close");
        expect(lines.map((line) => line.message)).toEqual(["request_completed"]);
    });
});
