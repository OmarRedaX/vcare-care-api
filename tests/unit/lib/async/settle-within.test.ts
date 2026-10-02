import { settleWithin } from "../../../../src/lib/async/settle-within";

describe("lib/async/settleWithin", () => {
    afterEach(() => {
        jest.useRealTimers();
    });

    it("should resolve with the work's value when it settles before the timeout", async () => {
        await expect(settleWithin(Promise.resolve("done"), 500, "fallback")).resolves.toBe("done");
    });

    it("should resolve with the fallback when the work outlasts the timeout", async () => {
        jest.useFakeTimers();
        const pending = settleWithin(new Promise<string>(() => undefined), 500, "fallback");
        await jest.advanceTimersByTimeAsync(500);
        await expect(pending).resolves.toBe("fallback");
    });

    it("should clear its timer when the work settles first", async () => {
        jest.useFakeTimers();
        await settleWithin(Promise.resolve(true), 500, false);
        expect(jest.getTimerCount()).toBe(0);
    });

    it("should propagate a rejection when the work rejects before the timeout", async () => {
        await expect(settleWithin(Promise.reject(new Error("boom")), 500, "fallback")).rejects.toThrow("boom");
    });
});
