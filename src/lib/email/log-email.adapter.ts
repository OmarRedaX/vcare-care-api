import type { Logger } from "../logger/logger";
import type { EmailMessage, EmailPort, EmailSendResult } from "./types";

/** Log-only adapter (owner decision 2026-10-12): records that a send happened and sends nothing. Never reads `to`, `subject` or `text`. */
export class LogEmailAdapter implements EmailPort {
    constructor(private readonly logger: Logger) {}

    send(message: EmailMessage): Promise<EmailSendResult> {
        const { outboxId, kind, recipientUserId } = message.meta;
        this.logger.info("email_log_adapter_send", { outboxId, kind, recipientUserId });
        return Promise.resolve({ outcome: "sent" });
    }
}
