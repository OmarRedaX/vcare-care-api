export type ApplicationName = "care-api" | "care-worker" | "care-migrate" | "care-test";

export interface KnexOptions {
    url: string;
    poolMax: number;
    /** `null` leaves the server default in place (migrations must not be killed mid-DDL). */
    statementTimeoutMs: number | null;
    applicationName: ApplicationName;
}

/** The raw `pg` client handed to Knex's `afterCreate` hook. */
export interface PgConnection {
    query(sql: string, callback: (error: Error | null) => void): void;
}
