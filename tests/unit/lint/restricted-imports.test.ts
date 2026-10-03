import { spawnSync } from "node:child_process";
import path from "node:path";

/**
 * F23: the layering and forbidden-library rules are enforced by the REAL eslint.config.mjs. ESLint loads its
 * flat config with a dynamic `import()`, which jest's VM sandbox cannot run, so the ESLint Node API is driven
 * from one child `node` process for all snippets. Type-aware rules are switched off for the in-memory
 * snippets (they are not part of the TS program); `no-restricted-imports` is not type-aware.
 */
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

const SNIPPETS: Array<{ id: string; filePath: string; code: string }> = [
    {
        id: "pkg-imports-lib",
        filePath: "src/pkg/utils/__lint_probe__.ts",
        code: 'import { logger } from "../../lib/logger/logger";\nexport const probe = logger;\n',
    },
    {
        id: "pkg-imports-app",
        filePath: "src/pkg/utils/__lint_probe__.ts",
        code: 'import { HealthStatus } from "../../app/health/enums";\nexport const probe = HealthStatus;\n',
    },
    {
        id: "pkg-imports-io",
        filePath: "src/pkg/utils/__lint_probe__.ts",
        code: 'import knex from "knex";\nexport const probe = knex;\n',
    },
    {
        id: "lib-imports-app",
        filePath: "src/lib/http/__lint_probe__.ts",
        code: 'import { HealthService } from "../../app/health/service/health.service";\nexport const probe = HealthService;\n',
    },
    {
        id: "any-imports-axios-jsonwebtoken",
        filePath: "src/app/health/__lint_probe__.ts",
        code: 'import axios from "axios";\nimport jwt from "jsonwebtoken";\nexport const probe = [axios, jwt];\n',
    },
    {
        id: "any-imports-orm",
        filePath: "tests/__lint_probe__.ts",
        code: 'import { PrismaClient } from "@prisma/client";\nimport { Module } from "@nestjs/common";\nexport const probe = [PrismaClient, Module];\n',
    },
    {
        id: "clean-pkg",
        filePath: "src/pkg/utils/__lint_probe__.ts",
        code: 'import { toMs } from "./time";\nexport const probe = toMs(1, "s");\n',
    },
    {
        id: "clean-app-imports-lib",
        filePath: "src/app/health/__lint_probe__.ts",
        code: 'import { TOKENS } from "../../lib/di/tokens";\nexport const probe = TOKENS;\n',
    },
    // access spec §3.11: jose only under src/lib/auth, undici only in jwks-fetcher.ts (later lib/identity-client),
    // no global fetch in src/.
    {
        id: "jose-outside-auth",
        filePath: "src/lib/rbac/__lint_probe__.ts",
        code: 'import { jwtVerify } from "jose";\nexport const probe = jwtVerify;\n',
    },
    {
        id: "jose-subpath-in-app",
        filePath: "src/app/health/__lint_probe__.ts",
        code: 'import { errors } from "jose/errors";\nexport const probe = errors;\n',
    },
    {
        id: "jose-inside-auth",
        filePath: "src/lib/auth/__lint_probe__.ts",
        code: 'import { jwtVerify } from "jose";\nexport const probe = jwtVerify;\n',
    },
    {
        id: "undici-in-auth-outside-fetcher",
        filePath: "src/lib/auth/__lint_probe__.ts",
        code: 'import { request } from "undici";\nexport const probe = request;\n',
    },
    {
        id: "undici-in-app",
        filePath: "src/app/health/__lint_probe__.ts",
        code: 'import { request } from "undici";\nexport const probe = request;\n',
    },
    {
        id: "undici-in-fetcher",
        filePath: "src/lib/auth/jwks-fetcher.ts",
        code: 'import { request } from "undici";\nexport const probe = request;\n',
    },
    {
        id: "undici-in-identity-client",
        filePath: "src/lib/identity-client/__lint_probe__.ts",
        code: 'import { request } from "undici";\nexport const probe = request;\n',
    },
    {
        id: "global-fetch-in-src",
        filePath: "src/lib/auth/jwks-fetcher.ts",
        code: 'export const probe = (): Promise<unknown> => fetch("http://identity.example.test/.well-known/jwks.json");\n',
    },
    {
        id: "jose-and-fetch-in-tests",
        filePath: "tests/__lint_probe__.ts",
        code: 'import { SignJWT } from "jose";\nexport const probe = [SignJWT, fetch];\n',
    },
];

const RUNNER = `
const { ESLint } = require("eslint");
const tseslint = require("typescript-eslint");
const snippets = JSON.parse(process.argv[1]);
(async () => {
  const eslint = new ESLint({
    cwd: process.cwd(),
    overrideConfig: [{ files: ["**/*.ts"], ...tseslint.configs.disableTypeChecked }],
  });
  const out = {};
  for (const snippet of snippets) {
    const [result] = await eslint.lintText(snippet.code, { filePath: snippet.filePath });
    out[snippet.id] = result.messages.map((m) => ({ ruleId: m.ruleId, message: m.message }));
  }
  process.stdout.write(JSON.stringify(out));
})().catch((error) => { process.stderr.write(String(error && error.stack)); process.exit(1); });
`;

type LintMessages = Record<string, Array<{ ruleId: string | null; message: string }>>;

describe("eslint.config.mjs restricted imports (F23)", () => {
    let results: LintMessages;

    beforeAll(() => {
        const child = spawnSync(process.execPath, ["-e", RUNNER, JSON.stringify(SNIPPETS)], {
            cwd: REPO_ROOT,
            encoding: "utf8",
            timeout: 60_000,
        });
        if (child.status !== 0) {
            throw new Error(`eslint runner failed: ${child.stderr}`);
        }
        results = JSON.parse(child.stdout) as LintMessages;
    }, 90_000);

    const restricted = (id: string) => (results[id] ?? []).filter((message) => message.ruleId === "no-restricted-imports");

    it("should report an error when src/pkg imports lib", () => {
        expect(restricted("pkg-imports-lib")).toEqual([
            expect.objectContaining({ message: expect.stringContaining("pkg/ is pure") as string }),
        ]);
    });

    it("should report an error when src/pkg imports app", () => {
        expect(restricted("pkg-imports-app")).toHaveLength(1);
    });

    it("should report an error when src/pkg imports an I/O library", () => {
        expect(restricted("pkg-imports-io")).toEqual([
            expect.objectContaining({ message: expect.stringContaining("pkg/ is pure") as string }),
        ]);
    });

    it("should report an error when src/lib imports app", () => {
        expect(restricted("lib-imports-app")).toEqual([
            expect.objectContaining({ message: expect.stringContaining("lib/ must not import app/") as string }),
        ]);
    });

    it("should report an error when any file imports axios or jsonwebtoken", () => {
        const messages = restricted("any-imports-axios-jsonwebtoken").map((message) => message.message);
        expect(messages).toHaveLength(2);
        expect(messages.join("\n")).toContain("'axios'");
        expect(messages.join("\n")).toContain("'jsonwebtoken'");
        expect(messages.every((message) => message.includes("Forbidden by CLAUDE.md"))).toBe(true);
    });

    it("should report an error when a test file imports an ORM or NestJS", () => {
        expect(restricted("any-imports-orm")).toHaveLength(2);
    });

    it("should report jose when it is imported outside src/lib/auth", () => {
        for (const id of ["jose-outside-auth", "jose-subpath-in-app"]) {
            expect(restricted(id)).toEqual([
                expect.objectContaining({ message: expect.stringContaining("jose is imported only under src/lib/auth") as string }),
            ]);
        }
        expect(results["jose-inside-auth"]).toEqual([]);
    });

    it("should report undici when it is imported outside jwks-fetcher.ts and lib/identity-client", () => {
        for (const id of ["undici-in-auth-outside-fetcher", "undici-in-app"]) {
            expect(restricted(id)).toEqual([
                expect.objectContaining({ message: expect.stringContaining("undici is imported only in src/lib/auth/jwks-fetcher.ts") as string }),
            ]);
        }
        expect(results["undici-in-fetcher"]).toEqual([]);
        expect(results["undici-in-identity-client"]).toEqual([]);
    });

    it("should report the global fetch anywhere in src, even in the fetcher", () => {
        expect((results["global-fetch-in-src"] ?? []).filter((message) => message.ruleId === "no-restricted-globals")).toEqual([
            expect.objectContaining({ message: expect.stringContaining("Use undici") as string }),
        ]);
    });

    it("should let tests import jose and use fetch", () => {
        expect(results["jose-and-fetch-in-tests"]).toEqual([]);
    });

    it("should report nothing when pkg imports a sibling and app imports lib", () => {
        expect(results["clean-pkg"]).toEqual([]);
        expect(results["clean-app-imports-lib"]).toEqual([]);
    });
});
