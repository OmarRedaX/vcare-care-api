import fs from "node:fs";
import path from "node:path";

/**
 * Loads `.env.test` WITHOUT overriding variables that are already set, so CI (or a single test run)
 * can point at different infrastructure. No `dotenv` package (ADR 0016).
 */
export function loadTestEnv(file = ".env.test"): void {
    const absolute = path.resolve(process.cwd(), file);
    if (!fs.existsSync(absolute)) {
        return;
    }

    for (const line of fs.readFileSync(absolute, "utf8").split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed.length === 0 || trimmed.startsWith("#")) {
            continue;
        }
        const separator = trimmed.indexOf("=");
        if (separator === -1) {
            continue;
        }
        const key = trimmed.slice(0, separator).trim();
        const value = trimmed.slice(separator + 1).trim();
        if (process.env[key] === undefined) {
            process.env[key] = value;
        }
    }
}

loadTestEnv();
