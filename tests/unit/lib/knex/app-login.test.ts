import type { Knex } from "knex";
import { ensureAppLogin, parseAppLoginUrl } from "../../../../src/lib/knex/app-login";
import type { ExistingAppRoleRow } from "../../../../src/lib/knex/types";
import { Logger, logger } from "../../../../src/lib/logger/logger";

const APP_URL = "postgres://care_app:synthetic-pw-8823@localhost:5434/care_test";

/**
 * An owner-connection stand-in: the `pg_roles` check answers per scenario, `SELECT format(...)` returns a marker
 * built from its bindings (PostgreSQL does the real quoting — proven by the db-roles integration suite), and every
 * other statement is recorded as executed DDL.
 */
function fakeOwner(
    roleExists: boolean,
    existing: ExistingAppRoleRow = { privileged: false, owns_objects: false, has_other_memberships: false },
    executeDdl: (sql: string) => Promise<unknown> = () => Promise.resolve({ rows: [] }),
    roleCheck: () => Promise<unknown> = () => Promise.resolve({ rows: roleExists ? [existing] : [] }),
) {
    const formats: unknown[][] = [];
    const executed: Array<{ sql: string; bindings: unknown }> = [];
    const raw = jest.fn((sql: string, bindings?: unknown[]) => {
        if (sql.includes("FROM pg_roles")) {
            return roleCheck();
        }
        if (sql.startsWith("SELECT format(")) {
            formats.push(bindings ?? []);
            return Promise.resolve({ rows: [{ ddl: `DDL#${formats.length}` }] });
        }
        executed.push({ sql, bindings });
        return executeDdl(sql);
    });
    const trx = { raw };
    const transaction = jest.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(trx));
    const owner = { transaction } as unknown as Knex;
    return { owner, raw, formats, executed, transaction };
}

describe("lib/knex/ensureAppLogin", () => {
    let info: jest.SpyInstance;

    beforeEach(() => {
        info = jest.spyOn(logger, "info").mockImplementation(() => undefined);
    });
    afterEach(() => {
        jest.restoreAllMocks();
    });

    it("should build CREATE ROLE ... IN ROLE vcare_app through format() and run it when the login is absent", async () => {
        const { owner, raw, formats, executed } = fakeOwner(false);
        await expect(ensureAppLogin(owner, APP_URL)).resolves.toEqual({ created: true });

        expect(String(raw.mock.calls[0]?.[0])).toContain("FROM pg_roles r");
        // Parameterised: the group role and the login name are bindings, never concatenated.
        expect(raw.mock.calls[0]?.[1]).toEqual(["vcare_app", "care_app"]);
        expect(String(raw.mock.calls[0]?.[0])).toContain("FROM pg_auth_members m");
        expect(String(raw.mock.calls[0]?.[0])).not.toContain("care_app");
        expect(formats).toEqual([
            [
                "CREATE ROLE %I WITH LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD %L IN ROLE vcare_app",
                "care_app",
                "synthetic-pw-8823",
            ],
        ]);
        // The server-built statement runs verbatim, without bindings; nothing is concatenated in TypeScript.
        expect(executed).toEqual([{ sql: "DDL#1", bindings: undefined }]);
        for (const call of raw.mock.calls) {
            expect(String(call[0])).not.toContain("synthetic-pw-8823");
        }
    });

    it("should ALTER the password and GRANT vcare_app when the login is present (idempotent re-run, membership repair)", async () => {
        const { owner, formats, executed } = fakeOwner(true);
        await expect(ensureAppLogin(owner, APP_URL)).resolves.toEqual({ created: false });
        expect(formats).toEqual([
            ["ALTER ROLE %I WITH LOGIN PASSWORD %L", "care_app", "synthetic-pw-8823"],
            ["GRANT vcare_app TO %I", "care_app"],
        ]);
        expect(executed.map((statement) => statement.sql)).toEqual(["DDL#1", "DDL#2"]);
    });

    it("should run everything in one owner transaction", async () => {
        const { owner, transaction } = fakeOwner(true);
        await ensureAppLogin(owner, APP_URL);
        expect(transaction).toHaveBeenCalledTimes(1);
    });

    it("should URL-decode the user and password", () => {
        expect(parseAppLoginUrl("postgres://care_app:p%40ss%3Aword@h:5432/db")).toEqual({
            user: "care_app",
            password: "p@ss:word",
        });
    });

    it.each([
        ["a URL without a password", "postgres://care_app@localhost:5434/care_test"],
        ["an upper-case user name", "postgres://Care_App:synthetic-pw-8823@localhost:5434/care_test"],
        ["a user name with a quote", "postgres://care%22app:synthetic-pw-8823@localhost:5434/care_test"],
        ["a user name starting with a digit", "postgres://1care:synthetic-pw-8823@localhost:5434/care_test"],
        ["a user name over 63 chars", `postgres://${"a".repeat(64)}:synthetic-pw-8823@localhost:5434/care_test`],
        ["no user at all", "postgres://localhost:5434/care_test"],
        ["not a URL", "synthetic-pw-8823"],
    ])("should reject %s with app_login_url_invalid without echoing it", async (_label, url) => {
        const { owner, raw } = fakeOwner(false);
        await expect(ensureAppLogin(owner, url)).rejects.toThrow(/^app_login_url_invalid$/);
        expect(raw).not.toHaveBeenCalled();
    });

    it("should log only created — never the user name, password, or URL", async () => {
        const { owner } = fakeOwner(false);
        await ensureAppLogin(owner, APP_URL);
        expect(info).toHaveBeenCalledTimes(1);
        expect(info).toHaveBeenCalledWith("app_login_ensured", { created: true });
        expect(JSON.stringify(info.mock.calls)).not.toMatch(/care_app|synthetic-pw-8823|localhost/);
    });

    it.each<[string, ExistingAppRoleRow]>([
        ["privileged", { privileged: true, owns_objects: false, has_other_memberships: false }],
        ["an object owner", { privileged: false, owns_objects: true, has_other_memberships: false }],
        ["a member of another role (owner, pg_write_all_data, …)", { privileged: false, owns_objects: false, has_other_memberships: true }],
    ])("should refuse an existing role that is %s with app_login_role_privileged and run no DDL (L1)", async (_label, existing) => {
        const { owner, formats, executed } = fakeOwner(true, existing);
        await expect(ensureAppLogin(owner, APP_URL)).rejects.toThrow(/^app_login_role_privileged$/);
        expect(formats).toEqual([]);
        expect(executed).toEqual([]);
        expect(info).not.toHaveBeenCalled();
    });

    it("should rethrow a code-less DDL failure as app_login_ddl_failed and never log the password (M1)", async () => {
        // What knex does on a dropped connection: the statement (with the literal password) prefixed to the message.
        const { owner } = fakeOwner(false, undefined, (sql) =>
            Promise.reject(new Error(`${sql} PASSWORD 'synthetic-pw-8823' - Connection terminated unexpectedly`)),
        );
        const rejection = await ensureAppLogin(owner, APP_URL).catch((error: unknown) => error);
        expect(rejection).toBeInstanceOf(Error);
        expect((rejection as Error).message).toBe("app_login_ddl_failed");
        expect((rejection as { code?: unknown }).code).toBeUndefined();
        expect((rejection as Error).stack ?? "").not.toContain("synthetic-pw-8823");
        expect((rejection as { cause?: unknown }).cause).toBeUndefined();

        // src/migrate.ts logs exactly this line on failure, through the real Logger serializer.
        const lines: string[] = [];
        const real = new Logger({ level: "debug", service: "care-service", write: (line) => lines.push(line) });
        real.error("migration_failed", { command: "ensure-app-login", error: rejection });
        expect(lines).toHaveLength(1);
        expect(lines.join("")).toContain("app_login_ddl_failed");
        expect(lines.join("")).not.toContain("synthetic-pw-8823");
    });

    it("should keep only the SQLSTATE code when the server rejects the DDL (M1)", async () => {
        const { owner } = fakeOwner(true, undefined, () =>
            Promise.reject(Object.assign(new Error("ALTER ROLE ... PASSWORD 'synthetic-pw-8823' - permission denied"), { code: "42501" })),
        );
        const rejection = (await ensureAppLogin(owner, APP_URL).catch((error: unknown) => error)) as Error & { code?: string };
        expect(rejection.message).toBe("app_login_ddl_failed");
        expect(rejection.code).toBe("42501");
        expect(JSON.stringify({ ...rejection, message: rejection.message })).not.toContain("synthetic-pw-8823");
    });

    it("should rethrow a code-less role-check failure as app_login_ddl_failed, carrying neither the login name nor the message (M1 note)", async () => {
        // A pool built WITH compileSqlOnError would interpolate the login name into the knex message.
        const { owner, formats, executed } = fakeOwner(true, undefined, undefined, () =>
            Promise.reject(new Error("SELECT ... WHERE r.rolname = 'care_app' - Connection terminated unexpectedly")),
        );
        const rejection = await ensureAppLogin(owner, APP_URL).catch((error: unknown) => error);
        expect((rejection as Error).message).toBe("app_login_ddl_failed");
        expect((rejection as { code?: unknown }).code).toBeUndefined();
        expect((rejection as Error).stack ?? "").not.toContain("care_app");
        expect(formats).toEqual([]);
        expect(executed).toEqual([]);
    });
});
