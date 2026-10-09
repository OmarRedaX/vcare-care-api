/* eslint-disable @typescript-eslint/unbound-method */
import type { Knex } from "knex";
import { buildUploadIntentPurgeLoop } from "../../../../src/app/verification/worker/upload-intent-purge.loop";
import type { VerificationService } from "../../../../src/app/verification/service/verification.service";
import type { Logger } from "../../../../src/lib/logger/logger";

const signal = () => new AbortController().signal;
const logger = { error: jest.fn(), metric: jest.fn(), info: jest.fn(), debug: jest.fn() } as unknown as Logger;

describe("verification worker loops", () => {
    beforeEach(() => jest.clearAllMocks());

    it("should purge expired intents under lock and retain failed objects for retry", async () => {
        const service = { listExpiredIntents: jest.fn().mockResolvedValue([{ id: 1, quarantineKey: "quarantine/a" }, { id: 2, quarantineKey: "quarantine/b" }]),
            withIntentLock: jest.fn().mockImplementation((_id: number, work: () => Promise<void>) => work()),
            purgeExpiredIntent: jest.fn().mockImplementation((id: number) => id === 2 ? Promise.reject(new Error("synthetic storage failure")) : Promise.resolve()),
            deleteIntentsOlderThan: jest.fn().mockResolvedValue(3) } as unknown as VerificationService;
        const db = { client: { config: { pool: { max: 2 } }, acquireConnection: jest.fn().mockResolvedValue({}), releaseConnection: jest.fn() }, raw: jest.fn().mockReturnValue({ connection: jest.fn().mockResolvedValue({ rows: [{ acquired: true }] }) }) } as unknown as Knex;
        const loop = buildUploadIntentPurgeLoop({ service, db, logger, intervalSeconds: 300, now: () => new Date("2026-10-07T00:00:00Z") });
        await expect(loop.tick(signal())).resolves.toBe("incomplete");
        expect(service.purgeExpiredIntent).toHaveBeenCalledTimes(2);
        expect(service.deleteIntentsOlderThan).toHaveBeenCalledWith(new Date("2026-09-30T00:00:00Z"), 500);
        expect(logger.metric).toHaveBeenCalledWith("upload_intent_expired", 1);
    });
});
