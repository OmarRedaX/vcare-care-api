/* eslint-disable @typescript-eslint/unbound-method */
import type { Knex } from "knex";
import { buildUploadIntentPurgeLoop } from "../../../../src/app/upload-intents/worker/upload-intent-purge.loop";
import type { UploadIntentsService } from "../../../../src/app/upload-intents/service/upload-intents.service";
import type { Logger } from "../../../../src/lib/logger/logger";

const signal = () => new AbortController().signal;
const logger = { error: jest.fn(), metric: jest.fn(), info: jest.fn(), debug: jest.fn() } as unknown as Logger;

describe("upload-intent purge loop", () => {
    beforeEach(() => jest.clearAllMocks());

    it("should purge expired intents under lock and retain failed objects for retry", async () => {
        const service = { listExpiredIntents: jest.fn().mockResolvedValue([{ id: 1, quarantineKey: "quarantine/a" }, { id: 2, quarantineKey: "quarantine/b" }]),
            withIntentLock: jest.fn().mockImplementation((_id: number, work: () => Promise<void>) => work()),
            purgeExpiredIntent: jest.fn().mockImplementation((id: number) => id === 2 ? Promise.reject(new Error("synthetic storage failure")) : Promise.resolve()),
            deleteIntentsOlderThan: jest.fn().mockResolvedValue(3) } as unknown as UploadIntentsService;
        const db = { client: { config: { pool: { max: 2 } }, acquireConnection: jest.fn().mockResolvedValue({}), releaseConnection: jest.fn() }, raw: jest.fn().mockReturnValue({ connection: jest.fn().mockResolvedValue({ rows: [{ acquired: true }] }) }) } as unknown as Knex;
        const loop = buildUploadIntentPurgeLoop({ service, db, logger, intervalSeconds: 300, now: () => new Date("2026-10-07T00:00:00Z") });
        await expect(loop.tick(signal())).resolves.toBe("incomplete");
        expect(service.purgeExpiredIntent).toHaveBeenCalledTimes(2);
        expect(service.deleteIntentsOlderThan).toHaveBeenCalledWith(new Date("2026-09-30T00:00:00Z"), 500);
        expect(logger.metric).toHaveBeenCalledWith("upload_intent_expired", 1);
    });

    const lockedDb = { client: { config: { pool: { max: 2 } }, acquireConnection: jest.fn().mockResolvedValue({}), releaseConnection: jest.fn() }, raw: jest.fn().mockReturnValue({ connection: jest.fn().mockResolvedValue({ rows: [{ acquired: true }] }) }) } as unknown as Knex;

    it("should be named upload-intent-purge and tick at the configured interval", () => {
        const loop = buildUploadIntentPurgeLoop({ service: {} as unknown as UploadIntentsService, db: lockedDb, logger, intervalSeconds: 300 });
        expect([loop.name, loop.intervalMs]).toEqual(["upload-intent-purge", 300_000]);
    });

    it("should purge expired intents whatever their kind and report done", async () => {
        const purged: number[] = [];
        const service = { listExpiredIntents: jest.fn().mockResolvedValue([{ id: 1, quarantineKey: "quarantine/verification" }, { id: 2, quarantineKey: "quarantine/attachment" }]),
            withIntentLock: jest.fn().mockImplementation((_id: number, work: () => Promise<void>) => work()),
            purgeExpiredIntent: jest.fn().mockImplementation((id: number) => { purged.push(id); return Promise.resolve(); }),
            deleteIntentsOlderThan: jest.fn().mockResolvedValue(0) } as unknown as UploadIntentsService;
        const loop = buildUploadIntentPurgeLoop({ service, db: lockedDb, logger, intervalSeconds: 300 });
        await expect(loop.tick(signal())).resolves.toBe("done");
        expect(purged).toEqual([1, 2]);
        expect(service.purgeExpiredIntent).toHaveBeenCalledWith(2, "quarantine/attachment");
        expect(logger.metric).toHaveBeenCalledWith("upload_intent_expired", 2);
    });

    it("should skip an intent whose lock is held elsewhere and leave it for the next tick", async () => {
        const service = { listExpiredIntents: jest.fn().mockResolvedValue([{ id: 1, quarantineKey: "quarantine/a" }]),
            withIntentLock: jest.fn().mockResolvedValue(undefined), purgeExpiredIntent: jest.fn(), deleteIntentsOlderThan: jest.fn().mockResolvedValue(0) } as unknown as UploadIntentsService;
        const loop = buildUploadIntentPurgeLoop({ service, db: lockedDb, logger, intervalSeconds: 300 });
        await expect(loop.tick(signal())).resolves.toBe("done");
        expect(service.purgeExpiredIntent).not.toHaveBeenCalled();
        expect(logger.debug).toHaveBeenCalledWith("upload_intent_purge_skipped");
    });

    it("should report incomplete without touching the database when the singleton lock is held by another worker", async () => {
        const held = { ...lockedDb, raw: jest.fn().mockReturnValue({ connection: jest.fn().mockResolvedValue({ rows: [{ acquired: false }] }) }) } as unknown as Knex;
        const service = { listExpiredIntents: jest.fn() } as unknown as UploadIntentsService;
        const loop = buildUploadIntentPurgeLoop({ service, db: held, logger, intervalSeconds: 300 });
        await expect(loop.tick(signal())).resolves.toBe("incomplete");
        expect(service.listExpiredIntents).not.toHaveBeenCalled();
    });
});
