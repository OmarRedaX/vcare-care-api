import { EMAIL_SEND_TIMEOUT_MS, OUTBOX_LEASE_SECONDS } from "../../../../src/app/notifications/constants";
import { envSchema } from "../../../../src/lib/config/env";

/** Seconds reserved for the contacts call (two 2 s timeouts are never both spent: one attempt per chunk). */
const CONTACTS_MARGIN_SECONDS = 2;

describe("outbox claim lease", () => {
    it("should outlast the worst-case batch for every OUTBOX_BATCH_SIZE the environment accepts (N-D3)", () => {
        const shape = envSchema.shape.OUTBOX_BATCH_SIZE;
        expect(shape.safeParse(60).success).toBe(false);
        const largest = shape.parse(59);
        expect(largest * (EMAIL_SEND_TIMEOUT_MS / 1000) + CONTACTS_MARGIN_SECONDS).toBeLessThan(OUTBOX_LEASE_SECONDS);
        // One more row would break the invariant, so the cap is tight rather than arbitrary.
        expect((largest + 1) * (EMAIL_SEND_TIMEOUT_MS / 1000) + CONTACTS_MARGIN_SECONDS).toBeGreaterThanOrEqual(OUTBOX_LEASE_SECONDS);
    });
});
