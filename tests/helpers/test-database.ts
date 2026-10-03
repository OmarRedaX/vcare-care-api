import type { Knex } from "knex";

/** Only a database whose name ends in `_test` (docker-compose.test.yml: `care_test`) may be truncated or rolled back. */
export const TEST_DATABASE_NAME_PATTERN = /_test$/;

/** Fixed: never echoes the URL, the user, the password, or the database name (CLAUDE.md → Security rules). */
const REFUSAL = "refusing_non_test_database: integration suites run only with NODE_ENV=test against a *_test database";

/**
 * The integration suites TRUNCATE every table, roll back every migration (dropping `audit_logs` and the cluster role
 * `vcare_app`), reset the `care_app` password, and drop partitions (review 2026-10-03, L9). `loadTestEnv` never
 * overrides variables a shell already exported, so a shell holding the dev `.env` would aim all of that at the dev
 * database — this guard refuses instead.
 */
export function assertTestDatabaseName(name: unknown, nodeEnv: string | undefined = process.env.NODE_ENV): void {
    if (nodeEnv !== "test" || typeof name !== "string" || !TEST_DATABASE_NAME_PATTERN.test(name)) {
        throw new Error(REFUSAL);
    }
}

/** Synchronous pre-check of a connection URL (module load of the owner pool); the database is the URL path. */
export function assertTestDatabaseUrl(url: string | undefined, nodeEnv?: string): void {
    let name: string | undefined;
    try {
        name = decodeURIComponent(new URL(url ?? "").pathname.replace(/^\//, ""));
    } catch {
        name = undefined;
    }
    assertTestDatabaseName(name, nodeEnv);
}

/** The authoritative check: asks the server which database this connection really reached (`current_database()`). */
export async function assertTestDatabase(conn: Knex, nodeEnv?: string): Promise<void> {
    const result = await conn.raw<{ rows: Array<{ name: string }> }>("SELECT current_database() AS name");
    assertTestDatabaseName(result.rows[0]?.name, nodeEnv);
}
