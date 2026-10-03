import type { Knex } from "knex";
import { assertTestDatabase, assertTestDatabaseName, assertTestDatabaseUrl } from "../../helpers/test-database";

const DEV_URL = "postgres://postgres:synthetic-dev-pw-4471@localhost:5432/vcare_care";
const TEST_URL = "postgres://care:care@localhost:5434/care_test";

/** A connection stand-in whose server reports `name` as current_database(). */
function connectedTo(name: string): Knex {
    return { raw: jest.fn(() => Promise.resolve({ rows: [{ name }] })) } as unknown as Knex;
}

describe("tests/helpers/test-database guard (L9)", () => {
    it("should accept care_test with NODE_ENV=test", async () => {
        expect(() => assertTestDatabaseName("care_test", "test")).not.toThrow();
        expect(() => assertTestDatabaseUrl(TEST_URL, "test")).not.toThrow();
        await expect(assertTestDatabase(connectedTo("care_test"), "test")).resolves.toBeUndefined();
    });

    it("should reject the dev database vcare_care without echoing the URL, user, password, or name", async () => {
        const fromUrl = (() => {
            try {
                assertTestDatabaseUrl(DEV_URL, "test");
            } catch (error) {
                return error as Error;
            }
            return undefined;
        })();
        expect(fromUrl?.message).toMatch(/^refusing_non_test_database/);
        for (const secret of ["synthetic-dev-pw-4471", "postgres", "vcare_care", "5432", DEV_URL]) {
            expect(fromUrl?.message).not.toContain(secret);
        }
        await expect(assertTestDatabase(connectedTo("vcare_care"), "test")).rejects.toThrow(/^refusing_non_test_database/);
    });

    it("should reject a *_test database when NODE_ENV is not test", async () => {
        expect(() => assertTestDatabaseName("care_test", "development")).toThrow(/^refusing_non_test_database/);
        expect(() => assertTestDatabaseName("care_test", "")).toThrow(/^refusing_non_test_database/);
        await expect(assertTestDatabase(connectedTo("care_test"), "production")).rejects.toThrow(/^refusing_non_test_database/);
    });

    it.each([
        ["a name that only contains _test", "care_test_backup"],
        ["a name without the suffix", "care"],
        ["an empty name", ""],
    ])("should reject %s", (_label, name) => {
        expect(() => assertTestDatabaseName(name, "test")).toThrow(/^refusing_non_test_database/);
    });

    it("should reject an unparsable or missing URL", () => {
        expect(() => assertTestDatabaseUrl(undefined, "test")).toThrow(/^refusing_non_test_database/);
        expect(() => assertTestDatabaseUrl("not a url", "test")).toThrow(/^refusing_non_test_database/);
    });

    it("should trust the server's current_database() over the URL", async () => {
        // A URL may say care_test while a proxy or pgbouncer alias lands elsewhere: the async check asks the server.
        await expect(assertTestDatabase(connectedTo("vcare_care"), "test")).rejects.toThrow(/^refusing_non_test_database/);
    });
});
