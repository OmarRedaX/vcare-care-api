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

/**
 * Narrow homes for two locked-stack libraries (access spec §3.11): `jose` only under `src/lib/auth`, `undici` only in
 * `src/lib/auth/jwks-fetcher.ts` (and later `src/lib/identity-client`). Tests are exempt (they sign tokens with jose).
 */
const JOSE_RESTRICTION = {
    paths: [{ name: "jose", message: "jose is imported only under src/lib/auth" }],
    patterns: [{ group: ["jose/*"], message: "jose is imported only under src/lib/auth" }],
};
const UNDICI_RESTRICTION = {
    paths: [
        {
            name: "undici",
            message: "undici is imported only in src/lib/auth/jwks-fetcher.ts and src/lib/identity-client",
        },
    ],
    patterns: [
        {
            group: ["undici/*"],
            message: "undici is imported only in src/lib/auth/jwks-fetcher.ts and src/lib/identity-client",
        },
    ],
};

const LIB_NO_APP_PATTERN = {
    group: ["**/app/**"],
    message: "lib/ must not import app/; register modules in src/bootstrap.ts",
};

/** `no-restricted-imports` options for a file group: a later config object replaces the rule, so each lists all. */
function restrictedImports({ paths = [], patterns = [], allowJose = false, allowUndici = false } = {}) {
    return [
        "error",
        {
            paths: [
                ...FORBIDDEN_PATHS,
                ...paths,
                ...(allowJose ? [] : JOSE_RESTRICTION.paths),
                ...(allowUndici ? [] : UNDICI_RESTRICTION.paths),
            ],
            patterns: [
                ...FORBIDDEN_PATTERNS,
                ...patterns,
                ...(allowJose ? [] : JOSE_RESTRICTION.patterns),
                ...(allowUndici ? [] : UNDICI_RESTRICTION.patterns),
            ],
        },
    ];
}

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
        // Production code: jose and undici only in their narrow homes (overridden below for lib/auth).
        files: ["src/**/*.ts"],
        rules: {
            "no-restricted-imports": restrictedImports(),
        },
    },
    {
        // pkg/ is pure: no I/O, no DI, no framework, no imports from lib/ or app/.
        files: ["src/pkg/**/*.ts"],
        rules: {
            "no-restricted-imports": restrictedImports({
                paths: ["express", "knex", "pg", "ioredis", "tsyringe"].map((name) => ({
                    name,
                    message: "pkg/ is pure: no I/O, no DI, no framework",
                })),
                patterns: [
                    {
                        group: ["**/lib/**", "**/app/**"],
                        message: "pkg/ is pure: no I/O, no DI, no framework",
                    },
                ],
            }),
        },
    },
    {
        // lib/ must not import app/; modules are registered in src/bootstrap.ts.
        files: ["src/lib/**/*.ts"],
        rules: {
            "no-restricted-imports": restrictedImports({ patterns: [LIB_NO_APP_PATTERN] }),
        },
    },
    {
        files: ["src/lib/auth/**/*.ts"],
        rules: {
            "no-restricted-imports": restrictedImports({ patterns: [LIB_NO_APP_PATTERN], allowJose: true }),
        },
    },
    {
        files: ["src/lib/auth/jwks-fetcher.ts"],
        rules: {
            "no-restricted-imports": restrictedImports({
                patterns: [LIB_NO_APP_PATTERN],
                allowJose: true,
                allowUndici: true,
            }),
        },
    },
    {
        files: ["src/lib/identity-client/**/*.ts"],
        rules: {
            "no-restricted-imports": restrictedImports({ patterns: [LIB_NO_APP_PATTERN], allowUndici: true }),
        },
    },
    {
        files: ["src/**/*.ts"],
        rules: {
            "no-console": "error",
            "no-restricted-globals": [
                "error",
                {
                    name: "fetch",
                    message: "Use undici (src/lib/auth/jwks-fetcher.ts, src/lib/identity-client) — CLAUDE.md → Tech stack",
                },
            ],
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
                {
                    selector: "Property[key.name='enableImplicitConversion'][value.value=true]",
                    message: "implicit conversion is off (#8); use ToInt()/ToBoolean()",
                },
                {
                    selector: "Decorator CallExpression[callee.name='Type'] > ArrowFunctionExpression[body.name=/^(Number|Boolean|String|Date)$/]",
                    message: "use ToInt()/ToBoolean() for query/param fields (#8)",
                },
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
