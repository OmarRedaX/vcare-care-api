/* eslint-disable @typescript-eslint/unbound-method */
import { buildIdentitySyncLoop } from "../../../../src/app/identity-sync/worker/identity-sync.loop";
import type { IdentitySyncService } from "../../../../src/app/identity-sync/service/identity-sync.service";
import type { Logger } from "../../../../src/lib/logger/logger";

const signal = () => new AbortController().signal;
const logger = { error: jest.fn(), metric: jest.fn(), info: jest.fn(), debug: jest.fn() } as unknown as Logger;

// Ported from tests/unit/app/verification/verification-worker.test.ts (sync engine extraction, ADR 0021): bodies unchanged
// except for the service type and `listDueSyncJobIds` / `processDueSyncJob` -> `listDueJobIds` / `processDue`.
describe("identity sync worker loop", () => {
    beforeEach(() => jest.clearAllMocks());

    it("should process due sync jobs once and report incomplete when one fails", async () => {
        const service = { listDueJobIds: jest.fn().mockResolvedValue([1, 2]), processDue: jest.fn().mockImplementation((id: number) => id === 2 ? Promise.reject(new Error("synthetic failure")) : Promise.resolve()) } as unknown as IdentitySyncService;
        const loop = buildIdentitySyncLoop({ service, logger, pollSeconds: 10 });
        expect(loop.name).toBe("identity-sync"); expect(loop.intervalMs).toBe(10_000);
        await expect(loop.tick(signal())).resolves.toBe("incomplete");
        expect(service.processDue).toHaveBeenCalledTimes(2);
        expect(logger.metric).toHaveBeenCalledWith("identity_sync_jobs_processed", 1);
    });

    it("should stop before processing sync jobs when signalled", async () => {
        const service = { listDueJobIds: jest.fn().mockResolvedValue([1]), processDue: jest.fn() } as unknown as IdentitySyncService;
        const controller = new AbortController(); controller.abort();
        await buildIdentitySyncLoop({ service, logger, pollSeconds: 10 }).tick(controller.signal);
        expect(service.processDue).not.toHaveBeenCalled();
    });
});
