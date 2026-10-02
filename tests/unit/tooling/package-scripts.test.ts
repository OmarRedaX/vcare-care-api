import fs from "node:fs";
import path from "node:path";

const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "..", "..", "package.json"), "utf8")) as {
    scripts: Record<string, string>;
};

/**
 * Review 2026-09-26 (Low): `migrate:make` lacked `--env-file-if-exists=.env`, so a developer with only a `.env` file
 * got `invalid_environment` instead of a new migration file (importing the root logger validates the environment).
 */
describe("package.json scripts", () => {
    const migrateScripts = Object.entries(manifest.scripts).filter(([name]) => name === "migrate" || name.startsWith("migrate:"));

    it("should declare the five migrate scripts", () => {
        expect(migrateScripts.map(([name]) => name).sort()).toEqual([
            "migrate",
            "migrate:ensure-app-login",
            "migrate:make",
            "migrate:rollback",
            "migrate:status",
        ]);
    });

    it.each(migrateScripts)("should load .env when %s runs", (_name, command) => {
        expect(command).toContain("--env-file-if-exists=.env");
        expect(command).toContain("src/migrate.ts");
    });
});
