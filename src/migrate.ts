import fs from "node:fs";
import path from "node:path";
import { getEnv } from "./lib/config/env";
import { createKnex } from "./lib/knex/knex";
import { migrationConfig } from "./lib/knex/knexfile";
import { runMain } from "./lib/lifecycle/run-main";
import { logger } from "./lib/logger/logger";

const NAME_PATTERN = /^[a-z][a-z0-9_]{2,80}$/;

const TEMPLATE = `import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
    await knex.raw(\`
        -- raw SQL only; name every constraint; comment every index with the query it serves
    \`);
}

export async function down(knex: Knex): Promise<void> {
    await knex.raw(\`
        -- the real inverse of up()
    \`);
}
`;

function timestamp(): string {
    const now = new Date();
    const pad = (value: number): string => String(value).padStart(2, "0");
    return [
        String(now.getUTCFullYear()),
        pad(now.getUTCMonth() + 1),
        pad(now.getUTCDate()),
        pad(now.getUTCHours()),
        pad(now.getUTCMinutes()),
        pad(now.getUTCSeconds()),
    ].join("");
}

function makeMigration(name: string | undefined): number {
    if (name === undefined || !NAME_PATTERN.test(name)) {
        logger.error("migration_name_invalid", { pattern: NAME_PATTERN.source });
        return 1;
    }
    const file = path.join(process.cwd(), "src", "migrations", `${timestamp()}_${name}.ts`);
    fs.writeFileSync(file, TEMPLATE, { encoding: "utf8", flag: "wx" });
    logger.info("migration_created", { file: path.basename(file) });
    return 0;
}

async function run(command: string): Promise<number> {
    const env = getEnv();
    const knex = createKnex({
        url: env.DATABASE_URL,
        poolMax: 1,
        statementTimeoutMs: null,
        applicationName: "care-migrate",
    });

    try {
        switch (command) {
            case "latest": {
                const [batch, files] = (await knex.migrate.latest(migrationConfig)) as [number, string[]];
                logger.info("migrations_applied", { batch, files });
                return 0;
            }
            case "rollback": {
                const [batch, files] = (await knex.migrate.rollback(migrationConfig)) as [number, string[]];
                logger.info("migrations_rolled_back", { batch, files });
                return 0;
            }
            case "status": {
                const [completed, pending] = (await knex.migrate.list(migrationConfig)) as [string[], unknown[]];
                logger.info("migrations_status", { completed: completed.length, pending: pending.length });
                return 0;
            }
            default:
                logger.error("migration_command_unknown", { command });
                return 1;
        }
    } catch (error) {
        logger.error("migration_failed", { command, error });
        return 1;
    } finally {
        await knex.destroy();
    }
}

async function main(): Promise<void> {
    const [command = "latest", name] = process.argv.slice(2);

    const code = command === "make" ? makeMigration(name) : await run(command);
    process.exit(code);
}

runMain(main);
