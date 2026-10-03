import type { Knex } from "knex";
import {
    AUDIT_DEFAULT_SAMPLE_LIMIT,
    AUDIT_PARTITION_INTERVAL_MS,
    AUDIT_PARTITION_LOCK_KEY,
    AUDIT_PARTITION_LOOP_NAME,
} from "../../../../src/lib/audit/constants";
import { buildAuditPartitionLoop } from "../../../../src/lib/audit/partition-loop";
import { fakeLogger } from "../../../helpers/fake-logger";

interface FakeDbOptions {
    locked?: boolean;
    ensure?: Array<{ partition_name: string; created: boolean }> | Error;
    defaultRows?: number;
}

/** A Knex stand-in: `transaction(fn)` runs `fn(trx)`; raw SQL is answered by its leading statement. */
function fakeDb(options: FakeDbOptions) {
    const statements: Array<{ sql: string; bindings: unknown[]; inTransaction: boolean }> = [];
    const answer = (inTransaction: boolean) =>
        jest.fn((sql: string, bindings: unknown[] = []) => {
            statements.push({ sql, bindings, inTransaction });
            if (sql.includes("pg_try_advisory_xact_lock")) {
                return Promise.resolve({ rows: [{ locked: options.locked ?? true }] });
            }
            if (sql.includes("audit_logs_ensure_partitions")) {
                return options.ensure instanceof Error
                    ? Promise.reject(options.ensure)
                    : Promise.resolve({ rows: options.ensure ?? [] });
            }
            if (sql.includes("audit_logs_default")) {
                return Promise.resolve({ rows: [{ sampled: options.defaultRows ?? 0 }] });
            }
            return Promise.reject(new Error(`unexpected SQL: ${sql}`));
        });
    const trx = { raw: answer(true) };
    const transaction = jest.fn(async (fn: (trx: unknown) => Promise<unknown>) => fn(trx));
    const db = { transaction, raw: answer(false) } as unknown as Knex;
    return { db, statements, transaction };
}

function loop(options: FakeDbOptions, monthsAhead = 2) {
    const fake = fakeDb(options);
    const log = fakeLogger();
    return { ...fake, log, loop: buildAuditPartitionLoop({ db: fake.db, logger: log.logger, monthsAhead }) };
}

const live = (): AbortSignal => new AbortController().signal;

describe("lib/audit/buildAuditPartitionLoop", () => {
    it("should be the daily audit-partitions loop", () => {
        const { loop: built } = loop({});
        expect(built.name).toBe(AUDIT_PARTITION_LOOP_NAME);
        expect(built.name).toBe("audit-partitions");
        expect(built.intervalMs).toBe(AUDIT_PARTITION_INTERVAL_MS);
        expect(AUDIT_PARTITION_INTERVAL_MS).toBe(86_400_000);
    });

    it("should take the transaction-scoped advisory lock and call the function with monthsAhead inside one transaction (A15)", async () => {
        const { loop: built, statements, transaction } = loop({ ensure: [] }, 5);
        await built.tick(live());
        expect(transaction).toHaveBeenCalledTimes(1);
        const [lock, ensure] = statements.filter((statement) => statement.inTransaction);
        expect(lock).toEqual({
            sql: "SELECT pg_try_advisory_xact_lock(?) AS locked",
            bindings: [AUDIT_PARTITION_LOCK_KEY],
            inTransaction: true,
        });
        expect(ensure?.sql).toBe("SELECT partition_name, created FROM audit_logs_ensure_partitions(?)");
        expect(ensure?.bindings).toEqual([5]);
    });

    it("should skip and log audit_partitions_locked_elsewhere when the advisory lock is not acquired (A15)", async () => {
        const { loop: built, statements, log } = loop({ locked: false });
        await built.tick(live());
        expect(log.debug).toHaveBeenCalledWith("audit_partitions_locked_elsewhere");
        expect(statements.some((statement) => statement.sql.includes("audit_logs_ensure_partitions"))).toBe(false);
        expect(log.metric).not.toHaveBeenCalledWith("audit_partition_missing", expect.anything());
        // The read-only default-partition check still runs.
        expect(log.metric).toHaveBeenCalledWith("audit_default_partition_rows", 0);
    });

    it("should log the partitions created this tick and emit audit_partition_missing 0", async () => {
        const { loop: built, log } = loop({
            ensure: [
                { partition_name: "audit_logs_y2026m10", created: false },
                { partition_name: "audit_logs_y2026m11", created: true },
                { partition_name: "audit_logs_y2026m12", created: true },
            ],
        });
        await built.tick(live());
        expect(log.info).toHaveBeenCalledWith("audit_partitions_ensured", {
            created: ["audit_logs_y2026m11", "audit_logs_y2026m12"],
            checked: 3,
        });
        expect(log.metric).toHaveBeenCalledWith("audit_partition_missing", 0);
    });

    it("should log audit_partition_missing and emit 1 without rethrowing when the function fails (A16)", async () => {
        const failure = Object.assign(new Error("updated partition constraint for default partition would be violated"), {
            code: "23514",
        });
        const { loop: built, log } = loop({ ensure: failure });
        await expect(built.tick(live())).resolves.toBeUndefined();
        expect(log.error).toHaveBeenCalledWith("audit_partition_missing", { error: failure });
        expect(log.metric).toHaveBeenCalledWith("audit_partition_missing", 1);
        expect(log.metric).not.toHaveBeenCalledWith("audit_partition_missing", 0);
    });

    it("should still run the default-partition check after a failure (A16)", async () => {
        const { loop: built, log, statements } = loop({ ensure: new Error("lock timeout"), defaultRows: 3 });
        await built.tick(live());
        expect(statements.some((statement) => statement.sql.includes("audit_logs_default"))).toBe(true);
        expect(log.metric).toHaveBeenCalledWith("audit_default_partition_rows", 3);
    });

    it("should warn and emit the bounded row gauge when the default partition is non-empty (A16)", async () => {
        const { loop: built, log, statements } = loop({ ensure: [], defaultRows: AUDIT_DEFAULT_SAMPLE_LIMIT });
        await built.tick(live());
        expect(log.metric).toHaveBeenCalledWith("audit_default_partition_rows", 1_001);
        expect(log.warn).toHaveBeenCalledWith("audit_default_partition_nonempty", { rows: 1_001 });
        const sample = statements.find((statement) => statement.sql.includes("audit_logs_default"));
        expect(sample?.sql).toMatch(/LIMIT \?/);
        expect(sample?.bindings).toEqual([AUDIT_DEFAULT_SAMPLE_LIMIT]);
        expect(sample?.inTransaction).toBe(false);
    });

    it("should not warn when the default partition is empty", async () => {
        const { loop: built, log } = loop({ ensure: [], defaultRows: 0 });
        await built.tick(live());
        expect(log.warn).not.toHaveBeenCalled();
    });

    it("should return immediately when the signal is aborted", async () => {
        const { loop: built, statements, transaction } = loop({ ensure: [] });
        const controller = new AbortController();
        controller.abort();
        await built.tick(controller.signal);
        expect(transaction).not.toHaveBeenCalled();
        expect(statements).toHaveLength(0);
    });

    it("should propagate a failure of the default-partition read to the loop runner", async () => {
        const { loop: built, db } = loop({ ensure: [] });
        (db.raw as unknown as jest.Mock).mockImplementationOnce(() => Promise.reject(new Error("connection lost")));
        await expect(built.tick(live())).rejects.toThrow("connection lost");
    });
});
