import type { Env } from "../config/types";
import type { Logger } from "../logger/logger";
import { LogEmailAdapter } from "./log-email.adapter";
import { ResendEmailAdapter } from "./resend-email.adapter";
import type { EmailPort } from "./types";

/**
 * Selects the adapter for `EMAIL_PROVIDER` (ADR 0030). `env.ts` already refuses `log` in production and requires the key and
 * sender for `resend`; the checks here are the last line of defence for a hand-built `Env`.
 */
export function createEmailPort(env: Pick<Env, "NODE_ENV" | "EMAIL_PROVIDER" | "EMAIL_PROVIDER_API_KEY" | "EMAIL_PROVIDER_FROM" | "EMAIL_PROVIDER_BASE_URL">, logger: Logger): EmailPort {
    switch (env.EMAIL_PROVIDER) {
        case "log":
            if (env.NODE_ENV === "production") throw new Error("email_provider_log_not_allowed_in_production");
            return new LogEmailAdapter(logger);
        case "resend":
            if (env.EMAIL_PROVIDER_API_KEY === undefined || env.EMAIL_PROVIDER_FROM === undefined) throw new Error("email_provider_resend_not_configured");
            return new ResendEmailAdapter({ apiKey: env.EMAIL_PROVIDER_API_KEY, from: env.EMAIL_PROVIDER_FROM, baseUrl: env.EMAIL_PROVIDER_BASE_URL.replace(/\/+$/, "") }, logger);
    }
}
