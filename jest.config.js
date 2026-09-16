/** Unit tests: isolated units, collaborators mocked, no infrastructure. */
/** @type {import("jest").Config} */
module.exports = {
    testEnvironment: "node",
    roots: ["<rootDir>/tests/unit"],
    testMatch: ["**/*.test.ts"],
    transform: {
        "^.+\\.ts$": ["ts-jest", { tsconfig: "tsconfig.json" }],
    },
    setupFiles: ["<rootDir>/tests/setup-env.ts"],
    setupFilesAfterEnv: ["<rootDir>/tests/setup.ts"],
    clearMocks: true,
    testTimeout: 5000,
};
