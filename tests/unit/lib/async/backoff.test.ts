import { backoffMs, exponentialBackoffMs } from "../../../../src/lib/async/backoff";

describe("lib/async/backoff", () => {
    it("should double from the base and apply no jitter at random 0.5", () => {
        expect([0, 1, 2, 3].map((attempt) => exponentialBackoffMs(30_000, attempt, 1_800_000, () => 0.5))).toEqual([30_000, 60_000, 120_000, 240_000]);
    });

    it("should cap the delay at the cap even with the highest jitter", () => {
        expect(exponentialBackoffMs(30_000, 20, 1_800_000, () => 1)).toBe(1_800_000);
        expect(exponentialBackoffMs(30_000, 6, 1_800_000, () => 0.5)).toBe(1_800_000);
    });

    it("should keep jitter within plus or minus 20 percent", () => {
        expect(exponentialBackoffMs(30_000, 1, 1_800_000, () => 0)).toBe(48_000);
        expect(exponentialBackoffMs(30_000, 1, 1_800_000, () => 1)).toBe(72_000);
    });

    it("should treat a negative attempt as the first", () => {
        expect(exponentialBackoffMs(200, -3, 60_000, () => 0.5)).toBe(200);
    });

    it("should keep backoffMs at 200 ms * 2^attempt capped at 60 s", () => {
        expect(backoffMs(0, () => 0.5)).toBe(200);
        expect(backoffMs(2, () => 0.5)).toBe(800);
        expect(backoffMs(30, () => 0.5)).toBe(60_000);
        expect(backoffMs(30, () => 0.5, 1_000)).toBe(1_000);
    });
});
