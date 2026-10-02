import { spawn } from "node:child_process";
import path from "node:path";

/**
 * Child-process checks of the real entrypoints (`src/server.ts`, `src/worker.ts`) run through `tsx`.
 * Signal delivery is POSIX-only: on Windows `child.kill("SIGTERM")` maps to TerminateProcess, which never runs
 * Node's signal handlers, so the graceful-shutdown cases would fail for a reason unrelated to the code. They
 * are skipped on win32 only and run on CI (ubuntu-latest).
 */
const describeSignals = process.platform === "win32" ? describe.skip : describe;
const REPO_ROOT = path.resolve(__dirname, "..", "..");

interface RunResult {
    code: number | null;
    stdout: string;
    stderr: string;
}

function childEnv(overrides: Record<string, string | undefined>): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env, ...overrides };
    for (const [key, value] of Object.entries(overrides)) {
        if (value === undefined) {
            delete env[key];
        }
    }
    return env;
}

function run(entrypoint: string, env: NodeJS.ProcessEnv, options?: { signalAfter?: string; timeoutMs?: number }): Promise<RunResult> {
    return new Promise<RunResult>((resolve, reject) => {
        const child = spawn(process.execPath, ["--import", "tsx", entrypoint], {
            cwd: REPO_ROOT,
            env,
            stdio: ["ignore", "pipe", "pipe"],
        });

        let stdout = "";
        let stderr = "";
        let signalled = false;
        const timer = setTimeout(() => {
            child.kill("SIGKILL");
            reject(new Error(`child did not exit in time; stdout: ${stdout}; stderr: ${stderr}`));
        }, options?.timeoutMs ?? 20_000);

        child.stdout.on("data", (chunk: Buffer) => {
            stdout += chunk.toString("utf8");
            if (options?.signalAfter !== undefined && !signalled && stdout.includes(options.signalAfter)) {
                signalled = true;
                child.kill("SIGTERM");
            }
        });
        child.stderr.on("data", (chunk: Buffer) => {
            stderr += chunk.toString("utf8");
        });
        child.on("exit", (code) => {
            clearTimeout(timer);
            resolve({ code, stdout, stderr });
        });
        child.on("error", (error) => {
            clearTimeout(timer);
            reject(error);
        });
    });
}

function jsonLines(text: string): Array<Record<string, unknown>> {
    return text
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.startsWith("{"))
        .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("entrypoint environment validation (F1)", () => {
    it("should exit 1 and name the key without its value when DATABASE_URL is invalid", async () => {
        const secretUrl = "mysql://care:synthetic-db-secret-6612@localhost:5434/care_test";
        const result = await run("src/server.ts", childEnv({ DATABASE_URL: secretUrl }));

        expect(result.code).toBe(1);
        const line = jsonLines(result.stderr).find((entry) => entry.message === "invalid_environment");
        expect(line).toMatchObject({ level: "error", service: "care-service", keys: ["DATABASE_URL"] });
        expect(result.stdout + result.stderr).not.toContain("synthetic-db-secret-6612");
    }, 40_000);

    it("should exit 1 naming REDIS_URL when the worker starts without it", async () => {
        const result = await run("src/worker.ts", childEnv({ REDIS_URL: undefined }));
        expect(result.code).toBe(1);
        expect(jsonLines(result.stderr).find((entry) => entry.message === "invalid_environment")?.keys).toEqual([
            "REDIS_URL",
        ]);
    }, 40_000);
});

describeSignals("graceful shutdown on SIGTERM (F19, F20)", () => {
    it("should log shutdown_started and shutdown_complete and exit 0 when the server receives SIGTERM", async () => {
        const result = await run("src/server.ts", childEnv({ PORT: "34981", INTERNAL_PORT: "34982", LOG_LEVEL: "info" }), {
            signalAfter: "server_started",
        });

        expect(result.code).toBe(0);
        const messages = jsonLines(result.stdout).map((line) => line.message);
        expect(messages).toEqual(expect.arrayContaining(["server_started", "shutdown_started", "shutdown_complete"]));
        expect(messages.indexOf("shutdown_started")).toBeLessThan(messages.indexOf("shutdown_complete"));
    }, 40_000);

    it("should log worker_stopping and exit 0 when the idle worker receives SIGTERM", async () => {
        const result = await run("src/worker.ts", childEnv({ LOG_LEVEL: "info" }), { signalAfter: "worker_started" });

        expect(result.code).toBe(0);
        const messages = jsonLines(result.stdout).map((line) => line.message);
        expect(messages).toEqual(expect.arrayContaining(["worker_started", "worker_stopping"]));
    }, 40_000);
});
