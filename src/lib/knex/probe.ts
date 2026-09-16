import type { Knex } from "knex";

/** `SELECT 1` bounded by `timeoutMs`. A rejection or a timeout is `false` — readiness never hangs on Postgres. */
export async function probeDatabase(conn: Knex, timeoutMs: number): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
        timer.unref();
    });

    try {
        return await Promise.race([
            conn
                .raw("SELECT 1")
                .then(() => true)
                .catch(() => false),
            timeout,
        ]);
    } finally {
        if (timer !== undefined) {
            clearTimeout(timer);
        }
    }
}
