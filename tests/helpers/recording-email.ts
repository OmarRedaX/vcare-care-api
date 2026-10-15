import type { EmailMessage, EmailPort, EmailSendResult } from "../../src/lib/email/types";

/** An `EmailPort` fake that records every message and answers from a script (default: sent). */
export class RecordingEmail implements EmailPort {
    readonly messages: EmailMessage[] = [];
    /** Answers consumed in order; once empty, `fallback` applies. */
    readonly script: EmailSendResult[] = [];
    fallback: EmailSendResult = { outcome: "sent" };

    send(message: EmailMessage): Promise<EmailSendResult> {
        this.messages.push(message);
        return Promise.resolve(this.script.shift() ?? this.fallback);
    }

    /** Outbox ids in send order. */
    ids(): number[] { return this.messages.map((message) => message.meta.outboxId); }
}
