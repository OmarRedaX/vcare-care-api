import type { Knex } from "knex";
import { logger } from "../logger/logger";
import type { AppLoginCredentials, AppLoginResult } from "./types";

/** A plain, unquoted PostgreSQL role name: what `%I` renders without quotes, and what a URL user can carry. */
const ROLE_NAME_PATTERN = /^[a-z_][a-z0-9_]{0,62}$/;

const APP_GROUP_ROLE = "vcare_app";

/** Thrown when DATABASE_URL cannot name the app login. Carries no value (CLAUDE.md → Security rules). */
function invalidUrl(): Error {
    return new Error("app_login_url_invalid");
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
 */
export async function ensureAppLogin(owner: Knex, appDatabaseUrl: string): Promise<AppLoginResult> {
    const { user, password } = parseAppLoginUrl(appDatabaseUrl);

    const created = await owner.transaction(async (trx) => {
        const existing = await trx.raw<{ rows: unknown[] }>("SELECT 1 FROM pg_roles WHERE rolname = ?", [user]);
        const absent = existing.rows.length === 0;

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
        return absent;
    });

    logger.info("app_login_ensured", { created });
    return { created };
}
