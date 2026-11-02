import { EventEmitter } from "node:events";
import http from "node:http";
import type { NextFunction, Request, Response } from "express";
import { container } from "../../../../src/lib/di/container";
import { TOKENS } from "../../../../src/lib/di/tokens";
import { InFlightCounter, inFlight } from "../../../../src/lib/lifecycle/in-flight";
import { ShutdownState } from "../../../../src/lib/lifecycle/shutdown-state";

function fakeRes(): Response & EventEmitter {
    return new EventEmitter() as unknown as Response & EventEmitter;
}

describe("lib/lifecycle/InFlightCounter + inFlight()", () => {
    it("should increment on entry and call next", () => {
        const counter = new InFlightCounter();
        const next = jest.fn() as NextFunction;
        inFlight(counter)({} as Request, fakeRes(), next);
        expect(counter.count).toBe(1);
        expect(next).toHaveBeenCalledTimes(1);
    });

    it("should decrement once when both finish and close fire", () => {
        const counter = new InFlightCounter();
        const res = fakeRes();
        inFlight(counter)({} as Request, res, jest.fn());
        inFlight(counter)({} as Request, fakeRes(), jest.fn());
        expect(counter.count).toBe(2);

        res.emit("finish");
        res.emit("close");
        res.emit("close");

        expect(counter.count).toBe(1);
    });

    it("should decrement on close when the response object has no end (minimal fake)", () => {
        const counter = new InFlightCounter();
        const res = fakeRes();
        inFlight(counter)({} as Request, res, jest.fn());
        res.emit("close");
        expect(counter.count).toBe(0);
    });

    it("should keep counting an aborted request until its handler ends the response (#12)", () => {
        const counter = new InFlightCounter();
        const end = jest.fn();
        const res = Object.assign(fakeRes(), { writableEnded: false, end });
        inFlight(counter)({} as Request, res, jest.fn());

        res.emit("close"); // the client went away; the handler is still running
        expect(counter.count).toBe(1);

        res.end("late"); // the handler finishes
        expect(end).toHaveBeenCalledWith("late");
        expect(counter.count).toBe(0);
        res.end("again");
        expect(counter.count).toBe(0);
    });

    it("should decrement on close when the response had already ended", () => {
        const counter = new InFlightCounter();
        const res = Object.assign(fakeRes(), { writableEnded: true, end: jest.fn() });
        inFlight(counter)({} as Request, res, jest.fn());
        res.emit("close");
        expect(counter.count).toBe(0);
    });

    it("should not wait for a close when the response finishes normally", () => {
        const counter = new InFlightCounter();
        const res = Object.assign(fakeRes(), { writableEnded: false, end: jest.fn() });
        inFlight(counter)({} as Request, res, jest.fn());
        res.end();
        expect(counter.count).toBe(1); // still flushing: finish releases it
        res.emit("finish");
        expect(counter.count).toBe(0);
    });

    it("should keep an aborted request in flight until its real handler ends the response (#12, real http server)", async () => {
        const counter = new InFlightCounter();
        let endResponse: () => void = () => undefined;
        let handlerEntered: () => void = () => undefined;
        const entered = new Promise<void>((resolve) => { handlerEntered = resolve; });
        const server = http.createServer((req, res) => {
            inFlight(counter)(req as unknown as Request, res as unknown as Response, () => {
                endResponse = () => res.end("late");
                handlerEntered();
            });
        });
        await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", resolve); });
        try {
            const { port } = server.address() as { port: number };
            const client = http.get({ host: "127.0.0.1", port, path: "/" });
            client.on("error", () => undefined);
            await entered;
            expect(counter.count).toBe(1);

            client.destroy(); // the client aborts while the handler is still running
            await new Promise<void>((resolve) => { setTimeout(resolve, 100); }); // `close` has fired by now
            expect(counter.count).toBe(1);

            endResponse();
            expect(counter.count).toBe(0);
        } finally {
            server.close();
        }
    });

    it("should resolve whenIdle when the count returns to zero", async () => {
        const counter = new InFlightCounter();
        const a = fakeRes();
        const b = fakeRes();
        inFlight(counter)({} as Request, a, jest.fn());
        inFlight(counter)({} as Request, b, jest.fn());

        let idle = false;
        const waiting = counter.whenIdle().then(() => {
            idle = true;
        });
        a.emit("finish");
        await Promise.resolve();
        expect(idle).toBe(false);

        b.emit("finish");
        await waiting;
        expect(idle).toBe(true);
    });

    it("should resolve whenIdle immediately when nothing is in flight", async () => {
        await expect(new InFlightCounter().whenIdle()).resolves.toBeUndefined();
    });

    it("should set Connection: close on responses written while shutting down", () => {
        const state = new ShutdownState();
        const headers = new Map<string, string>();
        const writeHead = jest.fn();
        const res = Object.assign(fakeRes(), {
            headersSent: false,
            setHeader: (name: string, value: string) => headers.set(name.toLowerCase(), value),
            writeHead,
        });
        inFlight(new InFlightCounter(), state)({} as Request, res, jest.fn());

        state.markShuttingDown(); // SIGTERM arrives while the request is in flight
        res.writeHead(200);

        expect(headers.get("connection")).toBe("close");
        expect(writeHead).toHaveBeenCalledWith(200);
    });

    it("should leave the Connection header alone when not shutting down", () => {
        const headers = new Map<string, string>();
        const res = Object.assign(fakeRes(), {
            headersSent: false,
            setHeader: (name: string, value: string) => headers.set(name.toLowerCase(), value),
            writeHead: jest.fn(),
        });
        inFlight(new InFlightCounter(), new ShutdownState())({} as Request, res, jest.fn());
        res.writeHead(200);
        expect(headers.has("connection")).toBe(false);
    });

    it("should never go below zero when decremented too often", () => {
        const counter = new InFlightCounter();
        counter.decrement();
        expect(counter.count).toBe(0);
    });

    it("should use the container counter when none is passed", () => {
        const registered = container.resolve<InFlightCounter>(TOKENS.InFlightCounter);
        const before = registered.count;
        const res = fakeRes();
        inFlight()({} as Request, res, jest.fn());
        expect(registered.count).toBe(before + 1);
        res.emit("finish");
        expect(registered.count).toBe(before);
    });
});

describe("lib/lifecycle/ShutdownState", () => {
    it("should report shutting down only after markShuttingDown is called", () => {
        const state = new ShutdownState();
        expect(state.isShuttingDown()).toBe(false);
        state.markShuttingDown();
        state.markShuttingDown();
        expect(state.isShuttingDown()).toBe(true);
    });
});
