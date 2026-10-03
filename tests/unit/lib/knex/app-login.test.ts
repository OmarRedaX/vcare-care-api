import type { Knex } from "knex";
import { ensureAppLogin, parseAppLoginUrl } from "../../../../src/lib/knex/app-login";
import { logger } from "../../../../src/lib/logger/logger";

const APP_URL = "postgres://care_app:synthetic-pw-8823@localhost:5434/care_test";

/**
 * An owner-connection stand-in: `SELECT 1 FROM pg_roles` answers per scenario, `SELECT format(...)` returns a marker
 * built from its bindings (PostgreSQL does the real quoting — proven by the db-roles integration suite), and every
 * other statement is recorded as executed DDL.
 */
function fakeOwner(roleExists: boolean) {
    const formats: unknown[][] = [];
    const executed: Array<{ sql: string; bindings: unknown }> = [];
    const raw = jest.fn((sql: string, bindings?: unknown[]) => {
        if (sql.startsWith("SELECT 1 FROM pg_roles")) {
            return Promise.resolve({ rows: roleExists ? [{ present: 1 }] : [] });
        }
        if (sql.startsWith("SELECT format(")) {
            formats.push(bindings ?? []);
            return Promise.resolve({ rows: [{ ddl: `DDL#${formats.length}` }] });
        }
        executed.push({ sql, bindings });
        return Promise.resolve({ rows: [] });
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

        expect(raw.mock.calls[0]).toEqual(["SELECT 1 FROM pg_roles WHERE rolname = ?", ["care_app"]]);
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
});
