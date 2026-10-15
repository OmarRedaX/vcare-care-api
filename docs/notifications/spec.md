---
title: notifications — Spec
owner: care-team
service: care-service
module: notifications
status: implemented
version: 0.2.0
diataxis: reference
last_verified: 2026-10-14
tags: [spec, notifications, outbox, worker, reminders, email-port, templates, identity-contacts, case-5]
related: [notifications-brainstorm, notifications-tasks, notifications-manual-qa, consultations-spec, admin-doctors-spec, adr-0007-log-derived-metrics, adr-0008-care-worker-component, adr-0011-notification-outbox-and-reminders, adr-0017-generic-helpers-and-transaction-scoping, adr-0018-db-role-split-explicit-grants-partition-function, data-model, resilience, infrastructure, integration, deployment, hub-adr-0010-notification-contact-lookup]
contracts: [contracts/openapi.yaml]
---

# notifications — Spec

The **delivery side** of the transactional outbox (ADR 0011): the `care-worker` outbox loop, the 1-minute reminder scan, the
outbox purge, the `lib/email` port with a log-only adapter, the English template registry, `getContacts` on the identity client
(Integration Case 5), and the new `doctor_suspended` patient notice. **No HTTP surface.** Scope follows
[brainstorm.md](./brainstorm.md) (all questions resolved 2026-10-12, binding). The insert side already exists
([consultations spec](../consultations/spec.md) §2.2, `NotificationsService.enqueue`).

Binding rules: CLAUDE.md → "Cross-service integration" (Notifications paragraph, Background work), "Database rules" (migrations, two roles, transactions), "Privacy and logging", "Security rules", "Folder structure and layering" (generic helpers), "Testing policy", "Performance rules". Platform: hub `landscape.md` Case 5, hub ADR 0010.

---

## 1. Overview

### 1.1 What this unit delivers
| Area | Delivers |
|---|---|
| Migrations | `20261012120000_notification_outbox_delivery` (kind CHECK widened, shape CHECKs, claim + purge indexes, column-level `UPDATE` + `DELETE` grants) · `20261012120100_consultations_reminder_index` |
| Worker loops (`src/worker-loops.ts`) | `notification-outbox` (poll `OUTBOX_POLL_SECONDS`, 5) · `consultation-reminders` (`REMINDER_SCAN_SECONDS`, 60) · `notification-outbox-purge` (`OUTBOX_PURGE_SECONDS`, 3600). Each runs with `node dist/worker.js --once <loop>` |
| `lib/email` | `EmailPort`, `LogEmailAdapter`, `types.ts` |
| `lib/identity-client` | `getContacts(ids, requestId)`, a second `ServiceTokenCache` with `CONTACT_SERVICE_SCOPES`, contact DTOs |
| `lib/async/backoff.ts` | `exponentialBackoffMs` extracted (generic home, ADR 0017); `backoffMs` delegates |
| `app/notifications` | `OutboxDeliveryService`, `ReminderScanService`, `OutboxPurgeService`, template registry, repository functions, enums/constants/types additions |
| `app/consultations` | `ConsultationReminderService` (the port implementation over reminder columns), `doctor_suspended` producer in `ConsultationSuspensionImpactProvider`, flag-once repo change |
| Env | six non-secret variables (section 3.9) |
| Contract | **none** (section 3.11) |

### 1.2 Principles
- Delivery never blocks, delays, or rolls back a booking, reschedule, cancel, schedule block, or suspension (ADR 0011). A notification exists iff its write committed.
- **No Identity or email I/O inside a database transaction** (CLAUDE.md → Transactions). The claim is a single autocommit statement that leases rows; sends and the contacts call run with no connection held.
- **At-least-once** delivery: a crash after the send but before the row is marked may duplicate one email (accepted, ADR 0011).
- Contact data (address, name, locale) lives in worker memory for one batch only: never cached (no Redis), stored, logged, or placed in `last_error_code`.
- Reminders are derived from current state every minute; a reminder already queued for a consultation that is cancelled or rescheduled is dropped at claim time.
- No new runtime dependency (`luxon` is already allowed; the log adapter needs none).

### 1.3 Dependencies
- **Modules (services only):** `consultations` (`ConsultationReminderService`: delivery contexts, reminder candidates, stamps), `notifications` (`NotificationsService.enqueue`, reused by the scan and the suspension producer).
- **Other service:** identity-service `GET /internal/users/contacts` (Case 5), scope `users:contact:read`, **worker only**. Provider contract: `../vcare-hub/contracts/identity-service.openapi.yaml` (`getUserContacts`). Identity implements it (identity ADR 0024); whether the deployed `care-service` client holds the scope is an environment check for manual QA (the fake Identity is used there).
- **External:** an email provider behind `EmailPort`; this unit ships only the log-only adapter (owner decision).

### 1.4 Owner decisions folded in (brainstorm, 2026-10-12)
1. Email adapter: **log-only**; a real provider is a later `/system-design` + ADR and swaps in behind the port.
2. Locale: **`en` only**, locale-keyed registry, fallback `en`.
3. Reminders go to **both** patient and doctor, both reminders.
4. `doctor_suspended` **is included** (CHECK migration, producer, template).
5. Reminder timing: first scan where `starts_at - now <= 24 h` (or `<= 1 h`), never after `starts_at`; a consultation booked inside the window is skipped.
6. `doctor_suspended` wording: neutral, no reason, no rebooking link.

### 1.5 Design decisions made in this spec
| ID | Decision | Why |
|---|---|---|
| N-D1 | A failed **contacts lookup does not consume an attempt** (`attempts` reverts, backoff driven by a per-loop in-memory consecutive-failure count, same schedule). `dead` is reached only by send failures, crash loops (lease expiries), or a permanent provider rejection. | ADR 0011 calls the lookup failure "delay only"; consuming attempts would turn an Identity outage of a few hours into `dead` rows. A permanent misconfiguration is surfaced by the lag alert and `identity_call_failed{case=contacts}`. |
| N-D2 | **Lease-based claim.** One autocommit statement selects due rows `FOR UPDATE SKIP LOCKED`, sets `attempts = attempts + 1` and `next_attempt_at = now + 300 s`, and returns them. The row stays `pending`; the lease is its future `next_attempt_at`. Results are written with a guard `status='pending' AND attempts = <claimed attempts>`. | SKIP LOCKED only protects within a transaction; a lease lets the I/O happen with no transaction open, survives a crash (the lease expires and the row is due again), and the guard stops a slow worker overwriting a re-claimed row. |
| N-D3 | Each send outcome is persisted **immediately** (single-row guarded `UPDATE`), not at the end of the batch. | Shrinks the duplicate window after a crash to the one in-flight email. |
| N-D4 | `OUTBOX_PAYLOAD_KEYS` is **unchanged** (`startsAt`, `endsAt`, `previousStartsAt`, `byRole`, `recipientRole`). `doctor_suspended` and the reminders use only these. | No reason text, no new key to review. |
| N-D5 | Recipient role for rendering is derived from the database (`recipient_user_id` vs the consultation's `patient_user_id` / `doctor_user_id`), never from `payload.recipientRole`. | The payload is a hint written by another module. |
| N-D6 | A reminder whose consultation is within 1 h is sent as the 1 h reminder only; an unstamped 24 h reminder is stamped without a message (superseded). | A "within 24 hours" mail 30 minutes before start is noise. |
| N-D7 | A **permanent** provider answer (`outcome: "permanent"`) marks the row `dead` immediately. | Retrying cannot fix it. The log adapter never returns it. |
| N-D8 | `care-worker` pool max rises from 4 to 6. | Three new loops each hold at most one connection at a time, and the existing session-advisory-lock purge pins one. |
| N-D9 | The reminder 24 h message re-arms after a reschedule (ADR 0011) and can fire at the next scan when the new start is within 24 h, even though the `rescheduled` mail just went out. Accepted: the 1 h reminder is the valuable one. | "Booked inside the window" is judged by `created_at` only (no reschedule timestamp exists). |

---

## 2. Database schema

### 2.1 `20261012120000_notification_outbox_delivery` (owner role; raw SQL; real `down`)
```sql
-- up
ALTER TABLE notification_outbox DROP CONSTRAINT chk_notification_outbox_kind;
ALTER TABLE notification_outbox ADD CONSTRAINT chk_notification_outbox_kind CHECK (kind IN
  ('booking_confirmed','reminder_24h','reminder_1h','rescheduled','cancelled','schedule_blocked','doctor_joined','doctor_suspended'));
ALTER TABLE notification_outbox ADD CONSTRAINT chk_notification_outbox_sent_shape CHECK ((status = 'sent') = (sent_at IS NOT NULL));
ALTER TABLE notification_outbox ADD CONSTRAINT chk_notification_outbox_attempts CHECK (attempts >= 0);

-- Claim and lag: WHERE status = 'pending' AND next_attempt_at <= $now ORDER BY next_attempt_at, id LIMIT $n FOR UPDATE SKIP LOCKED;
--   lag: SELECT MIN(next_attempt_at) FROM notification_outbox WHERE status = 'pending' AND next_attempt_at <= $now
CREATE INDEX idx_notification_outbox_pending_next_attempt_at_id ON notification_outbox (next_attempt_at, id) WHERE status = 'pending';
-- Purge: DELETE ... WHERE id IN (SELECT id FROM notification_outbox WHERE status = 'sent' AND sent_at < $cutoff
--   ORDER BY sent_at LIMIT 5000 FOR UPDATE SKIP LOCKED)
CREATE INDEX idx_notification_outbox_sent_at ON notification_outbox (sent_at) WHERE status = 'sent';

-- Delivery writes only the state columns (column-level UPDATE: payload, kind, recipient, consultation, request_id stay immutable).
GRANT UPDATE (status, attempts, next_attempt_at, last_error_code, sent_at) ON notification_outbox TO vcare_app;
GRANT DELETE ON notification_outbox TO vcare_app;   -- purge of sent rows only (the code never deletes another status)
COMMENT ON TABLE notification_outbox IS 'Transactional outbox for emails (ADR 0011). Inserted with the business write; delivered, retried and purged by care-worker.';
```
```sql
-- down (order matters)
REVOKE DELETE ON notification_outbox FROM vcare_app;
REVOKE UPDATE (status, attempts, next_attempt_at, last_error_code, sent_at) ON notification_outbox FROM vcare_app;
DROP INDEX IF EXISTS idx_notification_outbox_sent_at;
DROP INDEX IF EXISTS idx_notification_outbox_pending_next_attempt_at_id;
ALTER TABLE notification_outbox DROP CONSTRAINT IF EXISTS chk_notification_outbox_attempts;
ALTER TABLE notification_outbox DROP CONSTRAINT IF EXISTS chk_notification_outbox_sent_shape;
DELETE FROM notification_outbox WHERE kind = 'doctor_suspended';   -- operational rows; required before the narrower CHECK can return
ALTER TABLE notification_outbox DROP CONSTRAINT chk_notification_outbox_kind;
ALTER TABLE notification_outbox ADD CONSTRAINT chk_notification_outbox_kind CHECK (kind IN
  ('booking_confirmed','reminder_24h','reminder_1h','rescheduled','cancelled','schedule_blocked','doctor_joined'));
```
`down` is run by the owner role (which retains `DELETE`). Existing rows are all `pending` with `sent_at NULL`, so the new CHECKs validate. `idx_notification_outbox_consultation_id` (FK index) stays as is. This replaces the planned name `idx_notification_outbox_pending_next_attempt_at ON (next_attempt_at)` in `data-model.md` (refresh at `/update-docs`).

### 2.2 `20261012120100_consultations_reminder_index`
```sql
-- Reminder scan (care-worker, every minute): WHERE status = 'booked' AND deleted_at IS NULL AND starts_at > $now AND starts_at <= $now + interval
--   AND reminder_24h_sent_at IS NULL (or reminder_1h_sent_at IS NULL) ORDER BY starts_at, id LIMIT 200 FOR UPDATE OF c SKIP LOCKED
CREATE INDEX idx_consultations_booked_starts_at ON consultations (starts_at) WHERE status = 'booked' AND deleted_at IS NULL;
```
`down`: `DROP INDEX IF EXISTS idx_consultations_booked_starts_at;`. `consultations` already grants table-level `UPDATE` to `vcare_app`; no grant change. The 24 h query reads the index range of the next 24 h and filters the stamp column on the heap; the 1 h query range is tiny. Revisit with per-column partial indexes only if the `EXPLAIN` test (section 9) shows the heap filter above budget.

### 2.3 Migration tests (`tests/integration/migrations.test.ts`)
Round-trip both migrations (`down` then `up`); named constraints and both indexes exist; `doctor_suspended` insert accepted, an unknown kind rejected (`23514`); `status='sent'` with `sent_at NULL` rejected; as `care_app`: `UPDATE (status, attempts, next_attempt_at, last_error_code, sent_at)` allowed, `UPDATE payload` / `UPDATE kind` denied (`42501`), `DELETE` allowed, `INSERT` still allowed.

---

## 3. Design and file-level contract (no HTTP endpoints)

### 3.1 File list
```
src/lib/email/            types.ts (EmailPort, EmailMessage, EmailSendMeta, EmailSendResult)  log-email.adapter.ts
src/lib/identity-client/  identity-client.ts (+getContacts, authorizedRequest takes a token cache)  identity.dto.ts (+UserContactDto, ContactsEnvelopeDto)  types.ts (+Contact, ContactsResult)
src/lib/async/backoff.ts  (+exponentialBackoffMs; backoffMs delegates)
src/app/notifications/
  enums.ts           OutboxKind (+DoctorSuspended), OutboxStatus, OutboxErrorCode
  constants.ts       OUTBOX_PAYLOAD_KEYS (unchanged) + loop names, lease, timeouts, batch limits
  types.ts           OutboxClaimedRow, DeliveryOutcome, RenderInput, RenderedEmail, ConsultationDeliveryPort, NotificationTiming, ...
  repository/notification-outbox.repo.ts   (+claimDue, oldestDueAgeSeconds, finishRow, finishRows, deleteSentOlderThan)
  service/outbox-delivery.service.ts   service/reminder-scan.service.ts   service/outbox-purge.service.ts
  templates/registry.ts  templates/en.ts  templates/format-time.ts
  worker/notification-outbox.loop.ts  worker/consultation-reminders.loop.ts  worker/notification-outbox-purge.loop.ts
src/app/consultations/    service/consultation-reminder.service.ts (+3 repo functions)  service/suspension-impact.provider.ts (producer)
src/migrations/           20261012120000_notification_outbox_delivery.ts  20261012120100_consultations_reminder_index.ts
```
Types follow "Module file conventions": no inline `interface`/`type` outside `types.ts`. Services are `@injectable()` classes composed manually in `buildWorkerLoops` (the worker has no container; same as `IdentitySyncService`). The API never builds them. `NotificationsService.enqueue` stays the API-side writer and is reused by the worker's scan.

### 3.2 Email port (`lib/email/types.ts`, `log-email.adapter.ts`)
```ts
export interface EmailSendMeta { outboxId: number; kind: string; recipientUserId: number }   // no address, subject or body
export interface EmailMessage { to: string; subject: string; text: string; meta: EmailSendMeta }   // plain text only
export type EmailSendResult =
  | { outcome: "sent" }
  | { outcome: "transient"; errorCode: string }
  | { outcome: "permanent"; errorCode: string };
export interface EmailPort { send(message: EmailMessage, signal: AbortSignal): Promise<EmailSendResult> }
```
`LogEmailAdapter(logger)`: writes **one** `info` line `email_log_adapter_send` with `{ outboxId, kind, recipientUserId }` and returns `{ outcome: "sent" }`. It never reads `to`, `subject`, or `text` into a log field. `lib/` must not import `app/`, so `kind` is a plain string here. A real adapter later implements the same port and may return `transient`/`permanent`; `errorCode` is a fixed vocabulary string, never a provider message.

### 3.3 Identity client `getContacts` (Case 5)
- `IdentityClient` gets a **second** `ServiceTokenCache({ pool, env, now, scopes: CONTACT_SERVICE_SCOPES })` (`contactTokens`), constructed with the client but fetching nothing until `getContacts` runs, so `care-api` never requests the scope. `authorizedRequest(method, path, requestId, body?, tokens = this.tokens)` is parameterised by the cache; the 401 path invalidates and refreshes **that** cache once.
- `getContacts(ids: readonly number[], requestId: string): Promise<ContactsResult>` with `ContactsResult = { contacts: Map<number, Contact>; unavailable: Set<number> }` and `Contact = { email: string; fullName: string; locale: string; status: IdentityStatus }`.
- Ids are de-duplicated, filtered to positive safe integers, and split into chunks of **≤ 100** (`GET /internal/users/contacts?ids=1,2,3`). One attempt per chunk (landscape: 1 per batch), timeouts 2 s (headers, body, `AbortSignal.timeout`), `X-Request-Id` forwarded.
- Response validated through `ContactsEnvelopeDto` (`success === true`, `data` array ≤ 100 of `UserContactDto`: `id` positive int, `email` `@IsEmail()`, `fullName` non-empty string, `locale` non-empty string, `status` one of the four). `unknownMembers: "strip"` for envelopes as elsewhere. Any entry failing validation, an id not in the requested chunk, or a duplicate id makes the **whole chunk** malformed.
- **Classification.**
  - `200` valid: ids absent from `data` are *unknown* (caller marks `skipped`); present ids go in `contacts` (status checked by the caller).
  - Everything else puts the chunk's ids in `unavailable` (transient, rows are delayed): network error, timeout, `5xx`, `429`, `401` after the one refresh, `403 InsufficientScope`, a token-endpoint failure (including a token without the scope: `ServiceTokenCache` throws `MalformedResponse`), `400`, malformed `200`. `400`/`403` are treated as transient on purpose: the fix is operational, the rows are safe, and the lag alert plus the metric below surface it.
- A failed chunk emits `logger.warn("notification_contacts_unavailable", { errorCode, ids: <count> })` and `logger.metric("identity_call_failed", 1, { case: "contacts" })`. Neither body, address, nor name is ever passed to the logger.
- **No cache, no storage:** no Redis call, no module-level or instance-level memo; the `Map` is returned to the caller and dropped with the batch. Responses are `Cache-Control: no-store` (provider contract); the client does not rely on it.

### 3.4 `OutboxDeliveryService` (`worker`, loop `notification-outbox`)
Dependencies: `Knex` (worker pool), `IdentityClient`, `EmailPort`, `ConsultationDeliveryPort`, `Env`, `Logger`, `NotificationTiming { now(): number; random(): number }` (production `SYSTEM_NOTIFICATION_TIMING`, tests a fake), plus a per-loop `contactFailures` counter.

**Tick** (`tick(signal)`): emit `notification_outbox_lag_seconds`; then up to `OUTBOX_MAX_ROUNDS` (10) rounds of claim -> process; stop on an empty or short batch or when `signal.aborted` (the current batch finishes). Returns `"done"`; it throws only on database failure (the runner logs `worker_tick_failed`).

1. **Lag.** `SELECT MIN(next_attempt_at) FROM notification_outbox WHERE status='pending' AND next_attempt_at <= $now` -> `metric("notification_outbox_lag_seconds", seconds, {})` (0 when none). Leased rows have a future `next_attempt_at` and do not count; an expired lease does.
2. **Claim** (one autocommit statement, no explicit transaction):
```sql
WITH due AS (
  SELECT id FROM notification_outbox
  WHERE status = 'pending' AND next_attempt_at <= $1
  ORDER BY next_attempt_at, id
  LIMIT $2
  FOR UPDATE SKIP LOCKED)
UPDATE notification_outbox o
SET attempts = o.attempts + 1, next_attempt_at = $1::timestamptz + make_interval(secs => $3)
FROM due WHERE o.id = due.id
RETURNING o.id, o.kind, o.consultation_id, o.recipient_user_id, o.payload, o.attempts, o.request_id
```
`$1` = injected now, `$2` = `OUTBOX_BATCH_SIZE`, `$3` = lease 300 s (constant `OUTBOX_LEASE_SECONDS`; exceeds the worst case of one contacts call plus 20 sequential 5 s sends). Rows are sorted by id in memory. `attempts` after the update is the **claim number** `n` and the lease token.
3. **Crash-loop guard.** A claimed row with `n > OUTBOX_MAX_ATTEMPTS` (only reachable through repeated lease expiries) is finished `dead` / `lease_expired` without sending.
4. **Re-check consultation state** (one query via the port, `id = ANY($1)`, plus a `LEFT JOIN doctor_profiles` for the doctor timezone; includes soft-deleted rows): see `DeliveryContext = { status, startsAt, endsAt, patientUserId, doctorUserId, patientTimezone, doctorTimezone | null, deleted }`. Pre-send `skipped` outcomes, written in **one batched guarded statement**:
   - consultation missing -> `consultation_missing`;
   - `reminder_24h` / `reminder_1h` and (`status <> 'booked'` or deleted) -> `consultation_changed`;
   - reminder and `payload.startsAt` (epoch ms) `<> consultation.startsAt` (rescheduled since enqueue) -> `consultation_changed`;
   - reminder and `now >= startsAt` -> `reminder_expired`;
   - recipient is neither the consultation's patient nor its doctor -> `consultation_changed`;
   - no template for (kind, role) -> `template_missing`.
   Event notifications (`booking_confirmed`, `rescheduled`, `cancelled`, `schedule_blocked`, `doctor_suspended`, `doctor_joined`) describe something that happened and are sent even if the consultation has since moved on.
5. **Contacts**: one `getContacts(distinct recipient ids of the remaining rows, newRequestId)`. Rows whose id is in `unavailable` get the **delay outcome** (N-D1): `attempts` reverts by 1 (`attempts_delta = -1`), `next_attempt_at = now + exponentialBackoffMs(30 s base, contactFailures, cap 30 min, random)`, `last_error_code = 'contacts_unavailable'`, and `contactFailures` increments once per failed batch (reset to 0 on any fully successful lookup). Rows whose id is absent -> `skipped` / `recipient_unknown`; contact `status <> 'active'` -> `skipped` / `recipient_inactive` (batched with the other skips).
6. **Render** (pure, section 3.6) and **send**, sequentially per row:
   ```ts
   const result = await settleWithin(safeSend(port, message, signal), EMAIL_SEND_TIMEOUT_MS /*5000*/, TIMEOUT_RESULT)
   ```
   `safeSend` catches a throw and returns `{ outcome: "transient", errorCode: "email_error" }`; the timeout fallback is `{ outcome: "transient", errorCode: "email_timeout" }`; `signal` is `AbortSignal.any([loopSignal, AbortSignal.timeout(5000)])` so a real adapter can cancel. The error message of a thrown error is never stored or logged.
7. **Persist each outcome immediately** (single-row guarded `UPDATE`, PK lookup; N-D3):
   - `sent` -> `status='sent', sent_at=now, last_error_code=NULL`;
   - `transient` and `n < OUTBOX_MAX_ATTEMPTS` -> stays `pending`, `next_attempt_at = now + exponentialBackoffMs(30 000, n - 1, 1 800 000, random)`, `last_error_code = errorCode` (delays 30 s, 60 s, 120 s, 240 s, 480 s, 960 s, 1 800 s ±20 %);
   - `transient` and `n >= OUTBOX_MAX_ATTEMPTS` -> `dead`; `permanent` -> `dead` (N-D7).
   Guard for every write: `WHERE id = $id AND status = 'pending' AND attempts = $n`. Zero rows updated means the lease was lost: log `notification_lease_lost`, change nothing.
8. **Crash after send, before step 7:** the lease expires (<= 300 s), the row is claimed again with `attempts + 1`, and the email is sent again (at-least-once). A worker that comes back late fails its guard and writes nothing.

The `UPDATE` is built once in the repository (`finishRows`, arrays via `unnest`; `finishRow` calls it with one element):
```sql
UPDATE notification_outbox o
SET status = f.status, attempts = o.attempts + f.attempts_delta,
    next_attempt_at = COALESCE(f.next_attempt_at, o.next_attempt_at), last_error_code = f.last_error_code, sent_at = f.sent_at
FROM unnest($1::bigint[], $2::int[], $3::text[], $4::int[], $5::timestamptz[], $6::text[], $7::timestamptz[])
     AS f(id, expected_attempts, status, attempts_delta, next_attempt_at, last_error_code, sent_at)
WHERE o.id = f.id AND o.status = 'pending' AND o.attempts = f.expected_attempts
RETURNING o.id
```
`last_error_code` values come from `OutboxErrorCode` (all <= 32 chars): `contacts_unavailable`, `email_timeout`, `email_error`, `email_rejected`, `recipient_unknown`, `recipient_inactive`, `consultation_missing`, `consultation_changed`, `reminder_expired`, `template_missing`, `lease_expired`. A provider-specific `errorCode` from a real adapter is mapped into this set (unknown -> `email_error`/`email_rejected`).

### 3.5 `ReminderScanService` (loop `consultation-reminders`, every `REMINDER_SCAN_SECONDS`)
Per tick: up to `REMINDER_MAX_BATCHES` (5) iterations; each iteration is **one transaction** (handler form) with a fixed statement count, and continues only while a query returned a full `REMINDER_BATCH_LIMIT` (200) rows.

Inside the transaction (`now` = injected clock):
1. `due24` = `SELECT c.id, c.patient_user_id, c.doctor_user_id, c.starts_at, c.ends_at, c.created_at FROM consultations c WHERE c.status='booked' AND c.deleted_at IS NULL AND c.starts_at > $now AND c.starts_at <= $now + interval '24 hours' AND c.reminder_24h_sent_at IS NULL ORDER BY c.starts_at, c.id LIMIT 200 FOR UPDATE OF c SKIP LOCKED`.
2. `due1` = the same with `'1 hour'` and `reminder_1h_sent_at IS NULL`.
3. In memory, per consultation and per reminder kind decide **enqueue** or **stamp only**:
   - 1 h: stamp only when `created_at >= starts_at - 1 h` (booked inside the window: the confirmation covers it); else enqueue.
   - 24 h: stamp only when `created_at >= starts_at - 24 h` **or** `starts_at - now <= 1 h` (N-D6); else enqueue.
4. `NotificationsService.enqueue(trx, messages)`: for every enqueue decision **two** messages (patient, doctor), kind `reminder_24h` / `reminder_1h`, payload `{ startsAt, endsAt, recipientRole }` (ISO UTC). One multi-row `INSERT`. `request_id` is NULL (no request context).
5. `stampReminders(trx, ids24, ids1, now)`: `UPDATE consultations SET reminder_24h_sent_at = $now WHERE id = ANY($1) AND status='booked' AND deleted_at IS NULL AND reminder_24h_sent_at IS NULL`, and the same for the 1 h column. `updated_at` is **not** touched (a stamp is not a business change).

Statements per iteration: 2 selects + 1 insert + up to 2 updates (<= 5), independent of the number of rows. Because rows are locked `FOR UPDATE OF c SKIP LOCKED` and stamped in the transaction that enqueues, two workers or a concurrent reschedule/cancel cannot produce a duplicate or half-applied reminder; a locked row is simply picked up by the next scan. A reschedule resets both columns in its own transaction (already built); the stale messages it leaves are dropped at claim time (3.4 step 4). Cancel needs no cleanup. Metrics: `notification_reminders_enqueued` (consultation-kinds enqueued, dim `kind`).

The scan does not check recipients' Identity status; delivery does.

### 3.6 Template registry (`templates/`)
- `registry.ts`: `resolveLocale(tag: string): "en"` takes the primary language subtag lower-cased (`en-US` -> `en`); an unknown or malformed tag falls back to `en`. `render(input: RenderInput): RenderedEmail | undefined` looks up `TEMPLATES[locale][kind][role]`; a missing (kind, role) returns `undefined` (the caller marks `template_missing`). Adding a locale = adding one file and one registry entry.
- `RenderInput = { kind; role: "patient" | "doctor"; locale: string; recipientName: string; timezone: string; startsAtMs: number; previousStartsAtMs?: number; byRole?: "patient" | "doctor" | "admin" }` (names and types in `types.ts`). `RenderedEmail = { subject: string; text: string }`.
- `format-time.ts`: `formatLocal(ms, timezone)` = `DateTime.fromMillis(ms, { zone: timezone }).setLocale("en").toFormat("cccc d LLLL yyyy, HH:mm")` + ` (` + IANA id + `)`, e.g. `Tuesday 14 October 2026, 15:30 (Africa/Cairo)`. DST-correct by `luxon`. An invalid zone falls back to `UTC` (printed as `(UTC)`). Time zone per role: **patient** -> `consultations.patient_timezone` (snapshot); **doctor** -> `doctor_profiles.timezone` (`UTC` when the profile row is gone).
- Greeting name: `fullName` trimmed, control characters removed, clamped to 80 code points; used only in the body, never in a subject, never logged.
- **No reason text, no counterpart name, no clinical content** in any template. Plain text, signed `The Vcare team`. All copy below is synthetic (`{when}` = `formatLocal(startsAt)`):

| Kind | Role | Subject | Body (after `Hello {name},` + blank line) |
|---|---|---|---|
| `booking_confirmed` | patient | Your consultation is booked | Your consultation is booked for {when}. You can review it in your Vcare account. |
| `booking_confirmed` | doctor | New consultation booked | A patient has booked a consultation with you for {when}. Open your Vcare schedule to see the details. |
| `reminder_24h` | patient | Reminder: your consultation is within 24 hours | Your consultation starts on {when}. |
| `reminder_24h` | doctor | Reminder: a consultation is within 24 hours | You have a consultation starting on {when}. |
| `reminder_1h` | patient | Reminder: your consultation starts within 1 hour | Your consultation starts at {when}. Please be ready a few minutes before the start. |
| `reminder_1h` | doctor | Reminder: a consultation starts within 1 hour | You have a consultation starting at {when}. Please be ready a few minutes before the start. |
| `rescheduled` | patient | Your consultation was rescheduled | {actor} rescheduled your consultation.\nPrevious time: {previous}\nNew time: {when} |
| `rescheduled` | doctor | A consultation was rescheduled | {actor} rescheduled a consultation with you.\nPrevious time: {previous}\nNew time: {when} |
| `cancelled` | patient | Your consultation was cancelled | {actor} cancelled your consultation scheduled for {when}. |
| `cancelled` | doctor | A consultation was cancelled | {actor} cancelled the consultation scheduled for {when}. |
| `schedule_blocked` | patient | Your consultation needs follow-up | Your doctor's schedule has changed and your consultation on {when} may be affected. It has not been cancelled. Vcare support will contact you to confirm the next steps. |
| `doctor_suspended` | patient | We need to follow up on your consultation | Your consultation scheduled for {when} needs follow-up. It has not been cancelled. A Vcare administrator will be in touch with you about the next steps. |
| `doctor_joined` | patient | Your doctor has joined | Your doctor has joined the consultation scheduled for {when}. Open your Vcare account to join. |

`{actor}` (rescheduled/cancelled): recipient patient + `byRole` patient -> `You`; patient + doctor -> `Your doctor`; patient + admin -> `Vcare support`; recipient doctor + patient -> `The patient`; doctor + doctor -> `You`; doctor + admin -> `Vcare support`; `byRole` absent or unknown -> the sentence uses the passive form (`Your consultation was rescheduled.`). `{previous}` = `formatLocal(previousStartsAtMs)`; a `rescheduled` row without `previousStartsAt` omits the `Previous time` line. Kinds with only a patient row (`schedule_blocked`, `doctor_suspended`, `doctor_joined`) render nothing for the doctor role (`template_missing`). Every body ends `\n\nThe Vcare team`; the reminder and booking bodies for the same kind in other locales are added in a later unit.

### 3.7 `doctor_suspended` producer
`ConsultationSuspensionImpactProvider` becomes `@injectable()` with `@inject(TOKENS.NotificationsService) notifications`; its `bootstrap.ts` binding is unchanged. In the same suspension transaction (`flagFutureConsultations(ctx, trx)`):
1. `flagFutureForDoctor(doctorUserId, now, DoctorSuspended, trx)` now returns, for **every** future non-terminal consultation (unchanged result and ordering, so `flaggedConsultationIds` and the per-consultation audit rows keep their behavior), a `newly_flagged` boolean computed from the pre-image in one statement:
```sql
WITH target AS (
  SELECT id, (needs_admin_followup AND followup_reason IS NOT DISTINCT FROM $reason) AS already_flagged
  FROM consultations
  WHERE doctor_user_id = $1 AND status IN ('booked','waiting','in_progress') AND deleted_at IS NULL
    AND ends_at > $now AND starts_at >= $lower
  FOR UPDATE)
UPDATE consultations c SET needs_admin_followup = TRUE, followup_reason = $reason, updated_at = NOW()
FROM target t WHERE c.id = t.id
RETURNING c.id, c.patient_user_id, c.starts_at, c.ends_at, NOT t.already_flagged AS newly_flagged
```
2. For rows with `newly_flagged = true` only (flag-once, consultations review): `notifications.enqueue(trx, [{ kind: doctor_suspended, consultationId, recipientUserId: patient_user_id, payload: { startsAt, endsAt, recipientRole: "patient" } }])`, one multi-row insert; ids are returned ascending as before.
Consequences: re-running a suspension after a reinstate/suspend cycle does not re-notify patients whose consultation still carries the `doctor_suspended` flag; a row previously flagged `schedule_blocked` (different reason) is notified. The no-op suspend path calls `listFlaggedConsultations` only and enqueues nothing. The suspension transaction gains no Identity or email call. `schedule-impact.provider.ts` already uses the same rule (`flagConsultations`).

### 3.8 `OutboxPurgeService` (loop `notification-outbox-purge`)
Per tick, up to `OUTBOX_PURGE_MAX_BATCHES` (20) batches of `OUTBOX_PURGE_BATCH` (5 000):
```sql
DELETE FROM notification_outbox WHERE id IN (
  SELECT id FROM notification_outbox WHERE status = 'sent' AND sent_at < $cutoff ORDER BY sent_at LIMIT 5000 FOR UPDATE SKIP LOCKED)
```
`cutoff = now - OUTBOX_RETENTION_DAYS` (30). Stops on a short batch or abort. `pending`, `dead` and `skipped` rows are never deleted (`dead` needs an operator; `skipped` retention is a follow-up if volume warrants, section 10). Safe with two workers (SKIP LOCKED); no advisory lock. Logs `outbox_purged { deleted }`.

### 3.9 Worker registration, env, pool
`buildWorkerLoops` adds the three loops built from `deps.db`, `deps.identity`, `deps.logger`, `deps.env`, a `LogEmailAdapter`, a `NotificationsService`, and a `ConsultationReminderService` (consultations module, constructed with the worker `db`). `runOnce` works unchanged (`node dist/worker.js --once notification-outbox` runs one tick; a tick returns `"incomplete"` when a claimed batch had lease-lost rows, otherwise `"done"`).

`lib/config/env.ts` (zod; none secret, all with defaults; `positiveSeconds` as existing):

| Variable | Default | Range | Purpose |
|---|---|---|---|
| `OUTBOX_POLL_SECONDS` | `5` | 1..86400 | `notification-outbox` loop interval |
| `OUTBOX_BATCH_SIZE` | `20` | 1..100 | rows claimed per round (also <= the contacts cap of 100) |
| `OUTBOX_MAX_ATTEMPTS` | `8` | 1..20 | attempts before `dead` |
| `OUTBOX_RETENTION_DAYS` | `30` | 1..365 | purge age of `sent` rows |
| `OUTBOX_PURGE_SECONDS` | `3600` | 1..86400 | purge loop interval |
| `REMINDER_SCAN_SECONDS` | `60` | 1..86400 | reminder scan interval |

Fixed constants in `app/notifications/constants.ts` (not env, like Identity's 2 s timeout): `OUTBOX_LEASE_SECONDS = 300`, `EMAIL_SEND_TIMEOUT_MS = 5000`, `OUTBOX_BACKOFF_BASE_MS = 30000`, `OUTBOX_BACKOFF_CAP_MS = 1800000`, `OUTBOX_MAX_ROUNDS = 10`, `REMINDER_BATCH_LIMIT = 200`, `REMINDER_MAX_BATCHES = 5`, `REMINDER_WINDOW_24H_MS`, `REMINDER_WINDOW_1H_MS`, `OUTBOX_PURGE_BATCH = 5000`, `OUTBOX_PURGE_MAX_BATCHES = 20`, loop names `notification-outbox`, `consultation-reminders`, `notification-outbox-purge`. The planned names in `infrastructure.md` (`WORKER_BATCH_SIZE`, `REMINDER_SCAN_INTERVAL_MS`) are replaced by the table above; `EMAIL_PROVIDER_*` and `EMAIL_FROM` stay planned for the real adapter. `WORKER_POOL_MAX` in `src/worker.ts` becomes 6 (N-D8).

### 3.10 DI and bootstrap
API side: only `ConsultationSuspensionImpactProvider` gains an injected dependency (`TOKENS.NotificationsService` already exists). Worker side: manual composition in `worker-loops.ts`; no container. `IdentityClient` already exists in `worker.ts`; its pool is closed by `closeAll` as today.

### 3.11 Contract drift check
`contracts/openapi.yaml` was searched (2026-10-12) for `notification`, `outbox`, `reminder`, `doctor_suspended`: it mentions notifications only in prose of the schedule-conflict operation (line ~678), the "doctor joined" prose of the future join route (~2270), and `followupReason: doctor_suspended` (~5005). This unit adds **no route, header, field, or error code**, so **`contracts/openapi.yaml` does not change**. The synced Identity contract already defines `getUserContacts`; no Identity change is required.

---

## 4. Business rules

| ID | Rule | Enforced by |
|---|---|---|
| N-R1 | A notification row exists iff the write that announces it committed (including `doctor_suspended`). | same-transaction `enqueue`; test: rollback leaves none |
| N-R2 | Two workers never claim the same row in one lease. | `FOR UPDATE SKIP LOCKED` + lease via `next_attempt_at` |
| N-R3 | A result is written only by the worker holding the current claim. | guard `status='pending' AND attempts = n` |
| N-R4 | No Identity call, email send, or other network I/O happens inside a database transaction. | claim is one autocommit statement; scan transaction does only SQL |
| N-R5 | A delivery failure never fails, delays, or rolls back the originating write. | outbox decoupling; worker is a separate component |
| N-R6 | Retry delay after send failure `n` is `30 s * 2^(n-1)` capped at 30 min (±20 % jitter); a row is `dead` when `n >= OUTBOX_MAX_ATTEMPTS` (8). | `OutboxDeliveryService` |
| N-R7 | A contacts-lookup failure delays the row and does not consume an attempt (N-D1). | service + `attempts_delta = -1` |
| N-R8 | Unknown recipient -> `skipped/recipient_unknown`; non-active recipient -> `skipped/recipient_inactive`; no retry. | service |
| N-R9 | A permanent provider answer marks the row `dead` at once (N-D7). | service |
| N-R10 | A reminder whose consultation is no longer `booked`, is deleted, has a different `starts_at` than the payload, or has started is `skipped` and never sent. | claim-time re-check |
| N-R11 | Each reminder kind is queued at most once per recipient per consultation start; the enqueue and the stamp are atomic. | row lock + one transaction |
| N-R12 | Both patient and doctor get both reminders; a consultation booked inside the window gets no reminder for that window; within 1 h only the 1 h reminder is sent. | `ReminderScanService` |
| N-R13 | Reschedule resets both reminder columns; cancel needs no cleanup; stale queued reminders are dropped by N-R10. | `rescheduleRow` (built) + N-R10 |
| N-R14 | Emails, names, locale, subjects and bodies are never logged, stored, cached, or put in `last_error_code`; `last_error_code` is from a fixed vocabulary. | code + redaction (`email`, `fullName` are redacted keys) + tests |
| N-R15 | Rendering uses the recipient's timezone (patient snapshot / doctor profile) and the recipient's role derived from the database. | `templates` + N-D5 |
| N-R16 | No template reveals a reason, complaint text, the suspension cause, or a counterpart name. | templates + payload allowlist |
| N-R17 | `doctor_suspended` is enqueued once per consultation per `doctor_suspended` flag (flag-once), in the suspension transaction, to the patient only. | provider + `newly_flagged` |
| N-R18 | Sent rows older than `OUTBOX_RETENTION_DAYS` are purged in batches; other statuses are never purged. | `OutboxPurgeService` |
| N-R19 | A row claimed more than `OUTBOX_MAX_ATTEMPTS` times through lease expiry is `dead/lease_expired`. | service |
| N-R20 | The send is bounded at 5 s; a timeout or throw is a transient failure. | `settleWithin` |
| N-R22 | Reminders are still queued and sent for `booked` consultations flagged `needs_admin_followup` (owner decision 2026-10-12); the scan filters on status only. | `ReminderScanService` queries |
| N-R21 | The delivery path is not a clinical access: no `audit_logs` rows per send (the write that created the row is already audited). | design |

---

## 5. Cross-service behavior
- **Calls made:** Case 5, `care-worker` -> identity `GET /internal/users/contacts?ids=` (<= 100 ids/call, one call per claimed batch, one attempt, 2 s timeout, token with only `users:contact:read`). **Failure policy: delay** (not degrade, not must-succeed): rows stay `pending` with backoff, no request path depends on it, a booking never waits on it. Unknown/inactive recipients -> `skipped`.
- **Calls served:** none. The API listener never calls this endpoint; `GET /internal/health/*` is unchanged.
- **Provider dependency:** Identity implements the endpoint (identity ADR 0024). Environment check for manual QA: the `care-service` client holds `users:contact:read` (otherwise the token fetch fails, rows are delayed, lag alert fires).

## 6. Error codes
No HTTP errors; no new codes in the API catalogue. Persisted `last_error_code` vocabulary (not an API surface):

| Code | Status effect | When |
|---|---|---|
| `contacts_unavailable` | stays `pending`, attempt not consumed | contacts call failed for the row's recipient |
| `email_timeout` / `email_error` | retry, or `dead` at the max | send timed out / threw / transient provider answer |
| `email_rejected` | `dead` | permanent provider answer |
| `recipient_unknown` / `recipient_inactive` | `skipped` | absent from Identity answer / status not `active` |
| `consultation_missing` / `consultation_changed` / `reminder_expired` | `skipped` | claim-time re-check (N-R10) |
| `template_missing` | `skipped` | no template for (kind, role) |
| `lease_expired` | `dead` | claimed more than max attempts through crashes |

## 7. Security & privacy
- **RBAC:** none (no routes). The loops run as `care_app` on the worker pool; grants are column-level for `UPDATE` (state columns only) and `DELETE` for the purge; `payload`, `kind`, `recipient_user_id`, `consultation_id` are immutable to the app role.
- **Contact data:** in memory for one batch; no Redis; never logged; not in `last_error_code`; the email address never reaches the port's log adapter output.
- **Logging hygiene:** worker logs carry `outboxId`, `kind`, `attempts`, `errorCode`, `reason`, counts, durations; never address, name, locale, subject, body, or payload content. Metric dims are bounded (`kind`, `reason`, `case`), never user ids. `email`/`fullName` are already redacted keys; do not rely on it.
- **Audit:** none per send (N-R21). Existing audit rows on the originating writes stay. A `dead` row is surfaced by `notification_dead` (error) + alert.
- **Rate limits:** none (internal). Scale is bounded by batch size and loop cadence.
- **Files:** not applicable.
- **Phase 2:** no AI content in emails.

## 8. Performance
- Outbox hot path per round: 1 claim (index `idx_notification_outbox_pending_next_attempt_at_id`), 1 consultation-context query (`id = ANY`, PK + PK join on `doctor_profiles.user_id` via `uq_doctor_profiles_user_id`), 1 contacts call, <= 1 batched skip update, 1 PK `UPDATE` per sent row. No N+1.
- Reminder scan: <= 5 statements per iteration, index `idx_consultations_booked_starts_at`; <= 5 iterations per tick.
- Lag query: first entry of the claim index. Purge: one indexed batched delete.
- Sizing (capacity.md): ~25 k outbox rows/day plus reminders; 20 rows per 5 s poll drains ~345 k/day per worker with a log-only adapter; the 5 s send timeout bounds a batch at ~100 s worst case (lease 300 s). Worker pool 6 connections.
- Budgets: none of these is on a request path; the scan transaction and each claim stay below the worker statement timeout of 5 s.

## 9. Test plan outline
Unit (`tests/unit`, injected clock/random/sleep, fakes for port, identity client, repo, `settleWithin` fallback):
- Backoff: `exponentialBackoffMs` base/cap/jitter bounds; `backoffMs` unchanged.
- Delivery decisions: should send and mark sent when contact is active (N-R14 outcome fields); should retry with `30 s * 2^(n-1)` and cap at 30 min when send is transient (N-R6); should mark dead at attempt 8 (N-R6); should mark dead at once when provider answer is permanent (N-R9); should time out a send after 5 s and treat it as transient (N-R20); should treat a thrown send as `email_error` without storing the message; should skip unknown and non-active recipients (N-R8); should delay without consuming an attempt when contacts are unavailable and grow the delay with consecutive failures, reset on success (N-R7); should drop reminders for cancelled/rescheduled/started/deleted consultations (N-R10); should dead-letter a row claimed beyond the max (N-R19); should not overwrite when the guarded update returns zero rows (N-R3); should render recipient role from the database not the payload (N-R15).
- Reminder decisions: should still enqueue reminders when the consultation is flagged `needs_admin_followup` (N-R22); window boundaries (exactly 24 h/1 h inclusive, exactly `starts_at` excluded), booked-inside-window stamp-only, within-1 h supersedes 24 h (N-R12), both recipients, message payload keys within the allowlist.
- Templates: every (kind, role) copy, `{actor}` matrix, DST-forward/back rendering in Africa/Cairo, America/New_York and Europe/London, invalid zone -> UTC, locale fallback `ar`/`en-US`/garbage -> `en`, no reason/counterpart text (N-R16).
- `getContacts`: 100-id chunking (250 ids -> 3 calls), de-duplication, DTO strictness (bad email, extra id, duplicate id -> chunk unavailable), classification table of section 3.3 (`401` refresh once, `403`, `429`, `5xx`, timeout, malformed `200`), request carries the contact token and never the status token, no Redis calls, nothing logged containing the fixture address/name.
- `LogEmailAdapter`: logs exactly `outboxId`, `kind`, `recipientUserId`; fixture address/subject/body never appear.
- Env: defaults and bounds of the six variables.

Integration (`tests/integration`, real Postgres + Redis, fake Identity server with contacts mode (ok / slow / 5xx / 403), recording fake `EmailPort`):
- Should claim with two concurrent workers without double-claiming (N-R2): 200 rows, two `OutboxDeliveryService` instances, every row sent exactly once.
- Should survive a crash after send: kill between send and mark, advance the clock past the lease, the row is sent again once and the stale writer's guard writes nothing (N-R3, at-least-once).
- Should back off and dead-letter after 8 failing sends with the fake clock; `attempts`, `next_attempt_at`, `last_error_code` asserted.
- Should recover after Identity contacts is down: rows stay `pending`, attempts unchanged, bookings unaffected (a booking made during the outage returns 201), rows sent after recovery (N-R5, N-R7).
- Should skip an unknown and a suspended recipient.
- Reminder scan: once per recipient across repeated scans and two concurrent scans (N-R11); both recipients; booked-inside-window skipped; reschedule resets and re-arms (N-R13); a reminder queued before a cancel is dropped at claim; a reminder queued before a reschedule is dropped; locked row is skipped and picked up next scan; fixed statement count with 1 and with 500 candidates.
- `doctor_suspended`: suspension enqueues one row per affected patient in the suspension transaction; a second suspension (after reinstate) enqueues none (N-R17); rollback leaves none; the response/audit ids are unchanged; a row flagged `schedule_blocked` is notified.
- Purge: only `sent` rows older than the cutoff are deleted, in batches; `pending`/`dead`/`skipped` survive (N-R18).
- Grants: `care_app` cannot update `payload`/`kind` (`42501`); can update state columns and delete (migration test, 2.3).
- EXPLAIN: with 5 000 pending + 5 000 sent rows analysed, the claim and lag queries use `idx_notification_outbox_pending_next_attempt_at_id` and no sequential scan; the purge uses `idx_notification_outbox_sent_at`; the reminder queries use `idx_consultations_booked_starts_at`.
- Log hygiene: run a full cycle with fixture strings in the contact address, name, and (via other flows) complaint/reason text; captured logs contain none of them (N-R14).
- `worker --once notification-outbox` and `--once consultation-reminders` exit 0 and run exactly one tick; the loops are registered in `buildWorkerLoops`.
- The `tests/helpers` gain a recording `EmailPort` fake and a contacts mode on `fake-identity-server.ts`.

## 10. Out of scope
A real email provider and its credentials; the `doctor_joined` producer (ships with `sessions`); admin endpoints or UI to inspect/requeue `dead` rows (runbook SQL only); SMS/WhatsApp/push; preferences/unsubscribe; HTML templates; other locales than `en`; RabbitMQ or any bus; cache invalidation and the discovery listener; purge of `skipped`/`dead` rows (follow-up if volume warrants); notifications to admins.

## 11. Open questions
None. Resolved by the owner (2026-10-12): reminders are **still sent** for `booked` consultations flagged `needs_admin_followup` (the appointment stands until an admin acts); the scan has no flag predicate (rule N-R22).

**Contract changes required:** none.

### Platform changes required (/system-design), not blocking
No hub doc is edited here; none of these blocks `/develop`.
1. Hub `capacity.md` roll-up: outbox volume row for `care-worker` (about 25 k rows/day plus 4 reminder rows per consultation, 30-day retention) and the worker pool of 6.
2. A real email provider ADR (SES/SMTP adapter behind `EmailPort`, `EMAIL_PROVIDER_*`, `EMAIL_FROM`, DKIM/SPF, bounce handling) before production use; until then production sends nothing.
3. Environment: provision the `care-service` Identity client with scope `users:contact:read` in every environment.

## 12. Task ordering (CLAUDE.md -> Build order)
0. Contract: none. 1. Migrations 2.1, 2.2 and migration tests. 2. `enums.ts` (`DoctorSuspended`, `OutboxErrorCode`), `constants.ts`, `types.ts`. 3. `lib/async/backoff.ts` extraction. 4. `lib/email`. 5. `lib/identity-client` `getContacts` + DTOs. 6. Templates + `format-time`. 7. Repository functions; `ConsultationReminderService` + consultations repo functions + flag-once `flagFutureForDoctor`. 8. `OutboxDeliveryService`, `ReminderScanService`, `OutboxPurgeService`. 9. `doctor_suspended` producer. 10. Loops, `worker-loops.ts`, env, pool size. 11. Tests (unit, integration, concurrency, EXPLAIN, log hygiene). 12. Manual QA with the fake Identity and the recording port. 13. Docs.

**Docs to refresh at `/update-docs`:** `architecture/data-model.md` (outbox: new kind, index names, grants, CHECKs, reminder index; remove "NOT created yet"), `architecture/infrastructure.md` (env table, worker loops and `--once`, pool size), `architecture/deployment.md` (built loops; metrics `notification_outbox_lag_seconds`, `notification_sent|failed|dead|skipped` replacing `outbox_oldest_pending_age_s`/`outbox_dead`; alerts below), `architecture/integration.md` and hub-facing Case 5 text (as built), `architecture/resilience.md`, `architecture/consultation-lifecycle.md` and `scheduling-slots.md` (delivery as built), `consultations/spec.md` (suspension impact provider now queues `doctor_suspended`), `runbook.md` (alerts, dead-row SQL, `--once`), `docs/service-card.md` (see below), `docs/INDEX.md`.

**Alerts and metrics (ADR 0007; for deployment.md/runbook):** `notification_outbox_lag_seconds` per tick (gauge); counters `notification_sent{kind}`, `notification_failed{kind}`, `notification_dead{kind}`, `notification_skipped{reason}`, `notification_reminders_enqueued{kind}`; `identity_call_failed{case=contacts}`; log events `notification_sent`, `notification_failed`, `notification_dead`, `notification_skipped`, `notification_contacts_unavailable`, `notification_lease_lost`, `outbox_purged`, `email_log_adapter_send`. Alerts: `OutboxDeadJobs` (any `notification_dead`, ticket, unchanged); `OutboxLagHigh` (`notification_outbox_lag_seconds > 300` for 5 min, ticket, threshold unchanged from the published design); runbook escalation line: lag above 900 s (the brainstorm's 15 minutes) means check Identity contacts and the provider before scaling to 2 workers.

**Service card:** `docs/service-card.md` is affected (worker loops list, `notification_outbox` no longer insert-only, Case 5 consumer now built, email port) and re-syncs to the hub via `scripts/sync-from-spoke.sh`.

## 13. Dependencies on being done first
Consultations branch (`feature/consultations`, PR #38) merged or stacked: this unit modifies `suspension-impact.provider.ts` and `consultations.repo.ts`.

---

## 14. As-built notes (2026-10-14, version 0.2.0)
Built, unit and integration tested (green), manually QA'd on 2026-10-14 and re-run on 2026-10-15 ([manual-qa.md](./manual-qa.md): 156 pass, 0 fail). The `--once` shutdown abort found in the first run (case 154, Windows libuv assertion) is fixed in `src/worker.ts` `runOnce` (sets `process.exitCode`, lets the loop drain, unref'd 5 s fallback exit) and verified on Windows; Linux was not run. The spec above is unchanged history; where it differs from the code, this section wins. **Contract: unchanged**, re-checked against `contracts/openapi.yaml` (no route, header, field or error code was added; notification prose in the contract is still accurate).

**Intentional divergences from sections 1 to 13**
- **Loop builders live in one file.** `src/app/notifications/worker/notification.loops.ts` exports `buildNotificationOutboxLoop`, `buildConsultationRemindersLoop` and `buildNotificationOutboxPurgeLoop` (section 3.1 planned three files). Loop names and registration in `src/worker-loops.ts` are as specified; services are composed manually there (`OutboxDeliveryService`, `ReminderScanService`, `OutboxPurgeService`, `NotificationsService`, `ConsultationReminderService`, `LogEmailAdapter`).
- **Delivery rules are a separate pure module**, `src/app/notifications/delivery-rules.ts` (`decidePreSend`, `recipientRoleOf`, payload readers), used by `OutboxDeliveryService`; behaviour matches section 3.4 step 4 and N-D5.
- **Tick outcome.** `OutboxDeliveryService.tick` returns `"incomplete"` (so `--once` exits 1 with `worker_once_incomplete`) when any claimed row lost its lease; otherwise `"done"` (section 3.4 said it always returns `"done"`; section 3.9 already described this).
- **`notification_failed` is not emitted for a contacts-lookup delay.** Those rows carry `last_error_code='contacts_unavailable'` and are signalled by `notification_contacts_unavailable` and `identity_call_failed{case=contacts}`; `notification_failed` counts transient send failures only. `notification_skipped` carries the `reason` dimension from the fixed vocabulary.
- **Environment.** The six variables, the `WORKER_POOL_MAX = 6` pool and the fixed constants are as in 3.9. The planned names `WORKER_BATCH_SIZE` and `REMINDER_SCAN_INTERVAL_MS` were removed from `architecture/infrastructure.md` (replaced by the table in 3.9).

**Architecture docs refreshed at this `/update-docs`:** `data-model.md` (outbox kind, CHECKs, indexes, grants, state machine, reminder index), `infrastructure.md` (env table, worker pool 6, loops), `integration.md` (Case 5 as built), `resilience.md` (lease claim, at-least-once, contacts delay), `deployment.md` (built loops, metrics, alerts, bottleneck 6), `capacity.md` (pool), `overview.md`, `consultation-lifecycle.md`, `runbook.md`, `quickstart.md`, `service-card.md`, `INDEX.md`, and the pointer in `consultations/spec.md` section 13.

**Open items**
1. **Purge plan watch item (not a defect).** On a 750 k-row outbox the purge `DELETE ... WHERE id IN (SELECT ... ORDER BY sent_at LIMIT 5000 FOR UPDATE SKIP LOCKED)` is planned as a Hash Semi Join over a sequential scan of the table: about 150 ms per 5 000-row batch while draining a 338 k-row backlog (five ticks cleared 338 k rows in about 20 s); steady state is a bitmap scan plus primary-key probes at 6.4 ms, and 0.15 ms when nothing is eligible. If a faster drain is ever required, rewrite as `DELETE ... USING (subquery)` so the outer relation is not scanned. Claim (0.87 ms), lag (0.03 ms) and guarded finish (0.10 ms) use their indexes with no sequential scan.
2. **Environment checks still open** (spec section 5 and 11): the deployed `care-service` Identity client must hold `users:contact:read`; until it does, rows are delayed and `OutboxLagHigh` fires. Manual QA used the fake Identity only (cases 54 to 58 verify the delay path for 403 and for a client without the scope).
3. **Production sends no real email**: only `LogEmailAdapter` exists. A provider ADR (`EMAIL_PROVIDER_*`, `EMAIL_FROM`, DKIM/SPF, bounce handling) is required first (section 11, platform changes 2).

**Platform deltas** (listed for the hub; applied directly this session per the three-repo sync rule, see the update-docs report): Case 5 is built (landscape), `care-worker` pool 6 and loops (deployment), outbox volume and pool (capacity).
