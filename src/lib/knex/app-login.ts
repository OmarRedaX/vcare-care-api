import type { Knex } from "knex";
import { logger } from "../logger/logger";
import type { AppLoginCredentials, AppLoginResult, ExistingAppRoleRow } from "./types";

/** A plain, unquoted PostgreSQL role name: what `%I` renders without quotes, and what a URL user can carry. */
const ROLE_NAME_PATTERN = /^[a-z_][a-z0-9_]{0,62}$/;

const APP_GROUP_ROLE = "vcare_app";

/** A Postgres SQLSTATE: the only part of a DDL failure that is safe to carry (never the message). */
const SQLSTATE_PATTERN = /^[0-9A-Z]{5}$/;

/**
 * An existing role is taken over only when it holds nothing beyond what `CREATE ROLE` below would give it. Owned
 * objects are recorded in `pg_shdepend` (deptype `o`) for every database of the cluster.
 */
const EXISTING_ROLE_SQL = `
    SELECT (r.rolsuper OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication OR r.rolbypassrls) AS privileged,
        EXISTS (
            SELECT 1 FROM pg_shdepend d
            WHERE d.refclassid = 'pg_authid'::regclass AND d.refobjid = r.oid AND d.deptype = 'o'
            ) AS owns_objects
    FROM pg_roles r
    WHERE r.rolname = ?`;

/** Thrown when DATABASE_URL cannot name the app login. Carries no value (CLAUDE.md → Security rules). */
function invalidUrl(): Error {
    return new Error("app_login_url_invalid");
}

/**
 * Knex prefixes every failed statement's SQL to the error message, and the DDL carries the password as a literal: a
 * code-less failure (a dropped connection) would put it into `migration_failed`. The rethrown error is fixed and keeps
 * only a SQLSTATE `code` — never the message, the stack, or a `cause` (review 2026-10-03, M1).
 */
function ddlFailed(error: unknown): Error {
    const failure = new Error("app_login_ddl_failed");
    const code = (error as { code?: unknown } | null)?.code;
    if (typeof code === "string" && SQLSTATE_PATTERN.test(code)) {
        Object.assign(failure, { code });
    }
    return failure;
}

/** `format(<template>, ...args)` evaluated by PostgreSQL, so `%I`/`%L` quoting is the server's, never ours. */
async function buildDdl(conn: Knex.Transaction, template: string, args: string[]): Promise<string> {
    const placeholders = args.map(() => "?::text").join(", ");
    const result = await conn.raw<{ rows: Array<{ ddl: string }> }>(`SELECT format(?::text, ${placeholders}) AS ddl`, [
        template,
        ...args,
    ]);
    const ddl = result.rows[0]?.ddl;
    if (ddl === undefined) {
        throw new Error("app_login_ddl_missing");
    }
    return ddl;
}

/** User + password from the app's DATABASE_URL (URL-decoded), validated; never echoes either value. */
export function parseAppLoginUrl(appDatabaseUrl: string): AppLoginCredentials {
    let user: string;
    let password: string;
    try {
        const url = new URL(appDatabaseUrl);
        user = decodeURIComponent(url.username);
        password = decodeURIComponent(url.password);
    } catch {
        throw invalidUrl();
    }
    if (!ROLE_NAME_PATTERN.test(user) || password.length === 0) {
        throw invalidUrl();
    }
    return { user, password };
}

/**
 * Creates or updates the app login (`care_app`) named by `DATABASE_URL` as a member of `vcare_app` (ADR 0018). Runs as
 * the owner (`care-migrate ensure-app-login`, after `latest`). The DDL is built server-side with `format(%I, %L)` —
 * PostgreSQL does the quoting, nothing is concatenated here. Logs `app_login_ensured { created }` only: never the user
 * name, the password, or a URL. Keep server-side `log_statement` off while it runs (runbook).
 *
 * An existing role that is privileged (`SUPERUSER`, `CREATEROLE`, `CREATEDB`, `REPLICATION`, `BYPASSRLS`) or owns
 * objects is REFUSED with `app_login_role_privileged` instead of being taken over or demoted: resetting it could
 * silently strip a real operator role that `DATABASE_URL` names by mistake, and a `CREATEROLE`-only owner cannot
 * change those attributes anyway. Every DDL failure is rethrown as `app_login_ddl_failed` (SQLSTATE only).
 */
export async function ensureAppLogin(owner: Knex, appDatabaseUrl: string): Promise<AppLoginResult> {
    const { user, password } = parseAppLoginUrl(appDatabaseUrl);

    const created = await owner.transaction(async (trx) => {
        const existing = await trx.raw<{ rows: ExistingAppRoleRow[] }>(EXISTING_ROLE_SQL, [user]);
        const role = existing.rows[0];
        if (role !== undefined && (role.privileged || role.owns_objects)) {
            throw new Error("app_login_role_privileged");
        }
        const absent = role === undefined;

        try {
            const statements = absent
                ? [
                      await buildDdl(
                          trx,
                          `CREATE ROLE %I WITH LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD %L IN ROLE ${APP_GROUP_ROLE}`,
                          [user, password],
                      ),
                  ]
                : [
                      await buildDdl(trx, "ALTER ROLE %I WITH LOGIN PASSWORD %L", [user, password]),
                      await buildDdl(trx, `GRANT ${APP_GROUP_ROLE} TO %I`, [user]),
                  ];

            for (const ddl of statements) {
                // No bindings: Knex sends the server-built statement verbatim.
                await trx.raw(ddl);
            }
        } catch (error) {
            throw ddlFailed(error);
        }
        return absent;
    });

    logger.info("app_login_ensured", { created });
    return { created };
}
