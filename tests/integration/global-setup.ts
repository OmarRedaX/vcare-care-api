// MUST stay the first import: it loads `.env.test` as a side effect. `src/lib/knex/knex` calls `getEnv()` at
// module load (for the shared `db` pool), and globalSetup runs outside jest's `setupFiles`, so importing it
// before the env is loaded makes env validation fail and `process.exit(1)` the whole run.
import { loadTestEnv } from "../setup-env";
import { ensureAppLogin } from "../../src/lib/knex/app-login";
import { createKnex } from "../../src/lib/knex/knex";
import { migrationConfig } from "../../src/lib/knex/knexfile";

/**
 * Runs once before the integration suites, as the OWNER (`MIGRATION_DATABASE_URL`, ADR 0018): migrate the real test
 * database, then create/update the app login (`care_app`, member of `vcare_app`) that the code under test connects as
 * (`DATABASE_URL`) — exactly what `care-migrate` does (`latest` then `ensure-app-login`).
 */
export default async function globalSetup(): Promise<void> {
    loadTestEnv();

    const ownerUrl = process.env.MIGRATION_DATABASE_URL;
    const appUrl = process.env.DATABASE_URL;
    if (ownerUrl === undefined || appUrl === undefined) {
        throw new Error("MIGRATION_DATABASE_URL and DATABASE_URL must be set — is .env.test present?");
    }

    const owner = createKnex({
        url: ownerUrl,
        poolMax: 1,
        statementTimeoutMs: null,
        applicationName: "care-migrate",
    });

    try {
        await owner.migrate.latest(migrationConfig);
        await ensureAppLogin(owner, appUrl);
    } finally {
        await owner.destroy();
    }
}
