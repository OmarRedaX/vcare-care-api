export type ApplicationName = "care-api" | "care-api-probe" | "care-worker" | "care-migrate" | "care-test";

export interface KnexOptions {
    url: string;
    poolMax: number;
    /** `null` leaves the server default in place (migrations must not be killed mid-DDL). */
    statementTimeoutMs: number | null;
    applicationName: ApplicationName;
}

/** The `pg` client configuration handed to Knex as `connection` (spec §3.4.8). */
export interface PgConnectionConfig {
    connectionString: string;
    application_name: ApplicationName;
    /** Startup parameter: `-c TimeZone=UTC`. */
    options: string;
    connectionTimeoutMillis: number;
    keepAlive: boolean;
    keepAliveInitialDelayMillis: number;
    statement_timeout?: number;
    query_timeout?: number;
}


/**
 * The pg 8.23 `Client` fields `isConnectionIdle` reads (spec §3.4.8). They are pg-PRIVATE: no public signal says
 * "a query timed out on this connection". Pinned by `tests/unit/lib/knex/pg-connection-state.test.ts`.
 */
export interface PgClientQueryState {
    _activeQuery?: unknown;
    _queryQueue?: unknown;
    _sentQueryQueue?: unknown;
}

/** The app login parsed from `DATABASE_URL` (ADR 0018). Never logged. */
export interface AppLoginCredentials {
    user: string;
    password: string;
}

/** `ensureAppLogin`'s check of an existing app role (snake_case: the raw `pg_roles` row). */
export interface ExistingAppRoleRow {
    privileged: boolean;
    owns_objects: boolean;
    /** A direct `pg_auth_members` membership in any role other than `vcare_app` (owner, `pg_write_all_data`, …). */
    has_other_memberships: boolean;
}

export interface AppLoginResult {
    /** `true` when the login was created; `false` when it existed and its password and membership were re-synced. */
    created: boolean;
}
