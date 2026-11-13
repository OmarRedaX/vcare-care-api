/** One `POST /emails` gets this long in total (connect, headers and body); the worker's own signal can cut it shorter. */
export const RESEND_REQUEST_TIMEOUT_MS = 5000;

/**
 * Fixed vocabulary for `EmailSendResult.errorCode` (never a provider message). `email_timeout` is the one code the outbox
 * stores as its own error (`OutboxErrorCode.EmailTimeout`); every other transient code is stored as `email_error`.
 */
export const EmailFailureCode = {
    Timeout: "email_timeout",
    Network: "email_network_error",
    Throttled: "email_provider_throttled",
    Auth: "email_provider_auth",
    Unavailable: "email_provider_unavailable",
    Rejected: "email_rejected",
} as const;
