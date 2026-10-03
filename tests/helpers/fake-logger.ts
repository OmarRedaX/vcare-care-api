import type { Logger } from "../../src/lib/logger/logger";
import type { FakeLogger } from "./types";

/** A `Logger` stand-in whose methods are jest mocks (unit tests: the logger is a collaborator). */
export function fakeLogger(): FakeLogger {
    const mocks = {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        metric: jest.fn(),
    };
    return {
        ...mocks,
        logger: mocks as unknown as Logger,
        /** Every call of every method, serialized — for "never logged" assertions. */
        text: () => JSON.stringify(Object.values(mocks).map((mock) => mock.mock.calls)),
        messages: (level: "debug" | "info" | "warn" | "error") => mocks[level].mock.calls.map((call) => call[0] as string),
    };
}
