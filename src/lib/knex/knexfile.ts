import fs from "node:fs/promises";
import path from "node:path";
import type { Knex } from "knex";

const runningFromSource = __filename.endsWith(".ts");
const MIGRATIONS_DIRECTORY = path.join(__dirname, "../../migrations");

/**
 * Raw-SQL migrations in `src/migrations` (compiled to `dist/migrations`). Knex's default source records the file
 * name WITH its extension, so the compiled migrator (`…_create_extension_btree_gist.js`) and the source migrator
 * (`….ts`) would call one database's history "corrupt". This source records the name without the extension.
 */
export class MigrationFiles implements Knex.MigrationSource<string> {
    constructor(
        private readonly directory: string = MIGRATIONS_DIRECTORY,
        private readonly extension: ".ts" | ".js" = runningFromSource ? ".ts" : ".js",
    ) {}

    async getMigrations(): Promise<string[]> {
        const entries = await fs.readdir(this.directory);
        return entries.filter((file) => file.endsWith(this.extension) && !file.endsWith(".d.ts")).sort();
    }

    getMigrationName(file: string): string {
        return file.slice(0, -this.extension.length);
    }

    getMigration(file: string): Promise<Knex.Migration> {
        // A synchronous CommonJS load, like Knex's own file source: it resolves through tsx (dev), ts-jest (tests),
        // and plain Node (dist) alike, where a native `import()` of a `.ts` file would not.
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        return Promise.resolve(require(path.join(this.directory, file)) as Knex.Migration);
    }
}

export const migrationConfig: Knex.MigratorConfig = {
    migrationSource: new MigrationFiles(),
    tableName: "knex_migrations",
};
