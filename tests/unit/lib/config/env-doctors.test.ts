import { InvalidEnvError, parseEnv } from "../../../../src/lib/config/env";

const base = { DATABASE_URL: "postgres://care_app:synthetic@localhost:5432/care_test",
    REDIS_URL: "redis://localhost:6379", IDENTITY_JWKS_URL: "http://localhost:3100/.well-known/jwks.json" };

describe("ALLOWED_CURRENCIES", () => {
    it("should parse EGP,USD into two currency codes", () => {
        expect(parseEnv({ ...base, ALLOWED_CURRENCIES: "EGP,USD" }).ALLOWED_CURRENCIES).toEqual(["EGP", "USD"]);
    });
    it("should default to EGP when the setting is absent", () => {
        expect(parseEnv(base).ALLOWED_CURRENCIES).toEqual(["EGP"]);
    });
    it.each(["egp", "EGPP", "", "EGP,EGP"])("should reject %p when a currency list is invalid", (value) => {
        expect(() => parseEnv({ ...base, ALLOWED_CURRENCIES: value })).toThrow(InvalidEnvError);
    });
});
