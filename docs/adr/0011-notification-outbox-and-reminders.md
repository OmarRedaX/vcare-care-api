---
title: "ADR 0011: Notifications via a transactional outbox; reminders via a worker scan"
owner: care-team
service: care-service
status: accepted
date: 2026-09-15
diataxis: explanation
last_verified: 2026-09-15
tags: [adr, decision, notifications, outbox, email, reminders]
related: [resilience, data-model, integration, deployment, adr-0008-care-worker-component, hub-adr-0010-notification-contact-lookup]
---

# ADR 0011 — Notifications via a transactional outbox; reminders via a worker scan

- **Status:** Accepted • **Date:** 2026-09-15 • **Deciders:** care-team

## Context
PRD 7.11 requires booking confirmation, reminder, reschedule, cancellation, schedule-block, and "doctor joined"
emails. Delivery must never block or roll back the write. Care stores no email addresses (Identity owns them).
identity-service uses a transactional outbox (identity ADR 0007). MVP has no message bus.

## Decision
**Outbox.**
- `notification_outbox` (`id, kind, consultation_id, recipient_user_id, payload JSONB, status, attempts,
  next_attempt_at, last_error_code, request_id, created_at, sent_at`) — `status IN ('pending','sent','dead','skipped')`.
  `payload` holds ids and non-clinical render parameters only (never complaint text, never email addresses).
- The row is inserted **in the same transaction** as the business write (book, reschedule, cancel, schedule block
  with `confirmConflicts`, doctor join), so a notification exists iff the write committed.
- `care-worker` claims 20 due rows with `FOR UPDATE SKIP LOCKED`, resolves recipients in one batched
  `GET /internal/users/contacts?ids=` call (hub ADR 0010; email held in memory only, never logged or cached),
  renders the template in the recipient's locale and timezone, and sends via the email port (5 s timeout).
- Transient failure → `attempts++`, backoff `30 s · 2^attempt` capped at 30 min; **`dead` after 8 attempts**.
  Identity contact lookup failure is transient (delay only). Unknown/inactive recipient → `skipped`.
- Sent rows older than 30 days are purged in batches by the worker.

**Reminders.**
- `consultations.reminder_24h_sent_at` and `reminder_1h_sent_at` (`TIMESTAMPTZ NULL`). Every minute the worker
  selects `status='booked'` consultations whose `starts_at` is within 24 h (or 1 h) and whose column is null, inserts
  the outbox row and sets the column in one transaction (partial index on `starts_at WHERE status='booked'`).
- **Reschedule resets both columns** in its transaction; cancel needs no cleanup (the scan reads current state).
- Reminders for a consultation booked inside the window are skipped (the confirmation covers it).

## Consequences
- ➕ Exactly-once enqueue with the write; no new dependency; survives Redis loss and worker restarts.
- ➕ Reschedules and cancels cannot leave stale reminders.
- ➖ At-least-once delivery: a crash after send but before `sent` may duplicate an email (accepted).
- ➖ Adds a cross-service dependency on a new Identity endpoint (provider first) and one table to purge.

## Alternatives considered
- **Redis job queue (BullMQ)** — rejected: new dependency; enqueue after commit can be lost; Redis is Tier 2.
- **Fire-and-forget after commit** — rejected: provider blips silently drop emails.
- **Pre-scheduled future-dated reminder rows** — rejected: every reschedule/cancel must supersede them correctly.
- **Identity sends on Care's behalf** — rejected (hub ADR 0010): Identity would own Care's templates.
