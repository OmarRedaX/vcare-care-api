import { createKnex } from "../../src/lib/knex/knex";
import { migrationConfig } from "../../src/lib/knex/knexfile";
import { loadTestEnv } from "../setup-env";

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
