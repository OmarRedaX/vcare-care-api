import { request } from "undici";
import type { Logger } from "../logger/logger";
import { EmailFailureCode, RESEND_REQUEST_TIMEOUT_MS } from "./constants";
import type { EmailMessage, EmailPort, EmailSendMeta, EmailSendResult, ResendEmailConfig } from "./types";

const TIMEOUT_CODES = new Set(["UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_CONNECT_TIMEOUT"]);

function isTimeout(error: unknown, timeoutSignal: AbortSignal): boolean {
    if (timeoutSignal.aborted) return true;
    const code = (error as { code?: unknown } | null)?.code;
    const name = (error as { name?: unknown } | null)?.name;
    return (typeof code === "string" && TIMEOUT_CODES.has(code)) || name === "TimeoutError";
}

/**
 * Sends plain-text mail through Resend: one `POST {baseUrl}/emails` with `undici` (ADR 0030; no SDK, no new dependency).
 * The response body is **never read** (a provider echo of the message could carry the address or text) and the address,
 * subject and text are never logged. `Idempotency-Key: care-outbox-<outboxId>` makes a retry after a lost response safe:
 * Resend keeps the key 24 h, so a message that already went out is not sent twice.
 *
 * `401`/`403` are transient on purpose: a rotated key or a newly verified sender domain lets pending rows recover without
 * a redeploy, while the `dead` rows and the `notification_dead` metric make a long outage visible.
 */
export class ResendEmailAdapter implements EmailPort {
    constructor(
        private readonly config: ResendEmailConfig,
        private readonly logger: Logger,
    ) {}

    async send(message: EmailMessage, signal: AbortSignal): Promise<EmailSendResult> {
        const timeoutSignal = AbortSignal.timeout(RESEND_REQUEST_TIMEOUT_MS);
        let response: Awaited<ReturnType<typeof request>>;
        try {
            response = await request(`${this.config.baseUrl}/emails`, {
                method: "POST",
                headers: {
                    authorization: `Bearer ${this.config.apiKey}`,
                    "content-type": "application/json",
                    "idempotency-key": `care-outbox-${message.meta.outboxId}`,
                },
                body: JSON.stringify({ from: this.config.from, to: [message.to], subject: message.subject, text: message.text }),
                headersTimeout: RESEND_REQUEST_TIMEOUT_MS,
                bodyTimeout: RESEND_REQUEST_TIMEOUT_MS,
                signal: AbortSignal.any([signal, timeoutSignal]),
            });
        } catch (error) {
            return this.failed(message.meta, "transient", isTimeout(error, timeoutSignal) ? EmailFailureCode.Timeout : EmailFailureCode.Network);
        }
        // Destroying an undici body emits 'error' (RequestAbortedError); without a listener that would be an uncaught exception.
        response.body.on("error", () => undefined);
        response.body.destroy();

        const status = response.statusCode;
        if (status >= 200 && status < 300) return { outcome: "sent" };
        if (status === 429) return this.failed(message.meta, "transient", EmailFailureCode.Throttled, status);
        if (status === 401 || status === 403) return this.failed(message.meta, "transient", EmailFailureCode.Auth, status);
        // 409 is Resend's "same idempotency key still in flight": the retry finds the first attempt settled.
        if (status >= 500 || status === 409) return this.failed(message.meta, "transient", EmailFailureCode.Unavailable, status);
        return this.failed(message.meta, "permanent", EmailFailureCode.Rejected, status);
    }

    private failed(meta: EmailSendMeta, outcome: "transient" | "permanent", errorCode: string, status?: number): EmailSendResult {
        this.logger.warn("email_provider_failed", { outboxId: meta.outboxId, kind: meta.kind, errorCode, ...(status === undefined ? {} : { status }) });
        return { outcome, errorCode };
    }
}
