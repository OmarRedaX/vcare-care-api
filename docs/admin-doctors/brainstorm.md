---
title: admin-doctors — Brainstorm
owner: care-team
service: care-service
module: admin-doctors
status: draft
diataxis: explanation
last_verified: 2026-10-09
tags: [brainstorm, admin-doctors, suspension, reinstatement, identity, case-3, case-4]
related: [verification-spec, doctors-spec, integration, resilience, adr-0004-cross-service-failure-policies, adr-0012-doctor-reinstatement]
---

# admin-doctors — Brainstorm

Scope decided with the user on 2026-10-09 (branch `feature/admin-doctors`, from `origin/main` @ 654a390, which already
contains the merged `schedules` PR #30 and the reinstate/audit-range contract PR #29). The companion module `audit`
(time-ranged `GET /audit-logs`) follows with its own brainstorm.

## Problem & purpose
Care is the only initiator of doctor account-status changes (hub ADR 0006). Approve/reject/reopen exist (`verification`,
Case 1). There is no way to **suspend** an approved doctor (Case 3, security-critical) or **reinstate** a suspended one
(Case 4, ADR 0012). Without them a misbehaving doctor stays bookable and signed in, and a mistaken suspension needs a
manual two-database edit.

## Actors
- **Admin** — the only caller of both routes.
- **care-worker** — retries the durable Identity sync job (system actor).
- **Identity** (provider) — `PATCH /internal/users/:id/status`, doctor targets only; accepts `active → suspended` and
  `suspended → active`; the same status again is a 200 no-op; any other pair is `409 InvalidStatusTransition`.

## In scope (this iteration)
- `PATCH /api/admin/doctors/{doctorUserId}/suspend` `{ reason }` (Case 3).
- `PATCH /api/admin/doctors/{doctorUserId}/reinstate` `{ reason }` (Case 4).
- Durable `identity_sync_jobs` rows `kind='suspension'|'reinstatement'` (table and CHECKs already exist) and the
  worker loop extended to drive them (today `processDueSyncJob` only handles `verification`).
- Alerts: `IdentitySuspensionSyncFailing` (3 consecutive failures), `IdentitySyncTransitionRejected` (409, immediate
  page), reinstatement unsynced for more than 15 min.
- The local block is immediate: `suspended_at` is already honoured by bookability, schedules and onboarding guards.
- No new dependency; reuse `IdentityClient.setUserStatus`, the service-token cache and `lib/knex/session-advisory-lock`.

## Out of scope
- Cancelling future bookings (flag only, see decisions). The `consultations` table does not exist yet, so
  `flaggedConsultationIds` is `[]` behind a no-op port, wired by the `consultations` module (same pattern schedules used).
- Doctor-facing suspension notices, an admin console UI, a list/search of suspended doctors.
- Any change to Identity (its internal route already supports both transitions, Identity #12).
- Hub edits other than the sync (`/system-design` owns hub docs).

## Key entities & relationships
- `doctor_profiles`: `suspended_at`, `suspended_by`, `suspension_reason`, `identity_sync_status`
  (`not_required|pending|synced|failed`) — exist; a CHECK ties `suspended_at` and `suspension_reason` together.
- `identity_sync_jobs`: one open job per profile (`uq_identity_sync_jobs_doctor_profile_id_open`), `kind`,
  `target_status`, `attempts`, `consecutive_failures`, `next_attempt_at`; superseding marks the older open job `superseded`.
- `consultations` (future): the `needs_admin_followup` flag, reached through a no-op port until that module exists.

## Primary flows / endpoints (with roles + ownership)
| Route | Role | Ownership | Responses |
|---|---|---|---|
| `PATCH /api/admin/doctors/{id}/suspend` | admin (token status active) | none | 200 confirmed (incl. already-suspended no-op) · **503 `IdentityUnavailable`** with `suspension:'applied-locally, session-revocation-pending'` · 400 · 401 · 403 · 404 · 409 `InvalidTransition` · 429 |
| `PATCH /api/admin/doctors/{id}/reinstate` | admin (token status active) | none | 200 confirmed or not-suspended no-op · **202** `identitySync: pending\|failed` · 400 · 401 · 403 · 404 · 409 `InvalidTransition` · 429 |

Suspend: lock the profile `FOR UPDATE`, check the precondition (`approved` + `synced` + not suspended, else
`409 InvalidTransition`), then one transaction (set `suspended_at/by/reason`, `identity_sync_status='pending'`, flag
consultations via the port, insert a `kind='suspension'` job, audit). After commit: inline Identity attempts for about
6 s, then `synced` + 200, else 503.
Reinstate: same shape, precondition `suspended` + `synced`; clears `suspended_at/reason`, inserts a
`kind='reinstatement'` job; 3 inline attempts, then 200, else 202.

## Business rules & state transitions
- Identity failure policy: **Care's state moves first; the Identity call retries until success.** Suspension is
  must-not-degrade (503 until confirmed, no attempt cap, never reported complete early). Reinstatement is
  retry-report-pending (202). Both retry only transient failures (network, timeout, 429, 5xx, one token refresh on 401).
- `409 InvalidStatusTransition` from Identity is **non-retryable**: job `failed`, `identity_sync_status='failed'`,
  local state kept, page on-call, no loop.
- Reinstate sets `identity_sync_status='pending'`, so the doctor stays unbookable until Identity confirms.
- A newer suspend/reinstate supersedes an open job (the `synced` precondition normally means none is open).
- Reinstatement does not unflag consultations; an admin resolves them explicitly.

## Cross-service touchpoints (case, direction, failure policy)
| Case | Direction | Policy |
|---|---|---|
| 3 suspend | Care → Identity `PATCH /internal/users/:id/status` `{suspended}` | must-not-degrade: 503, durable unbounded retry, page after 3 consecutive failures |
| 4 reinstate | Care → Identity same route `{active}` | retry-report-pending: 202, durable retry, alert after 15 min, page on 409 |

The request id is forwarded on every Identity call (the job stores `request_id`); `actorUserId` travels in the body as data.

## Privacy & audit
Audit rows are written in the same transaction as the state change: `doctor.suspended`, `doctor.reinstated`,
`consultation.flagged_for_followup` (one per flagged id, none today), `identity_sync.pending|synced|failed`; entity type
`doctor_profile`. Metadata holds ids and statuses only. Reason text stays out of logs; whether it goes into audit
metadata is settled in the spec (the audit contract allows reasons, the recorder caps strings at 500 chars).

## Constraints & guideline notes
- **Shared sync engine.** `attemptSync` (guarded Identity call plus local transition, advisory-lock namespace 1102) is a
  private method of `VerificationService`, and the loop accepts only `kind='verification'`. Copying it would break
  "Generic helpers have one home", and importing another module's repository is forbidden. Recommendation for
  `/construct-spec`: extract the Identity-sync transition into one service both modules call, as a behaviour-preserving
  refactor guarded by the existing verification tests.
- Suspend on an already-suspended doctor is a 200 no-op returning the current `identitySyncStatus` (contract wording);
  if still `pending`/`failed` the body shows it. This is the one place a 200 is not a confirmation — raise it in review.
- `Idempotency-Key` is optional on both routes (ADR 0012); the preconditions make replays safe.
- Env: reuse `IDENTITY_SYNC_POLL_SECONDS` (10), `IDENTITY_SYNC_RETRY_CAP_SECONDS` (60), `IDENTITY_SYNC_ALERT_AFTER_SECONDS` (900).

## Contract changes expected
None for the routes (`suspendDoctor` and `reinstateDoctor` are already in `contracts/openapi.yaml`). The spec may pin the
503 body to `SuspensionPending` and the audit action list; any change goes into the contract first.

## Open questions
Decided 2026-10-09 (all recommended options): suspend stays 503, not 202 (the brief said 202; the contract and CLAUDE.md
Case 3 win); retry policy reuses the existing env with no attempt cap and no new env vars; bodies and audit names
exactly as the contract; suspension flags but never cancels.
Remaining for `/construct-spec`: sync-engine extraction shape; whether a suspended-but-pending no-op should be a 503.
Platform deltas for `/system-design`: none expected.

## Success criteria
- A suspended doctor is unbookable and blocked from doctor actions at commit, before Identity answers.
- Identity down: suspend → 503 + job enqueued; on recovery the job succeeds and the profile is `synced`; on 409 → `failed`, paged, no retry.
- Reinstate with Identity down → 202 pending; the doctor stays unbookable until `synced`; blind retries are safe.
- Every transition writes its audit rows atomically with the state change; RBAC and contract-conformance tests are green.
