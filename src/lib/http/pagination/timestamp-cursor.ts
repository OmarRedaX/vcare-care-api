import type { Knex } from "knex";

export const TIMESTAMP_CURSOR_PG_FORMAT = 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"';

/** Select a UTC timestamp at Postgres's full microsecond precision. */
export function timestampCursorSelect(conn: Knex, column: string, alias: string): Knex.Raw {
    return conn.raw("to_char(?? AT TIME ZONE 'UTC', ?) AS ??", [column, TIMESTAMP_CURSOR_PG_FORMAT, alias]);
}
