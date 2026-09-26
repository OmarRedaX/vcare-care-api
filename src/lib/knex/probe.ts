import type { Knex } from "knex";
import { settleWithin } from "../async/settle-within";

/** `SELECT 1` bounded by `timeoutMs`. A rejection or a timeout is `false` — readiness never hangs on Postgres. */
export async function probeDatabase(conn: Knex, timeoutMs: number): Promise<boolean> {
    return settleWithin(
        conn
            .raw("SELECT 1")
            .then(() => true)
            .catch(() => false),
        timeoutMs,
        false,
    );
}
