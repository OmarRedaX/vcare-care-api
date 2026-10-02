import { MemoryLimiter } from "../../../../src/lib/rate-limit/memory-limiter";

describe("lib/rate-limit/MemoryLimiter", () => {
    it("should admit up to the limit then deny with the oldest hit when the window is full", () => {
        const limiter = new MemoryLimiter();
        expect(limiter.hit("k", 2, 1_000, 100)).toEqual({ allowed: true, oldestMs: 100 });
        expect(limiter.hit("k", 2, 1_000, 200)).toEqual({ allowed: true, oldestMs: 100 });
        expect(limiter.hit("k", 2, 1_000, 300)).toEqual({ allowed: false, oldestMs: 100 });
    });

    it("should admit again when the window slides past the oldest hit", () => {
        const limiter = new MemoryLimiter();
        limiter.hit("k", 1, 1_000, 0);
        expect(limiter.hit("k", 1, 1_000, 999).allowed).toBe(false);
        expect(limiter.hit("k", 1, 1_000, 1_000).allowed).toBe(true);
    });

    it("should not record denied hits when a client keeps retrying", () => {
        const limiter = new MemoryLimiter();
        limiter.hit("k", 1, 1_000, 0);
        for (let now = 100; now < 1_000; now += 100) {
            expect(limiter.hit("k", 1, 1_000, now).allowed).toBe(false);
        }
        expect(limiter.hit("k", 1, 1_000, 1_000).allowed).toBe(true);
    });

    it("should count keys independently", () => {
        const limiter = new MemoryLimiter();
        expect(limiter.hit("a", 1, 1_000, 0).allowed).toBe(true);
        expect(limiter.hit("b", 1, 1_000, 0).allowed).toBe(true);
        expect(limiter.hit("a", 1, 1_000, 1).allowed).toBe(false);
    });

    it("should evict the oldest key when maxKeys is exceeded", () => {
        const limiter = new MemoryLimiter(2);
        limiter.hit("first", 1, 60_000, 0);
        limiter.hit("second", 1, 60_000, 1);
        limiter.hit("third", 1, 60_000, 2); // evicts "first"

        expect(limiter.hit("first", 1, 60_000, 3).allowed).toBe(true); // forgotten → admitted again
        expect(limiter.hit("third", 1, 60_000, 4).allowed).toBe(false); // still remembered
    });

    it("should refresh a key's eviction position when it is hit again", () => {
        const limiter = new MemoryLimiter(2);
        limiter.hit("a", 5, 60_000, 0);
        limiter.hit("b", 5, 60_000, 1);
        limiter.hit("a", 5, 60_000, 2); // "a" becomes the newest
        limiter.hit("c", 5, 60_000, 3); // evicts "b", not "a"

        expect(limiter.hit("a", 2, 60_000, 4).allowed).toBe(false); // "a" kept its two hits
    });
});
