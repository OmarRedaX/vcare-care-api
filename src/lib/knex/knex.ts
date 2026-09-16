import knexFactory from "knex";
import type { Knex } from "knex";
import { types as pgTypes } from "pg";
import { getEnv } from "../config/env";
import type { KnexOptions, PgConnection } from "./types";

const INT8_OID = 20;
const DATE_OID = 1082;

/** BIGSERIAL ids and COUNT(*) are exposed as numbers (hub ADR 0004) — loudly refuse anything unsafe. */
export function parseInt8(value: string): number {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed)) {
        throw new Error("int8 value exceeds Number.MAX_SAFE_INTEGER");
    }
    return parsed;
}

pgTypes.setTypeParser(INT8_OID, parseInt8);
// DATE stays a plain "YYYY-MM-DD" string: converting it to a Date would shift it by the process timezone.
pgTypes.setTypeParser(DATE_OID, (value: string) => value);

export function createKnex(options: KnexOptions): Knex {
    return knexFactory({
        client: "pg",
        connection: {
            connectionString: options.url,
            application_name: options.applicationName,
        },
        pool: {
            min: 0,
            max: options.poolMax,
            afterCreate: (connection: unknown, done: (error: Error | null, connection: unknown) => void) => {
                const conn = connection as PgConnection;
                conn.query("SET TIME ZONE 'UTC'", (timezoneError) => {
                    if (timezoneError !== null || options.statementTimeoutMs === null) {
                        done(timezoneError, connection);
                        return;
                    }
                    conn.query(`SET statement_timeout = ${options.statementTimeoutMs}`, (timeoutError) => {
                        done(timeoutError, connection);
                    });
                });
            },
        },
        // Fast-fail on pool wait for request-serving components; migrations may queue.
        acquireConnectionTimeout: options.applicationName === "care-migrate" ? 60_000 : 1_000,
    });
}

/** The primary pool. Lazy (`min: 0`): importing this module opens no connection. */
export const db: Knex = createKnex({
    url: getEnv().DATABASE_URL,
    poolMax: getEnv().DATABASE_POOL_MAX,
    statementTimeoutMs: 2_000,
    applicationName: "care-api",
});
