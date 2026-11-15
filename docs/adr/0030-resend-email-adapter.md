---
title: "ADR 0030: notification email goes out through Resend behind the email port"
owner: care-team
service: care-service
status: accepted
date: 2026-11-13
diataxis: explanation
last_verified: 2026-11-13
tags: [adr, decision, notifications, email, resend, undici, security]
related: [notifications-spec, infrastructure, runbook, adr-0011-notification-outbox, hub-adr-0010-notification-contact-lookup]
---

# ADR 0030 — notification email goes out through Resend behind the email port

- **Status:** Accepted • **Date:** 2026-11-13 • **Deciders:** owner (provider), care-team (shape)

## Context
Notifications (booking confirmation, reminders, reschedule, cancellation, "doctor joined") were delivered through `EmailPort` with
a log-only adapter that sends nothing (owner decision 2026-10-12), "until a provider ADR". Identity already sends its
verification and reset codes through Resend (its ADR 0016), so the account is the same one the platform uses.

## Decision
- A `ResendEmailAdapter` in `src/lib/email` implements `EmailPort`: one `POST {EMAIL_PROVIDER_BASE_URL}/emails` per message with
  `undici` (already a dependency: **no new dependency**), plain text, 5 s budget, bearer API key, and
  `Idempotency-Key: care-outbox-<outboxId>` so a retry after a lost response cannot send twice (Resend keeps the key 24 h).
- `EMAIL_PROVIDER` is `log` (default, local only) or `resend`. `resend` requires `EMAIL_PROVIDER_API_KEY` (secret, no default) and
  `EMAIL_PROVIDER_FROM`; `EMAIL_PROVIDER_BASE_URL` defaults to `https://api.resend.com`. **In production `log` is refused at boot**
  (`env.ts`, and `createEmailPort` as a last line of defence) and the base URL must be `https`: a service that cannot send mail
  must not start looking healthy.
- Result mapping (a fixed vocabulary, never a provider message): `2xx` sent; network, timeout, `429`, `401`/`403`, `409`, `5xx`
  transient (the outbox backs off and goes `dead` after 8 attempts); any other `4xx` permanent (`email_rejected`). `401`/`403` are
  transient on purpose so a rotated key or a newly verified sender domain recovers pending rows without a redeploy.
- Privacy is unchanged and tested: the response body is never read, and the address, subject, text, API key and body are never
  logged. The adapter logs `email_provider_failed` with the outbox id, kind, error code and HTTP status only.
- `undici` stays restricted by lint; the allowlist gains exactly `src/lib/email/resend-email.adapter.ts`.

## Consequences
- ➕ Real mail from the same provider as Identity, with no SDK and no new package; a stable idempotency key per outbox row.
- ➕ Local development is unchanged (`log`), and a first real test needs only a Resend key and `onboarding@resend.dev` as sender
  (Resend delivers that sender only to the account owner's own address).
- ➖ A real sender domain needs SPF/DKIM verified in Resend before production; bounce and complaint handling (webhooks) is not built.
- ➖ The provider is not selectable per message kind; one provider for all notifications.

## Alternatives considered
- **SES or SMTP** — fine, but a second provider account and credentials; rejected because Identity already uses Resend.
- **The Resend SDK** — a new dependency for one HTTP call; rejected (the same call Identity makes with `fetch`).
- **Keep `log` allowed in production** — rejected: silent "sent" with nothing delivered is the failure mode we are removing.
