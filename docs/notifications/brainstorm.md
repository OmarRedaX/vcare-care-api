---
title: notifications — Brainstorm
owner: care-team
service: care-service
module: notifications
status: implemented
diataxis: explanation
last_verified: 2026-10-15
tags: [brainstorm, notifications, outbox, worker, email, reminders]
related: [system-design, adr-0011-notification-outbox-and-reminders, adr-0008-care-worker-component, consultations-spec, integration]
---

# notifications — Brainstorm

Branch `feature/notifications`, stacked on `feature/consultations` (PR for #38 still open). Decisions below were made
with the owner on 2026-10-12 (four questions); everything else is the default the ADRs already fix.

## Problem & purpose
`consultations` already inserts `notification_outbox` rows in the booking, reschedule, cancel and schedule-block
transactions, but nothing delivers them and nothing sends reminders (PRD 7.11). This unit adds the **delivery side**:
the `care-worker` outbox loop, the reminder scan, the email port, and the templates. It follows
[ADR 0011](../adr/0011-notification-outbox-and-reminders.md) as written; no new architecture decision is needed except
the email adapter choice below.

## Actors
- **care-worker** (background; no HTTP surface in this unit).
- **Patient and doctor** as recipients (never as callers).
- **Identity** as the contact source (`GET /internal/users/contacts`, Case 5).
- **On-call** (runbook, alerts for `dead` rows and delivery lag).

## In scope (this iteration)
- `lib/email`: an **email port** plus a **log-only adapter** that records that a send happened (kind, outbox id,
  recipient user id; never address, subject or body). A real provider (SES, SMTP) is a later `/system-design` + ADR
  and swaps in behind the port without touching the loop. *(Owner decision.)*
- `lib/identity-client`: `getContacts(ids)` for `GET /internal/users/contacts` (≤ 100 per call, `no-store`, result held
  in memory for one batch only, never cached, stored or logged). The contacts call uses its **own** service token
  with scope `users:contact:read` only (`CONTACT_SERVICE_SCOPES`), separate from the status token, so a missing grant
  cannot break suspension or verification. *Groundwork done 2026-10-12: `ServiceTokenCache` takes a `scopes` option
  (default unchanged) and validates the granted scopes; the second cache and `getContacts` land with this unit.*
- `notifications` worker loop **`notification-outbox`**: claim 20 due `pending` rows with `FOR UPDATE SKIP LOCKED`,
  one batched contacts call, render, send (5 s timeout), then `sent` / backoff / `dead` / `skipped` per ADR 0011
  (`attempts++`, backoff `30 s · 2^attempt` capped at 30 min, `dead` after 8; unknown or non-active recipient →
  `skipped`; an Identity contacts failure is transient and only delays).
- **Reminder scan** loop **`consultation-reminders`**, every minute: for `status='booked'` consultations starting
  within 24 h (and 1 h) with the matching `reminder_*_sent_at` null, insert the outbox rows and set the column in one
  transaction. **Both patient and doctor** get both reminders. *(Owner decision.)* A consultation booked inside the
  window is skipped (the confirmation covers it).
- **Reschedule resets both reminder columns** in its transaction (ADR 0011). Already built in `consultations`
  (`rescheduleRow`, asserted in `tests/integration/consultations.test.ts`); this unit adds a reminder-specific test.
  Cancel needs no cleanup.
- **Purge**: `sent` rows older than 30 days deleted in batches by the worker.
- **Templates**: a locale-keyed table with **`en` filled in** and fallback to `en` for any other locale (`locale` comes
  from Identity). Kinds: `booking_confirmed`, `reminder_24h`, `reminder_1h`, `rescheduled`, `cancelled`,
  `schedule_blocked`, `doctor_joined` (template ready; the producer ships with `sessions`), and the new
  `doctor_suspended`. *(Owner decisions.)* Times render in the **recipient's timezone** (patient: the consultation's
  `patient_timezone` snapshot; doctor: `doctor_profiles.timezone`), ISO-safe and DST-correct via `luxon`.
- **`doctor_suspended` patient notification** *(owner decision)*: a CHECK-constraint migration adds the kind, the
  `SuspensionImpactProvider` enqueues one row per affected consultation's patient in the suspension transaction (the
  flag-once rule from the consultations review applies: no duplicate on re-flag), and an English template. Wording
  must not reveal the suspension reason.
- Worker-side grants: `notification_outbox` gains column-level `UPDATE` on the state columns and `DELETE` (purge);
  `consultations` already has `UPDATE`.
- Logging: `notification_sent`, `notification_failed`, `notification_dead`, `notification_skipped`, and a
  `notification_outbox_lag_seconds` figure on every tick (log-derived metrics, ADR 0007). Alerts documented in the
  runbook: any `dead` row; oldest pending row older than 15 minutes.

## Out of scope
- A real email provider adapter and its credentials (later ADR).
- The `doctor_joined` producer (ships with `sessions`), any other new notification kinds.
- Admin UI/endpoints to inspect or requeue `dead` rows (runbook SQL only for now).
- SMS/WhatsApp/push, notification preferences or unsubscribe, HTML-heavy templates (plain text first).
- RabbitMQ or any bus.
- Cache invalidation and the discovery listener (separate unit).

## Key entities & relationships
- `notification_outbox` (exists): `id, kind, consultation_id, recipient_user_id, payload, status, attempts,
  next_attempt_at, last_error_code, request_id, created_at, sent_at`. No email address is ever stored.
- `consultations.reminder_24h_sent_at` / `reminder_1h_sent_at` (exist).
- New code: `EmailPort`/`LogEmailAdapter`, `OutboxDeliveryService`, `ReminderScanService`, template registry,
  `getContacts` on the identity client.

## Primary flows / endpoints (with roles + ownership)
No public or internal HTTP endpoints. Two worker loops (also runnable once via `node dist/worker.js --once <loop>`):
1. `notification-outbox`: claim → contacts → render → send → mark.
2. `consultation-reminders`: scan → enqueue + stamp (one transaction).
`GET /internal/health/*` is unchanged. No `authorize(...)` surface; the loops run as `care_app` on the worker pool.

## Business rules & state transitions
- Outbox status: `pending → sent | dead | skipped`; a retry keeps `pending` with a later `next_attempt_at`.
- At-least-once delivery: a crash after send but before `sent` may duplicate an email (accepted in ADR 0011).
- Reminders are derived from current state each minute, so cancel and reschedule cannot leave stale reminders; a
  reminder that is already `pending` for a consultation that is then cancelled or rescheduled must be dropped at
  claim time (status/start re-check) instead of being sent.
- A notification exists iff its write committed (same-transaction insert), including `doctor_suspended`.

## Cross-service touchpoints (case, direction, failure policy)
- **Case 5, Care → Identity** `GET /internal/users/contacts`, batched, scope `users:contact:read`, worker only.
  Policy: transient (delay + backoff), never fails a booking; unknown/inactive → `skipped`. Contact data in memory
  for one batch, never cached or logged (hub ADR 0010).
- Dependency check: the contract exists in the hub's synced Identity contract; confirm Identity's **implementation**
  and that the care client holds the scope before the manual QA (open question).

## Privacy & audit
- Emails, names and message bodies are never logged, stored, cached or placed in `last_error_code`.
- Payload keys stay on the existing allowlist (`startsAt`, `endsAt`, `previousStartsAt`, `byRole`, `recipientRole`);
  `doctor_suspended` carries none of the reason text.
- Delivery is not a clinical access; no `audit_logs` rows per send. The state-change audit already exists on the
  write that created the row. A `dead` row is surfaced by log + alert.

## Constraints & guideline notes
- Background work only in `care-worker` (ADR 0008); loops registered in `src/worker-loops.ts`.
- No new runtime dependency (the log adapter needs none). `luxon` is already allowed.
- Generic helpers (backoff, bounded wait) go to `lib/` / `pkg/utils`: reuse `lib/async/settle-within.ts` and the
  identity-sync backoff pattern; do not copy them into the service.
- Raw-SQL migration with a real `down`, explicit grants, commented indexes (claim index
  `(next_attempt_at, id) WHERE status='pending'`, purge index on `sent_at WHERE status='sent'`, reminder scan index on
  `starts_at WHERE status='booked'`), each tied to a query in code.
- Reminder scan must use a fixed number of queries per tick and respect a batch limit; claim batches stay at 20.

## Contract changes expected
None to `contracts/openapi.yaml` (no HTTP surface). Documentation of the outbox kinds in the data model and the new
env vars (poll seconds, batch size, retention days) in `infrastructure.md`. Hub: a capacity roll-up note for outbox
volume is a `/system-design` follow-up, not part of this brief.

## Open questions
Resolved 2026-10-12 with the recommended defaults (owner: "do what you recommend").
1. **Identity contacts availability** — resolved: Identity implements `GET /internal/users/contacts`, the
   `internalContactsPolicy` and the `users:contact:read` scope (identity ADR 0024; checked in `../vcare-identity-api`).
   Whether the deployed `care-service` client is provisioned with the scope is an environment check for manual QA,
   which uses the fake Identity.
2. **Reminder timing** — resolved: the first scan where `starts_at - now <= 24 h` (or `<= 1 h`) sends the reminder,
   never after `starts_at`. A consultation booked inside the window is skipped.
3. **`doctor_suspended` wording** — resolved: a neutral notice that the appointment needs follow-up and an admin will
   be in touch; no reason, no rebooking link.
4. **Platform deltas for `/system-design` afterwards** (not part of this unit): outbox volume in hub `capacity.md`;
   the real email provider ADR.

## Success criteria
- A booked, rescheduled or cancelled consultation produces exactly one email per recipient in the log-adapter record,
  never blocks the write, and survives a worker restart without loss.
- With Identity contacts down, rows stay `pending` and recover; bookings are unaffected. After 8 failed attempts a row
  is `dead` and alerts.
- Reschedule resets reminders; a cancelled consultation sends no reminder; each reminder is sent once per recipient.
- A suspension enqueues one `doctor_suspended` per affected patient, once, in the suspension transaction.
- No address, name or body appears in logs; the claim query uses the index (EXPLAIN); concurrent workers never double-claim.
