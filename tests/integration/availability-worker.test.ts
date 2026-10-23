/**
 * care-worker availability loops as real child processes (slice S2) — the real entrypoint `src/worker.ts` through `tsx`, real Postgres as care_app,
 * real Redis. Few processes on purpose (each is a full Node + tsx start).
 *
 * Rule map: AV-R23 (sweep: done, lock held and Redis unreachable are incomplete = exit 1), AV-R24 (refresh drains the set), AV-R25 (the worker owns a
 * Redis client named care-worker, connected at boot, closed on shutdown; both loops registered; `--once` for both names).
 * Signal delivery is POSIX-only (see process.test.ts): the graceful-shutdown case is skipped on win32 and runs on CI.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { redis } from "../../src/lib/redis/redis";
import { seedDoctor } from "../helpers/availability-seed";
import { closeDb, ownerDb, truncateAll } from "../helpers/db";
import { closeRedis, ensureRedisReady, flushByPrefix } from "../helpers/redis";
import { DISCOVERY_PREFIXES } from "../helpers/availability-harness";

jest.setTimeout(180_000);

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const describeSignals = process.platform === "win32" ? describe.skip : describe;
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface RunResult { code: number | null; output: string }
interface WorkerOptions { env?: Record<string, string>; signalAfter?: (output: string) => boolean; signal?: NodeJS.Signals; timeoutMs?: number }

function runWorker(args: string[], options: WorkerOptions = {}): Promise<RunResult> {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ["--import", "tsx", "src/worker.ts", ...args], {
            cwd: REPO_ROOT,
            env: { ...process.env, LOG_LEVEL: "info", ...options.env },
            stdio: ["ignore", "pipe", "pipe"],
        });
        let output = "";
        let signalled = false;
        const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`worker did not exit in time; output: ${output}`)); }, options.timeoutMs ?? 60_000);
        const collect = (chunk: Buffer): void => {
            output += chunk.toString("utf8");
            if (options.signalAfter !== undefined && !signalled && options.signalAfter(output.slice(0, output.lastIndexOf("\n") + 1))) {
                signalled = true;
                child.kill(options.signal ?? "SIGTERM");
            }
        };
        child.stdout.on("data", collect);
        child.stderr.on("data", collect);
        child.on("close", (code) => { clearTimeout(timer); resolve({ code, output }); });
        child.on("error", (error) => { clearTimeout(timer); reject(error); });
    });
}

const jsonLines = (text: string): Array<Record<string, unknown>> =>
    text.split("\n").map((line) => line.trim()).filter((line) => line.startsWith("{")).flatMap((line) => {
        try { return [JSON.parse(line) as Record<string, unknown>]; } catch { return []; }
    });
const messages = (output: string): unknown[] => jsonLines(output).map((line) => line.message);
const workerClients = async (): Promise<number> => {
    const list = String(await redis.client("LIST"));
    return list.split("\n").filter((line) => line.includes("name=care-worker")).length;
};

describe("care-worker availability loops (integration: real child processes)", () => {
    beforeAll(async () => { await ensureRedisReady(); });
    beforeEach(async () => {
        await truncateAll();
        await flushByPrefix(DISCOVERY_PREFIXES);
        for (const userId of [6001, 6002, 6003]) await seedDoctor({ userId, hours: { start: "09:00", end: "17:00" } });
        await seedDoctor({ userId: 6004, suspended: true });
    });
    afterAll(async () => {
        await flushByPrefix(DISCOVERY_PREFIXES);
        await truncateAll();
        await closeRedis();
        await closeDb();
    });

    it("should exit 0 and fill the rank index, the free-maps and swept-at when --once availability-sweep runs", async () => {
        const result = await runWorker(["--once", "availability-sweep"]);
        expect(result.code).toBe(0);
        expect(messages(result.output)).toEqual(expect.arrayContaining(["availability_sweep_done", "worker_once_completed"]));
        expect(jsonLines(result.output).find((line) => line.message === "availability_sweep_done")).toMatchObject({ doctors: 3, batches: 1 });
        expect((await redis.zrange("next-available:index", 0, -1)).sort()).toEqual(["6001", "6002", "6003"]);
        for (const userId of [6001, 6002, 6003]) expect(await redis.exists(`free-map:${userId}`)).toBe(1);
        expect(await redis.exists("free-map:6004")).toBe(0);
        const stamp = Number(await redis.get("next-available:swept-at"));
        expect(Math.abs(Date.now() - stamp)).toBeLessThan(120_000);
        expect(await workerClients()).toBe(0);
    });

    it("should exit 0 and drain the refresh set when --once availability-refresh runs", async () => {
        await redis.sadd("next-available:refresh", "6001", "6002", "6004", "777777");
        const result = await runWorker(["--once", "availability-refresh"]);
        expect(result.code).toBe(0);
        expect(messages(result.output)).toContain("worker_once_completed");
        expect(await redis.scard("next-available:refresh")).toBe(0);
        expect((await redis.zrange("next-available:index", 0, -1)).sort()).toEqual(["6001", "6002"]);
        const empty = await runWorker(["--once", "availability-refresh"]);
        expect(empty.code).toBe(0);
    });

    it("should exit 1 and index nothing when --once availability-sweep runs while Redis is unreachable", async () => {
        const result = await runWorker(["--once", "availability-sweep"], { env: { REDIS_URL: "redis://127.0.0.1:1/0" } });
        expect(result.code).toBe(1);
        expect(messages(result.output)).toContain("worker_once_incomplete");
        expect(await redis.exists("next-available:index")).toBe(0);
        expect(await redis.exists("next-available:swept-at")).toBe(0);
    });

    it("should exit 1 and leave swept-at alone when --once availability-sweep finds the sweep lock held by another session", async () => {
        let release!: () => void;
        let held!: () => void;
        const heldPromise = new Promise<void>((resolve) => { held = resolve; });
        const releasePromise = new Promise<void>((resolve) => { release = resolve; });
        const holder = ownerDb.transaction(async (trx) => {
            await trx.raw("SELECT pg_advisory_xact_lock(hashtextextended(?::text, ?::bigint))", ["0", 1104]);
            held();
            await releasePromise;
        });
        await heldPromise;
        let result: RunResult;
        try { result = await runWorker(["--once", "availability-sweep"]); } finally { release(); await holder; }
        expect(result.code).toBe(1);
        expect(messages(result.output)).toContain("worker_once_incomplete");
        expect(await redis.exists("next-available:swept-at")).toBe(0);
        expect(await redis.exists("next-available:index")).toBe(0);
    });

    it("should list both availability loops in worker_started when the long-running worker boots", async () => {
        const result = await runWorker([], {
            signalAfter: (output) => messages(output).includes("worker_started"), signal: "SIGKILL", timeoutMs: 60_000,
        });
        const started = jsonLines(result.output).find((line) => line.message === "worker_started");
        expect(started).toBeDefined();
        expect(started!.loops).toEqual(expect.arrayContaining(["availability-refresh", "availability-sweep"]));
    });

    describeSignals("graceful shutdown (AV-R25)", () => {
        it("should connect its own Redis client at boot, run the first sweep, and close the client when SIGTERM arrives", async () => {
            let observed = 0;
            const sampler = (async (): Promise<void> => {
                const deadline = Date.now() + 40_000;
                while (Date.now() < deadline && observed === 0) { observed = await workerClients(); if (observed === 0) await delay(100); }
            })();
            const result = await runWorker([], {
                signalAfter: (output) => messages(output).includes("worker_started") && messages(output).includes("availability_sweep_done"),
                timeoutMs: 60_000,
            });
            await sampler;
            expect(result.code).toBe(0);
            expect(messages(result.output)).toEqual(expect.arrayContaining(["worker_started", "availability_sweep_done", "worker_stopping"]));
            expect(observed).toBe(1);
            // The first sweep ran at boot, before any request.
            expect((await redis.zrange("next-available:index", 0, -1)).sort()).toEqual(["6001", "6002", "6003"]);
            await delay(300);
            expect(await workerClients()).toBe(0);
        });
    });
});
