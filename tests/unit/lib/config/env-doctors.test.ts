import { InvalidEnvError, parseEnv } from "../../../../src/lib/config/env";

const base = { DATABASE_URL: "postgres://care_app:synthetic@localhost:5432/care_test",
    REDIS_URL: "redis://localhost:6379", IDENTITY_JWKS_URL: "http://localhost:3100/.well-known/jwks.json",
    IDENTITY_INTERNAL_URL: "http://localhost:3100", SERVICE_CLIENT_ID: "synthetic-care", SERVICE_CLIENT_SECRET: "synthetic-secret",
    STORAGE_BUCKET: "care-test", STORAGE_REGION: "us-east-1", STORAGE_ENDPOINT: "http://localhost:9003", STORAGE_ACCESS_KEY_ID: "synthetic-access",
    STORAGE_SECRET_ACCESS_KEY: "synthetic-storage-secret",
    VIDEO_PROVIDER: "fake", VIDEO_PROVIDER_KEY: "synthetic-video-provider-key-0123456789abcdef" };

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

describe("BOOKING_HORIZON_DAYS and CANCELLATION_POLICY_MINUTES", () => {
    it("should default to 60 days and 120 minutes", () => {
        const env = parseEnv(base);
        expect(env.BOOKING_HORIZON_DAYS).toBe(60);
        expect(env.CANCELLATION_POLICY_MINUTES).toBe(120);
    });
    it("should accept explicit in-range values", () => {
        const env = parseEnv({ ...base, BOOKING_HORIZON_DAYS: "30", CANCELLATION_POLICY_MINUTES: "0" });
        expect(env.BOOKING_HORIZON_DAYS).toBe(30);
        expect(env.CANCELLATION_POLICY_MINUTES).toBe(0);
    });
    it.each([["BOOKING_HORIZON_DAYS", "0"], ["BOOKING_HORIZON_DAYS", "366"], ["BOOKING_HORIZON_DAYS", "1.5"], ["CANCELLATION_POLICY_MINUTES", "-1"], ["CANCELLATION_POLICY_MINUTES", "10081"], ["CANCELLATION_POLICY_MINUTES", "abc"]])(
        "should reject %s=%s", (key, value) => {
            expect(() => parseEnv({ ...base, [key]: value })).toThrow(InvalidEnvError);
        });
});
