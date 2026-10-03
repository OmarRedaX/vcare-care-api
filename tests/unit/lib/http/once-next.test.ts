import type { Request, Response } from "express";
import { onceNext } from "../../../../src/lib/http/once-next";
import { logger } from "../../../../src/lib/logger/logger";

const REQUEST_ID = "0b5d1f8e-3c1a-4f7e-9d2b-6a8c4e2f1a90";

/** A request matched on `POST /api/__test/idem` (what `routeLabel` reads), with a fresh `res.locals`. */
function matched(headersSent = false) {
    const res = { headersSent, locals: {} } as unknown as Response;
    const req = {
        method: "POST",
        baseUrl: "/api",
        route: { path: "/__test/idem" },
        requestId: REQUEST_ID,
        res,
    } as unknown as Request;
    return { req, res };
}

describe("lib/http/onceNext (L6)", () => {
    let error: jest.SpyInstance;

    beforeEach(() => {
        error = jest.spyOn(logger, "error").mockImplementation(() => undefined);
    });
    afterEach(() => {
        jest.restoreAllMocks();
    });

    it("should call next exactly once when forward is called repeatedly", () => {
        const { req, res } = matched();
        const next = jest.fn();
        const { forward } = onceNext(req, res, next, "test_internal_error");
        forward();
        forward(new Error("second"));
        expect(next).toHaveBeenCalledTimes(1);
        expect(next).toHaveBeenCalledWith(undefined);
    });

    it("should forward an error through fail when the request has not moved on", () => {
        const { req, res } = matched();
        const next = jest.fn();
        const failure = new Error("synthetic async failure");
        onceNext(req, res, next, "test_internal_error").fail(failure);
        expect(next).toHaveBeenCalledWith(failure);
        expect(error).not.toHaveBeenCalled();
    });

    it("should log a late error with the route and extra fields instead of forwarding it twice", () => {
        const { req, res } = matched();
        const next = jest.fn();
        const late = new Error("synthetic late failure");
        const { forward, fail } = onceNext(req, res, next, "test_internal_error", { limiter: "search" });
        forward();
        fail(late);
        expect(next).toHaveBeenCalledTimes(1);
        expect(error).toHaveBeenCalledWith("test_internal_error", {
            requestId: REQUEST_ID,
            route: "POST /api/__test/idem",
            limiter: "search",
            error: late,
        });
    });

    it("should log, not forward, when the headers were already sent", () => {
        const { req, res } = matched(true);
        const next = jest.fn();
        onceNext(req, res, next, "test_internal_error").fail(new Error("after headers"));
        expect(next).not.toHaveBeenCalled();
        expect(error).toHaveBeenCalledWith("test_internal_error", expect.objectContaining({ route: "POST /api/__test/idem" }));
    });

    it("should never call next after markResponded", () => {
        const { req, res } = matched();
        const next = jest.fn();
        const { forward, fail, markResponded } = onceNext(req, res, next, "test_internal_error");
        markResponded();
        forward();
        fail(new Error("after the replay"));
        expect(next).not.toHaveBeenCalled();
        expect(error).toHaveBeenCalledTimes(1);
    });
});
