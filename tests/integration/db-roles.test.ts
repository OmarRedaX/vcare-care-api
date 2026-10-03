import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import path from "node:path";
import type { Knex } from "knex";
import { ensureAppLogin } from "../../src/lib/knex/app-login";
import { createKnex, db } from "../../src/lib/knex/knex";
import { closeDb, ownerDb, truncateAll } from "../helpers/db";

jest.setTimeout(60_000);

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const APP_URL = process.env.DATABASE_URL ?? "";
const OWNER_URL = process.env.MIGRATION_DATABASE_URL ?? "";

/** The app URL with another user/password (same host and database). */
function urlFor(user: string, password: string, base = APP_URL): string {
    const url = new URL(base);
    url.username = user;
    url.password = password;
    return url.toString();
}

/** A fresh, short-lived pool (new connections: grant and password changes take effect). */
async function withPool<T>(url: string, fn: (conn: Knex) => Promise<T>): Promise<T> {
    const conn = createKnex({ url, poolMax: 1, statementTimeoutMs: 5_000, applicationName: "care-test" });
    try {
        return await fn(conn);
    } finally {
        await conn.destroy();
    }
}

interface ChildResult {
    code: number | null;
    output: string;
}

function runMigrate(command: string, env: Record<string, string>): Promise<ChildResult> {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ["--import", "tsx", "src/migrate.ts", command], {
            cwd: REPO_ROOT,
            env: { ...process.env, LOG_LEVEL: "info", ...env },
            stdio: ["ignore", "pipe", "pipe"],
        });
        let output = "";
        const timer = setTimeout(() => {
            child.kill("SIGKILL");
            reject(new Error(`migrate ${command} did not exit; output: ${output}`));
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

describe("database roles (integration: owner care vs app login care_app, ADR 0018)", () => {
    const throwaway: string[] = [];

    beforeAll(async () => {
        await truncateAll();
    });

    afterAll(async () => {
        for (const role of throwaway) {
            await ownerDb.raw(`DROP ROLE IF EXISTS ${role}`);
        }
        await closeDb();
    });

    it("should connect the request pool as care_app, a plain login that is a member of vcare_app (A14)", async () => {
        const who = await db.raw<{ rows: Array<{ current_user: string; member: boolean }> }>(
            "SELECT current_user, pg_has_role(current_user, 'vcare_app', 'MEMBER') AS member",
        );
        expect(who.rows[0]).toEqual({ current_user: "care_app", member: true });

        const attrs = await ownerDb.raw<{ rows: Array<Record<string, boolean>> }>(
            `SELECT rolcanlogin, rolinherit, rolsuper, rolcreatedb, rolcreaterole, rolbypassrls
             FROM pg_roles WHERE rolname = 'care_app'`,
        );
        expect(attrs.rows[0]).toEqual({
            rolcanlogin: true,
            rolinherit: true,
            rolsuper: false,
            rolcreatedb: false,
            rolcreaterole: false,
            rolbypassrls: false,
        });
        const group = await ownerDb.raw<{ rows: Array<{ rolcanlogin: boolean }> }>(
            "SELECT rolcanlogin FROM pg_roles WHERE rolname = 'vcare_app'",
        );
        expect(group.rows[0]?.rolcanlogin).toBe(false);
    });

    it("should deny CREATE TABLE in public, ALTER TABLE audit_logs, and DROP TABLE audit_logs to care_app (A14)", async () => {
        await expect(db.raw("CREATE TABLE public.app_probe (id int)")).rejects.toMatchObject({ code: "42501" });
        await expect(db.raw("ALTER TABLE audit_logs ADD COLUMN probe int")).rejects.toMatchObject({ code: "42501" });
        await expect(db.raw("DROP TABLE audit_logs_default")).rejects.toMatchObject({ code: "42501" });
        await expect(
            db.raw("CREATE TABLE public.audit_logs_y2099m01 PARTITION OF audit_logs FOR VALUES FROM ('2099-01-01') TO ('2099-02-01')"),
        ).rejects.toMatchObject({ code: "42501" });
    });

    it("should let care_app call audit_logs_ensure_partitions, idempotently and only within 0..12 months", async () => {
        const first = await db.raw<{ rows: Array<{ partition_name: string; created: boolean }> }>(
            "SELECT partition_name, created FROM audit_logs_ensure_partitions(2)",
        );
        expect(first.rows).toHaveLength(3);
        expect(first.rows.every((row) => /^audit_logs_y\d{4}m\d{2}$/.test(row.partition_name))).toBe(true);
        const second = await db.raw<{ rows: Array<{ created: boolean }> }>("SELECT created FROM audit_logs_ensure_partitions(2)");
        expect(second.rows.map((row) => row.created)).toEqual([false, false, false]);

        for (const months of ["13", "-1", "NULL"]) {
            await expect(db.raw(`SELECT * FROM audit_logs_ensure_partitions(${months})`)).rejects.toMatchObject({ code: "22023" });
        }
        // The only input is an integer: no table name, schema, or SQL fragment can be passed in.
        await expect(db.raw("SELECT * FROM audit_logs_ensure_partitions('audit_logs; DROP TABLE audit_logs')")).rejects.toMatchObject({
            code: "22P02",
        });
    });

    it("should grant INSERT and SELECT but nothing else on every partition the function creates", async () => {
        const result = await ownerDb.raw<{ rows: Array<{ relname: string; ins: boolean; sel: boolean; upd: boolean; del: boolean; trunc: boolean }> }>(
            `SELECT c.relname,
                    has_table_privilege('vcare_app', c.oid, 'INSERT') AS ins,
                    has_table_privilege('vcare_app', c.oid, 'SELECT') AS sel,
                    has_table_privilege('vcare_app', c.oid, 'UPDATE') AS upd,
                    has_table_privilege('vcare_app', c.oid, 'DELETE') AS del,
                    has_table_privilege('vcare_app', c.oid, 'TRUNCATE') AS trunc
             FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
             WHERE i.inhparent = 'audit_logs'::regclass`,
        );
        expect(result.rows.length).toBeGreaterThanOrEqual(4); // default + current + 2 ahead
        for (const row of result.rows) {
            expect(row).toEqual({ relname: row.relname, ins: true, sel: true, upd: false, del: false, trunc: false });
        }
    });

    it("should pin the function's search_path, lock_timeout, SECURITY DEFINER, and owner", async () => {
        const result = await ownerDb.raw<{ rows: Array<{ prosecdef: boolean; proconfig: string[]; owner: string; public_exec: boolean }> }>(
            `SELECT p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner) AS owner,
                    has_function_privilege('public', p.oid, 'EXECUTE') AS public_exec
             FROM pg_proc p WHERE p.proname = 'audit_logs_ensure_partitions'`,
        );
        expect(result.rows).toHaveLength(1);
        const fn = result.rows[0];
        expect(fn?.prosecdef).toBe(true);
        expect(fn?.proconfig).toEqual(expect.arrayContaining(["search_path=pg_catalog, pg_temp", "lock_timeout=2s"]));
        expect(fn?.owner).toBe(new URL(OWNER_URL).username);
        expect(fn?.public_exec).toBe(false);
    });

    it("should deny EXECUTE on audit_logs_ensure_partitions to a role outside vcare_app", async () => {
        const role = `care_probe_${randomBytes(4).toString("hex")}`;
        const password = randomBytes(12).toString("hex");
        throwaway.push(role);
        const ddl = await ownerDb.raw<{ rows: Array<{ ddl: string }> }>(
            "SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', ?::text, ?::text) AS ddl",
            [role, password],
        );
        await ownerDb.raw(ddl.rows[0]?.ddl ?? "");

        await withPool(urlFor(role, password), async (outsider) => {
            await expect(outsider.raw("SELECT * FROM audit_logs_ensure_partitions(0)")).rejects.toMatchObject({ code: "42501" });
            await expect(outsider.raw("SELECT count(*) FROM audit_logs")).rejects.toMatchObject({ code: "42501" });
        });
    });

    it("should make ensureAppLogin idempotent and resync the password and membership on a second run (A14)", async () => {
        const app = new URL(APP_URL);
        // Drift: a rotated password and a lost membership.
        await ownerDb.raw(`ALTER ROLE ${app.username} PASSWORD 'synthetic-drifted-pw-1180'`);
        await ownerDb.raw(`REVOKE vcare_app FROM ${app.username}`);
        await expect(withPool(APP_URL, (conn) => conn.raw("SELECT 1"))).rejects.toMatchObject({ code: "28P01" });

        await expect(ensureAppLogin(ownerDb, APP_URL)).resolves.toEqual({ created: false });
        await expect(ensureAppLogin(ownerDb, APP_URL)).resolves.toEqual({ created: false });

        await withPool(APP_URL, async (conn) => {
            const result = await conn.raw<{ rows: Array<{ count: number }> }>("SELECT count(*)::int AS count FROM audit_logs");
            expect(result.rows[0]?.count).toBe(0);
        });
    });

    it("should create a new login with the role attributes and vcare_app membership, then report created=false (A14)", async () => {
        const role = `care_app_probe_${randomBytes(3).toString("hex")}`;
        const password = `p'w"${randomBytes(6).toString("hex")}`; // quoting is PostgreSQL's (%L), not ours
        throwaway.push(role);
        const url = urlFor(role, password);

        await expect(ensureAppLogin(ownerDb, url)).resolves.toEqual({ created: true });
        await expect(ensureAppLogin(ownerDb, url)).resolves.toEqual({ created: false });

        const attrs = await ownerDb.raw<{ rows: Array<Record<string, boolean>> }>(
            `SELECT rolcanlogin, rolinherit, rolsuper, rolcreatedb, rolcreaterole, pg_has_role(rolname, 'vcare_app', 'MEMBER') AS member
             FROM pg_roles WHERE rolname = ?`,
            [role],
        );
        expect(attrs.rows[0]).toEqual({
            rolcanlogin: true,
            rolinherit: true,
            rolsuper: false,
            rolcreatedb: false,
            rolcreaterole: false,
            member: true,
        });
        await withPool(url, async (conn) => {
            await expect(conn.raw("SELECT count(*) FROM audit_logs")).resolves.toBeDefined();
            await expect(conn.raw("DELETE FROM audit_logs")).rejects.toMatchObject({ code: "42501" });
        });
    });

    it("should provision the app login through `migrate ensure-app-login` and log only created (CLI)", async () => {
        const result = await runMigrate("ensure-app-login", { DATABASE_URL: APP_URL, MIGRATION_DATABASE_URL: OWNER_URL });
        expect(result.code).toBe(0);
        const ensured = jsonLines(result.output).find((line) => line.message === "app_login_ensured");
        expect(ensured).toMatchObject({ level: "info", created: false });
        // Neither URL (each carries a password) nor the app login's user:password pair reaches the output.
        expect(result.output).not.toContain(APP_URL);
        expect(result.output).not.toContain(OWNER_URL);
        expect(result.output).not.toContain(`${new URL(APP_URL).username}:${new URL(APP_URL).password}`);
    });

    it("should refuse to run when DATABASE_URL names the owner role (role collision) without echoing the URL", async () => {
        const collided = urlFor(new URL(OWNER_URL).username, "synthetic-collision-pw-7790");
        const result = await runMigrate("ensure-app-login", { DATABASE_URL: collided, MIGRATION_DATABASE_URL: OWNER_URL });
        expect(result.code).toBe(1);
        const line = jsonLines(result.output).find((entry) => entry.message === "invalid_environment");
        expect(line?.keys).toEqual(["MIGRATION_DATABASE_URL"]);
        expect(result.output).not.toContain("synthetic-collision-pw-7790");
        // The owner was not touched: its password still works.
        await expect(ownerDb.raw("SELECT 1")).resolves.toBeDefined();
        await withPool(OWNER_URL, (conn) => conn.raw("SELECT 1"));
    });

    it("should refuse ensure-app-login without MIGRATION_DATABASE_URL (care-api/worker never hold the owner secret)", async () => {
        const result = await runMigrate("ensure-app-login", { DATABASE_URL: APP_URL, MIGRATION_DATABASE_URL: "" });
        expect(result.code).toBe(1);
        expect(jsonLines(result.output).find((entry) => entry.message === "invalid_environment")?.keys).toEqual([
            "MIGRATION_DATABASE_URL",
        ]);
    });
});
