// MUST stay the first import: it loads `.env.test` as a side effect. `src/lib/knex/knex` calls `getEnv()` at
// module load (for the shared `db` pool), and globalSetup runs outside jest's `setupFiles`, so importing it
// before the env is loaded makes env validation fail and `process.exit(1)` the whole run.
import { loadTestEnv } from "../setup-env";
import { createKnex } from "../../src/lib/knex/knex";
import { migrationConfig } from "../../src/lib/knex/knexfile";

/** Runs once before the integration suites: migrate the real test database, then release the pool. */
export default async function globalSetup(): Promise<void> {
    loadTestEnv();

    const url = process.env.DATABASE_URL;
    if (url === undefined) {
        throw new Error("DATABASE_URL is not set — is .env.test present?");
    }

    const knex = createKnex({
        url,
        poolMax: 1,
        statementTimeoutMs: null,
        applicationName: "care-migrate",
    });

    try {
        await knex.migrate.latest(migrationConfig);
    } finally {
        await knex.destroy();
    }
}
