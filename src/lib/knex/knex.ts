import knexFactory from "knex";
import type { Knex } from "knex";
import { types as pgTypes } from "pg";
import { getEnv } from "../config/env";
import { logger } from "../logger/logger";
import { buildKnexLog } from "./knex-log";
import { isConnectionIdle } from "./pg-connection-state";
import type { KnexOptions, PgConnectionConfig } from "./types";

const INT8_OID = 20;
const DATE_OID = 1082;

/** A connect that never completes (black-holed network, failover without RST) fails instead of hanging. */
const CONNECT_TIMEOUT_MS = 2_000;
/** TCP keepalive: a dead peer is detected long before kernel retransmission gives up (~15 min on Linux). */
const KEEPALIVE_INITIAL_DELAY_MS = 10_000;
/** Client-side margin over the server-side statement timeout: fires only when the server cannot. */
const QUERY_TIMEOUT_MARGIN_MS = 1_000;

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

/**
 * Session settings travel as startup parameters (no extra round trip inside the 1 s acquire window): `TimeZone=UTC`
 * via `options`, and the server-side `statement_timeout` with a client-side `query_timeout` just above it.
 */
export function buildConnectionConfig(options: KnexOptions): PgConnectionConfig {
    return {
        connectionString: options.url,
        application_name: options.applicationName,
        options: "-c TimeZone=UTC",
        connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
        keepAlive: true,
        keepAliveInitialDelayMillis: KEEPALIVE_INITIAL_DELAY_MS,
        ...(options.statementTimeoutMs === null
            ? {}
            : {
                  statement_timeout: options.statementTimeoutMs,
                  query_timeout: options.statementTimeoutMs + QUERY_TIMEOUT_MARGIN_MS,
              }),
    };
}

export function createKnex(options: KnexOptions): Knex {
    return knexFactory({
        client: "pg",
        connection: buildConnectionConfig(options),
        pool: {
            min: 0,
            max: options.poolMax,
            createTimeoutMillis: CONNECT_TIMEOUT_MS,
            // A connection whose query timed out client-side is discarded, never reissued (spec §3.4.8).
            validate: isConnectionIdle,
        },
        // Fast-fail on pool wait for request-serving components; migrations may queue.
        acquireConnectionTimeout: options.applicationName === "care-migrate" ? 60_000 : 1_000,
        // Never interpolate bindings into an error message (spec §3.4.4 / §3.4.8).
        compileSqlOnError: false,
        log: buildKnexLog(logger),
    });
}

/** The primary pool. Lazy (`min: 0`): importing this module opens no connection. */
export const db: Knex = createKnex({
    url: getEnv().DATABASE_URL,
    poolMax: getEnv().DATABASE_POOL_MAX,
    statementTimeoutMs: 2_000,
    applicationName: "care-api",
});

/** Readiness only (spec §3.1): its own connection, so a saturated request pool never reads as "database down". */
export const probeDb: Knex = createKnex({
    url: getEnv().DATABASE_URL,
    poolMax: 1,
    statementTimeoutMs: 2_000,
    applicationName: "care-api-probe",
});
