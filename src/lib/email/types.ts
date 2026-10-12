/** Identifiers of one send; never an address, subject or body. `kind` is a plain string because `lib/` does not import `app/`. */
export interface EmailSendMeta { outboxId: number; kind: string; recipientUserId: number }

/** Plain text only. */
export interface EmailMessage { to: string; subject: string; text: string; meta: EmailSendMeta }

/** `errorCode` is a fixed vocabulary string, never a provider message. */
export type EmailSendResult =
    | { outcome: "sent" }
    | { outcome: "transient"; errorCode: string }
    | { outcome: "permanent"; errorCode: string };

export interface EmailPort { send(message: EmailMessage, signal: AbortSignal): Promise<EmailSendResult> }
