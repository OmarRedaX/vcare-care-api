import { headerBlock, idempotentOperations, parameterBlock, responseBlock } from "../../helpers/contract";

/**
 * Contract conformance for the in-flight idempotency case (review 2026-09-26, Medium): the middleware answers a
 * duplicate that arrives while the first attempt is still running with `409 Conflict` + `Retry-After: 1`
 * (src/lib/idempotency/idempotency.ts). A client generated from the contract must see that response and header on
 * every operation that takes `Idempotency-Key`, or it treats the retryable case as a final conflict.
 */
describe("contract: in-flight idempotency 409 + Retry-After", () => {
    const operations = idempotentOperations();

    it("should find the booking writes among the operations that take Idempotency-Key", () => {
        const keys = operations.map((operation) => `${operation.method} ${operation.path}`);
        expect(keys).toEqual(
            expect.arrayContaining([
                "POST /api/consultations",
                "PATCH /api/consultations/{id}/reschedule",
                "PATCH /api/consultations/{id}/cancel",
            ]),
        );
    });

    it.each(idempotentOperations().map((operation) => [`${operation.method} ${operation.path}`, operation] as const))(
        "should declare a 409 response with a Retry-After header when %s takes Idempotency-Key",
        (_label, operation) => {
            expect(operation.conflictResponse).toBeDefined();
            const block = responseBlock(operation.conflictResponse ?? "");
            expect(block).toMatch(/Retry-After:\s*\n\s+\$ref: '#\/components\/headers\/RetryAfter'/);
            expect(block).toContain("still being processed");
            expect(block).toContain("`Conflict`");
        },
    );

    it.each(["IdempotencyKeyRequired", "IdempotencyKeyOptional"])(
        "should describe the in-flight 409 Conflict with Retry-After 1 on the %s parameter",
        (name) => {
            const block = parameterBlock(name);
            expect(block).toContain("409 Conflict");
            expect(block).toContain("Retry-After: 1");
        },
    );

    it("should describe Retry-After for both the limiter and the in-flight idempotency case", () => {
        const block = headerBlock("RetryAfter");
        expect(block).toContain("429 RateLimited");
        expect(block).toContain("409 Conflict");
        expect(block).toContain("Idempotency-Key");
    });
});
