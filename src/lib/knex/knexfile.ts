import path from "node:path";
import type { Knex } from "knex";

const runningFromSource = __filename.endsWith(".ts");

/** Raw-SQL migrations live in `src/migrations` (compiled to `dist/migrations`). */
export const migrationConfig: Knex.MigratorConfig = {
    directory: path.join(__dirname, "../../migrations"),
    loadExtensions: runningFromSource ? [".ts"] : [".js"],
    tableName: "knex_migrations",
};
