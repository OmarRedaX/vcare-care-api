import { spawn } from "node:child_process";
import path from "node:path";
import type { Knex } from "knex";
import { AuditRecorder } from "../../src/lib/audit/audit";
import { AUDIT_PARTITION_LOCK_KEY } from "../../src/lib/audit/constants";
import { buildAuditPartitionLoop } from "../../src/lib/audit/partition-loop";
import { createKnex, db } from "../../src/lib/knex/knex";
import { logger } from "../../src/lib/logger/logger";
import type { TickOutcome, WorkerLoop } from "../../src/lib/worker/types";
import { closeDb, ownerDb, truncateAll } from "../helpers/db";
import { captureLogs } from "../helpers/log-capture";
import type { LogCapture } from "../helpers/types";

jest.setTimeout(60_000);

const REPO_ROOT = path.resolve(__dirname, "..", "..");

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** `audit_logs_yYYYYmMM` for the UTC month `offset` months from now. */
function partition(offset: number): string {
    const now = new Date();
    const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));
    return `audit_logs_y${month.getUTCFullYear()}m${String(month.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Mid-month timestamp of the UTC month `offset` months from now. */
function midMonth(offset: number): string {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 15, 12)).toISOString();
}

async function exists(name: string): Promise<boolean> {
    const result = await ownerDb.raw<{ rows: Array<{ oid: string | null }> }>("SELECT to_regclass(?)::text AS oid", [`public.${name}`]);
    return result.rows[0]?.oid !== null;
}

async function dropPartition(name: string): Promise<void> {
    await ownerDb.raw(`DROP TABLE IF EXISTS public.${name}`);
}

/** The worker's pools: the APP login (care_app), never the owner — exactly what care-worker uses. */
function workerPool(): Knex {
    return createKnex({ url: process.env.DATABASE_URL ?? "", poolMax: 2, statementTimeoutMs: 5_000, applicationName: "care-worker" });
}

function runWorker(args: string[]): Promise<{ code: number | null; output: string }> {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ["--import", "tsx", "src/worker.ts", ...args], {
            cwd: REPO_ROOT,
            env: { ...process.env, LOG_LEVEL: "info" },
            stdio: ["ignore", "pipe", "pipe"],
        });
        let output = "";
        const timer = setTimeout(() => {
            child.kill("SIGKILL");
            reject(new Error(`worker did not exit; output: ${output}`));
        }, 45_000);
        child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
        child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
        child.on("exit", (code) => {
            clearTimeout(timer);
            resolve({ code, output });
        });
        child.on("error", reject);
    });
}

const jsonLines = (text: string): Array<Record<string, unknown>> =>
    text
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.startsWith("{"))
        .map((line) => JSON.parse(line) as Record<string, unknown>);

describe("care-worker audit-partitions loop (integration: real Postgres as care_app)", () => {
    let poolA: Knex;
    let poolB: Knex;
    let capture: LogCapture | undefined;

    const loopOn = (pool: Knex, monthsAhead = 2): WorkerLoop => buildAuditPartitionLoop({ db: pool, logger, monthsAhead });
    const tick = (loop: WorkerLoop): Promise<TickOutcome | void> => loop.tick(new AbortController().signal);
    const lines = (message: string): Array<Record<string, unknown>> =>
        (capture?.lines() ?? []).filter((line) => line.message === message);
    const metric = (name: string): unknown[] =>
        (capture?.lines() ?? []).filter((line) => line.message === "metric" && line.metric === name).map((line) => line.value);

    beforeAll(async () => {
        poolA = workerPool();
        poolB = workerPool();
        await truncateAll();
    });

    beforeEach(() => {
        jest.replaceProperty(logger as unknown as { level: string }, "level", "debug");
        capture = captureLogs();
    });

    afterEach(async () => {
        capture?.restore();
        capture = undefined;
        jest.restoreAllMocks();
        await truncateAll();
        // Leave the standard horizon in place for every other suite.
        await tick(loopOn(poolA));
    });

    afterAll(async () => {
        for (const offset of [3, 4]) {
            await dropPartition(partition(offset));
        }
        await poolA.destroy();
        await poolB.destroy();
        await closeDb();
    });

    it("should run the loop as care_app", async () => {
        const result = await poolA.raw<{ rows: Array<{ user: string }> }>("SELECT current_user AS user");
        expect(result.rows[0]?.user).toBe("care_app");
    });

    it("should create the missing month with its grants when the owner dropped a future partition (A15)", async () => {
        await dropPartition(partition(1));
        expect(await exists(partition(1))).toBe(false);

        await tick(loopOn(poolA));

        expect(await exists(partition(1))).toBe(true);
        expect(lines("audit_partitions_ensured")).toEqual([
            expect.objectContaining({ level: "info", created: [partition(1)], checked: 3 }),
        ]);
        expect(metric("audit_partition_missing")).toEqual([0]);
        const grants = await ownerDb.raw<{ rows: Array<{ ins: boolean; col_ins: boolean; at_ins: boolean; sel: boolean; upd: boolean; del: boolean }> }>(
            `SELECT has_table_privilege('vcare_app', ?, 'INSERT') AS ins, has_column_privilege('vcare_app', ?, 'metadata', 'INSERT') AS col_ins,
                    has_column_privilege('vcare_app', ?, 'created_at', 'INSERT') AS at_ins, has_table_privilege('vcare_app', ?, 'SELECT') AS sel,
                    has_table_privilege('vcare_app', ?, 'UPDATE') AS upd, has_table_privilege('vcare_app', ?, 'DELETE') AS del`,
            Array(6).fill(partition(1)),
        );
        // Column-level INSERT only (L2): the app role can never set id or created_at.
        expect(grants.rows[0]).toEqual({ ins: false, col_ins: true, at_ins: false, sel: true, upd: false, del: false });
    });

    it("should create the configured horizon (AUDIT_PARTITION_MONTHS_AHEAD=4) and nothing on a second tick (A15)", async () => {
        const loop = loopOn(poolA, 4);
        await tick(loop);
        expect(lines("audit_partitions_ensured")[0]).toMatchObject({ created: [partition(3), partition(4)], checked: 5 });
        for (const offset of [0, 1, 2, 3, 4]) {
            expect(await exists(partition(offset))).toBe(true);
        }

        await tick(loop);
        expect(lines("audit_partitions_ensured")[1]).toMatchObject({ created: [], checked: 5 });
    });

    it("should land a current-month audit row in its monthly partition after a tick", async () => {
        await tick(loopOn(poolA));
        await poolA.raw(
            `INSERT INTO audit_logs (actor_user_id, actor_role, action, entity_type, entity_id, request_id, metadata)
             VALUES (NULL, 'system', 'test.performed', 'test_entity', 1, NULL, '{}')`,
        );
        const result = await ownerDb.raw<{ rows: Array<{ partition: string }> }>("SELECT tableoid::regclass::text AS partition FROM audit_logs");
        expect(result.rows).toEqual([{ partition: partition(0) }]);
    });

    it("should complete two concurrent ticks from two pools with one partition set and no error (A15)", async () => {
        await dropPartition(partition(2));
        await Promise.all([tick(loopOn(poolA)), tick(loopOn(poolB))]);

        expect(await exists(partition(2))).toBe(true);
        expect(lines("audit_partition_missing")).toEqual([]);
        expect(metric("audit_partition_missing")).not.toContain(1);
        const created = lines("audit_partitions_ensured").flatMap((line) => line.created as string[]);
        expect(created).toEqual([partition(2)]); // created exactly once
        const outcomes = lines("audit_partitions_ensured").length + lines("audit_partitions_locked_elsewhere").length;
        expect(outcomes).toBe(2);
    });

    it("should skip while another session holds the advisory lock, then create once it is released (A15)", async () => {
        await dropPartition(partition(1));
        let release: () => void = () => undefined;
        const released = new Promise<void>((resolve) => {
            release = resolve;
        });
        let locked: () => void = () => undefined;
        const holding = new Promise<void>((resolve) => {
            locked = resolve;
        });
        const holder = ownerDb.transaction(async (trx) => {
            await trx.raw("SELECT pg_advisory_xact_lock(?)", [AUDIT_PARTITION_LOCK_KEY]);
            locked();
            await released;
        });
        await holding;

        await tick(loopOn(poolA));
        expect(lines("audit_partitions_locked_elsewhere")).toHaveLength(1);
        expect(lines("audit_partitions_ensured")).toEqual([]);
        expect(await exists(partition(1))).toBe(false);

        release();
        await holder;
        await tick(loopOn(poolA));
        expect(lines("audit_partitions_ensured")).toEqual([expect.objectContaining({ created: [partition(1)] })]);
        expect(await exists(partition(1))).toBe(true);
    });

    it("should not stall a concurrent audit insert while a tick attaches a new month under an open audit transaction (L3)", async () => {
        await dropPartition(partition(2));
        const recorder = new AuditRecorder({ logger });
        const entry = (entityId: number) => ({
            actor: { kind: "system" as const },
            action: "test.performed",
            entityType: "test_entity",
            entityId,
            metadata: {},
        });

        // An in-flight request transaction that has already written its audit row (ROW EXCLUSIVE on audit_logs).
        let release: () => void = () => undefined;
        const released = new Promise<void>((resolve) => {
            release = resolve;
        });
        let inserted: () => void = () => undefined;
        const holding = new Promise<void>((resolve) => {
            inserted = resolve;
        });
        const holder = db.transaction(async (trx) => {
            await recorder.record(trx, entry(1));
            inserted();
            await released;
        });
        await holding;

        let concurrentMs = Number.POSITIVE_INFINITY;
        try {
            const ticking = tick(loopOn(poolA)); // creates partition(2) while the holder is open
            await delay(50); // the tick is attaching (or already done) when the next request audits
            const startedAt = Date.now();
            await db.transaction((trx) => recorder.record(trx, entry(2)));
            concurrentMs = Date.now() - startedAt;
            await ticking;
        } finally {
            release();
            await holder;
        }

        // CREATE … PARTITION OF queued every insert behind its ACCESS EXCLUSIVE request (up to lock_timeout 2 s);
        // ATTACH takes SHARE UPDATE EXCLUSIVE on the parent, which never conflicts with an INSERT.
        expect(concurrentMs).toBeLessThan(200);
        expect(lines("audit_partitions_ensured")).toEqual([expect.objectContaining({ created: [partition(2)] })]);
        expect(lines("audit_partition_missing")).toEqual([]);
        expect(await exists(partition(2))).toBe(true);
        const routed = await ownerDb.raw<{ rows: Array<{ partition: string }> }>(
            "SELECT DISTINCT tableoid::regclass::text AS partition FROM audit_logs",
        );
        expect(routed.rows).toEqual([{ partition: partition(0) }]);
    });

    it("should report audit_default_partition_nonempty with the row gauge when a far-future row lands in the default partition (A16)", async () => {
        // As the owner: care_app cannot set created_at (column-level INSERT, L2).
        await ownerDb.raw(
            `INSERT INTO audit_logs (actor_user_id, actor_role, action, entity_type, entity_id, request_id, metadata, created_at)
             VALUES (NULL, 'system', 'test.performed', 'test_entity', 1, NULL, '{}', '2099-06-01T00:00:00Z')`,
        );
        await tick(loopOn(poolA));
        expect(lines("audit_default_partition_nonempty")).toEqual([expect.objectContaining({ level: "warn", rows: 1 })]);
        expect(metric("audit_default_partition_rows")).toEqual([1]);
        expect(metric("audit_partition_missing")).toEqual([0]);
    });

    it("should report audit_partition_missing when a default-partition row blocks a new month, without failing the tick (A16)", async () => {
        await dropPartition(partition(2));
        // As the owner: care_app cannot set created_at (column-level INSERT, L2).
        await ownerDb.raw(
            `INSERT INTO audit_logs (actor_user_id, actor_role, action, entity_type, entity_id, request_id, metadata, created_at)
             VALUES (NULL, 'system', 'test.performed', 'test_entity', 1, NULL, '{}', ?)`,
            [midMonth(2)],
        );

        await expect(tick(loopOn(poolA))).resolves.toBe("incomplete");

        const missing = lines("audit_partition_missing");
        expect(missing).toHaveLength(1);
        expect(missing[0]).toMatchObject({ level: "error", error: expect.objectContaining({ code: "23514" }) });
        expect(metric("audit_partition_missing")).toEqual([1]);
        expect(lines("audit_default_partition_nonempty")).toEqual([expect.objectContaining({ rows: 1 })]);
        expect(await exists(partition(2))).toBe(false);
        // afterEach truncates the default row and re-runs a tick, which recreates the month.
    });

    it("should run one tick and exit 0 for `worker --once audit-partitions`, and exit 1 for an unknown loop", async () => {
        await dropPartition(partition(1));
        const once = await runWorker(["--once", "audit-partitions"]);
        expect(once.code).toBe(0);
        const messages = jsonLines(once.output).map((line) => line.message);
        expect(messages).toEqual(expect.arrayContaining(["audit_partitions_ensured", "worker_once_completed"]));
        expect(messages).not.toContain("worker_started"); // no long-running loop
        expect(await exists(partition(1))).toBe(true);

        const unknown = await runWorker(["--once", "no-such-loop"]);
        expect(unknown.code).toBe(1);
        expect(jsonLines(unknown.output).find((line) => line.message === "worker_loop_unknown")).toMatchObject({
            level: "error",
            loop: "no-such-loop",
            loops: ["audit-partitions", "identity-sync", "upload-intent-purge"],
        });
    });

    it.each(["identity-sync", "upload-intent-purge"])("should run one tick and exit 0 for `worker --once %s`", async (loop) => {
        const once = await runWorker(["--once", loop]);
        expect(once.code).toBe(0);
        expect(jsonLines(once.output).map((line) => line.message)).toContain("worker_once_completed");
    });

    it("should exit 1 for `worker --once audit-partitions` when a default-partition row blocks a new month (L4)", async () => {
        await dropPartition(partition(2));
        await ownerDb.raw(
            `INSERT INTO audit_logs (actor_user_id, actor_role, action, entity_type, entity_id, request_id, metadata, created_at)
             VALUES (NULL, 'system', 'test.performed', 'test_entity', 1, NULL, '{}', ?)`,
            [midMonth(2)],
        );

        const once = await runWorker(["--once", "audit-partitions"]);
        expect(once.code).toBe(1);
        const messages = jsonLines(once.output).map((line) => line.message);
        expect(messages).toEqual(expect.arrayContaining(["audit_partition_missing", "worker_once_incomplete"]));
        expect(messages).not.toContain("worker_once_completed");
        expect(await exists(partition(2))).toBe(false);
        // afterEach truncates the default row and re-runs a tick, which recreates the month.
    });

    it("should exit 1 for `worker --once audit-partitions` while another session holds the advisory lock (L4)", async () => {
        let release: () => void = () => undefined;
        const released = new Promise<void>((resolve) => {
            release = resolve;
        });
        let locked: () => void = () => undefined;
        const holding = new Promise<void>((resolve) => {
            locked = resolve;
        });
        const holder = ownerDb.transaction(async (trx) => {
            await trx.raw("SELECT pg_advisory_xact_lock(?)", [AUDIT_PARTITION_LOCK_KEY]);
            locked();
            await released;
        });
        await holding;
        try {
            const once = await runWorker(["--once", "audit-partitions"]);
            expect(once.code).toBe(1);
            expect(jsonLines(once.output).map((line) => line.message)).toContain("worker_once_incomplete");
        } finally {
            release();
            await holder;
        }
    });
});
