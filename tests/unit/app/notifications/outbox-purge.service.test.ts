import type { Knex } from "knex";
import * as repo from "../../../../src/app/notifications/repository/notification-outbox.repo";
import { OutboxPurgeService } from "../../../../src/app/notifications/service/outbox-purge.service";
import { FakeClock } from "../../../helpers/fake-clock";
import { fakeLogger } from "../../../helpers/fake-logger";

const NOW = Date.parse("2030-06-01T10:00:00Z");
const db = {} as unknown as Knex;

afterEach(() => { jest.restoreAllMocks(); });

describe("OutboxPurgeService", () => {
    it("should delete in batches of 5000 older than the retention cutoff and stop on a short batch", async () => {
        const purge = jest.spyOn(repo, "deleteSentOlderThan").mockResolvedValueOnce(5000).mockResolvedValueOnce(5000).mockResolvedValueOnce(12);
        const log = fakeLogger();
        await new OutboxPurgeService(db, { OUTBOX_RETENTION_DAYS: 30 }, log.logger, new FakeClock(NOW)).tick(new AbortController().signal);
        expect(purge).toHaveBeenCalledTimes(3);
        expect(purge.mock.calls[0]).toEqual([new Date(NOW - 30 * 86_400_000), 5000, db]);
        expect(log.info).toHaveBeenCalledWith("outbox_purged", { deleted: 10_012 });
    });

    it("should cap the batches per tick at 20", async () => {
        const purge = jest.spyOn(repo, "deleteSentOlderThan").mockResolvedValue(5000);
        await new OutboxPurgeService(db, { OUTBOX_RETENTION_DAYS: 30 }, fakeLogger().logger, new FakeClock(NOW)).tick(new AbortController().signal);
        expect(purge).toHaveBeenCalledTimes(20);
    });

    it("should not delete when aborted", async () => {
        const purge = jest.spyOn(repo, "deleteSentOlderThan");
        const aborted = new AbortController();
        aborted.abort();
        await new OutboxPurgeService(db, { OUTBOX_RETENTION_DAYS: 30 }, fakeLogger().logger, new FakeClock(NOW)).tick(aborted.signal);
        expect(purge).not.toHaveBeenCalled();
    });
});
