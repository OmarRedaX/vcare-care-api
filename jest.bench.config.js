/** Opt-in benchmarks (`npm run test:bench`): wall-clock budgets, run alone, never in the parallel unit suite. */
/** @type {import("jest").Config} */
module.exports = {
    testEnvironment: "node",
    roots: ["<rootDir>/tests/bench"],
    testMatch: ["**/*.bench.test.ts"],
    transform: {
        "^.+\\.ts$": ["ts-jest", { tsconfig: "tsconfig.json" }],
    },
    setupFiles: ["<rootDir>/tests/setup-env.ts"],
    clearMocks: true,
};
