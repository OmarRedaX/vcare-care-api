// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";

/** Libraries forbidden by CLAUDE.md → "Tech stack (locked)" (plus the packages ADR 0016 replaced with built-ins). */
const FORBIDDEN_MESSAGE = "Forbidden by CLAUDE.md → Tech stack (locked)";

const FORBIDDEN_PATHS = [
    "@prisma/client",
    "prisma",
    "typeorm",
    "sequelize",
    "drizzle-orm",
    "kysely",
    "graphql",
    "passport",
    "auth0",
    "jsonwebtoken",
    "moment",
    "moment-timezone",
    "node-fetch",
    "axios",
    "uuid",
    "dotenv",
    "cors",
].map((name) => ({ name, message: FORBIDDEN_MESSAGE }));

const FORBIDDEN_PATTERNS = [
    {
        group: [
            "drizzle-orm/*",
            "@mikro-orm/*",
            "@nestjs/*",
            "@apollo/*",
            "@grpc/*",
            "@trpc/*",
            "passport-*",
            "@auth0/*",
            "@clerk/*",
        ],
        message: FORBIDDEN_MESSAGE,
    },
];

export default tseslint.config(
    {
        ignores: ["dist/", "coverage/", "node_modules/"],
    },
    js.configs.recommended,
    ...tseslint.configs.recommendedTypeChecked,
    {
        files: ["**/*.ts"],
        languageOptions: {
            parserOptions: {
                project: ["./tsconfig.json"],
                tsconfigRootDir: import.meta.dirname,
            },
        },
        rules: {
            "@typescript-eslint/no-explicit-any": "error",
            "@typescript-eslint/no-unused-vars": [
                "error",
                {
                    args: "after-used",
                    argsIgnorePattern: "^_",
                    varsIgnorePattern: "^_",
                    caughtErrors: "all",
                    caughtErrorsIgnorePattern: "^_",
                },
            ],
            "@typescript-eslint/no-floating-promises": "error",
            "@typescript-eslint/consistent-type-imports": "error",
            "no-restricted-imports": [
                "error",
                { paths: FORBIDDEN_PATHS, patterns: FORBIDDEN_PATTERNS },
            ],
        },
    },
    {
        // pkg/ is pure: no I/O, no DI, no framework, no imports from lib/ or app/.
        files: ["src/pkg/**/*.ts"],
        rules: {
            "no-restricted-imports": [
                "error",
                {
                    paths: [
                        ...FORBIDDEN_PATHS,
                        ...["express", "knex", "pg", "ioredis", "tsyringe"].map((name) => ({
                            name,
                            message: "pkg/ is pure: no I/O, no DI, no framework",
                        })),
                    ],
                    patterns: [
                        ...FORBIDDEN_PATTERNS,
                        {
                            group: ["**/lib/**", "**/app/**"],
                            message: "pkg/ is pure: no I/O, no DI, no framework",
                        },
                    ],
                },
            ],
        },
    },
    {
        // lib/ must not import app/; modules are registered in src/bootstrap.ts.
        files: ["src/lib/**/*.ts"],
        rules: {
            "no-restricted-imports": [
                "error",
                {
                    paths: FORBIDDEN_PATHS,
                    patterns: [
                        ...FORBIDDEN_PATTERNS,
                        {
                            group: ["**/app/**"],
                            message: "lib/ must not import app/; register modules in src/bootstrap.ts",
                        },
                    ],
                },
            ],
        },
    },
    {
        files: ["src/**/*.ts"],
        rules: {
            "no-console": "error",
            "no-restricted-properties": [
                "error",
                {
                    object: "process",
                    property: "env",
                    message: "Read environment variables only in src/lib/config/env.ts",
                },
            ],
        },
    },
    {
        // CLAUDE.md → Module file conventions 11: declare types only in types.ts / *.d.ts.
        files: ["src/**/*.ts"],
        ignores: ["src/**/types.ts", "src/**/*.d.ts"],
        rules: {
            "no-restricted-syntax": [
                "error",
                { selector: "TSInterfaceDeclaration", message: "declare types only in types.ts" },
                { selector: "TSTypeAliasDeclaration", message: "declare types only in types.ts" },
            ],
        },
    },
    {
        files: ["src/lib/config/env.ts"],
        rules: {
            "no-restricted-properties": "off",
        },
    },
    {
        files: ["tests/**/*.ts"],
        rules: {
            "@typescript-eslint/no-unsafe-assignment": "off",
            "@typescript-eslint/no-unsafe-member-access": "off",
            "@typescript-eslint/no-unsafe-argument": "off",
            "@typescript-eslint/no-unsafe-call": "off",
            "@typescript-eslint/no-unsafe-return": "off",
        },
    },
    {
        files: ["**/*.mjs", "**/*.js"],
        extends: [tseslint.configs.disableTypeChecked],
    },
    {
        // Jest configs are CommonJS.
        files: ["**/*.js"],
        languageOptions: {
            sourceType: "commonjs",
            globals: {
                module: "writable",
                require: "readonly",
                __dirname: "readonly",
                process: "readonly",
            },
        },
    },
);
