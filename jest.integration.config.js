/** Integration tests: real wiring, real Postgres, real Redis. Only system-external deps are faked. */
/** @type {import("jest").Config} */
module.exports = {
    testEnvironment: "node",
    roots: ["<rootDir>/tests/integration"],
    testMatch: ["**/*.test.ts"],
    transform: {
        "^.+\\.ts$": ["ts-jest", { tsconfig: "tsconfig.json" }],
    },
    setupFiles: ["<rootDir>/tests/setup-env.ts"],
    setupFilesAfterEnv: ["<rootDir>/tests/setup.ts"],
    globalSetup: "<rootDir>/tests/integration/global-setup.ts",
    globalTeardown: "<rootDir>/tests/integration/global-teardown.ts",
    clearMocks: true,
    maxWorkers: 1,
    testTimeout: 20000,
};
