import { createEmailPort } from "../../../../src/lib/email/create-email-port";
import { LogEmailAdapter } from "../../../../src/lib/email/log-email.adapter";
import { ResendEmailAdapter } from "../../../../src/lib/email/resend-email.adapter";
import { fakeLogger } from "../../../helpers/fake-logger";

const base = { NODE_ENV: "development", EMAIL_PROVIDER: "log", EMAIL_PROVIDER_BASE_URL: "https://api.resend.com" } as const;

describe("createEmailPort", () => {
    it("should return the log adapter for log outside production", () => {
        expect(createEmailPort(base, fakeLogger().logger)).toBeInstanceOf(LogEmailAdapter);
    });

    it("should refuse the log adapter when NODE_ENV is production", () => {
        expect(() => createEmailPort({ ...base, NODE_ENV: "production" }, fakeLogger().logger)).toThrow("email_provider_log_not_allowed_in_production");
    });

    it("should return the Resend adapter for resend with a key and a sender", () => {
        expect(createEmailPort({ ...base, EMAIL_PROVIDER: "resend", EMAIL_PROVIDER_API_KEY: "synthetic-resend-key-0001", EMAIL_PROVIDER_FROM: "care@example.test" }, fakeLogger().logger)).toBeInstanceOf(ResendEmailAdapter);
    });

    it.each([[{ EMAIL_PROVIDER_FROM: "care@example.test" }], [{ EMAIL_PROVIDER_API_KEY: "synthetic-resend-key-0001" }], [{}]])("should refuse resend without a key or a sender (%j)", (extra) => {
        expect(() => createEmailPort({ ...base, EMAIL_PROVIDER: "resend", ...extra }, fakeLogger().logger)).toThrow("email_provider_resend_not_configured");
    });
});
