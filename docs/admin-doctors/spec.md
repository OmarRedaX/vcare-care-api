---
title: admin-doctors — Spec
owner: care-team
service: care-service
module: admin-doctors
status: ready
version: 0.2.0
diataxis: reference
last_verified: 2026-10-09
tags: [spec, admin-doctors, suspension, reinstatement, identity-sync, case-3, case-4, worker, audit]
related: [admin-doctors-brainstorm, verification-spec, doctors-spec, schedules-spec, integration, resilience, runbook, adr-0004-cross-service-failure-policies, adr-0012-doctor-reinstatement, adr-0017-generic-helpers-and-transaction-scoping]
contracts: [contracts/openapi.yaml]
---

# admin-doctors — Spec

Suspend (Integration Case 3, must-not-degrade) and reinstate (Case 4, retry-report-pending) an approved doctor, plus the
extraction of the Identity-sync transition engine out of `VerificationService` so that **verification, suspension and
reinstatement share one engine** and one worker loop. Scope and owner decisions: [brainstorm.md](./brainstorm.md).

Binding rules: CLAUDE.md → "Database rules", "API conventions", "Authorization — RBAC and ownership", "Security rules",
"Privacy and logging", "Cross-service integration" (Cases 3 and 4), "Domain rules" (6, 7), "Testing policy",
"Performance rules", "Build order for a new module". Numeric ids are JSON numbers (hub ADR 0004). On any disagreement
`contracts/openapi.yaml` wins; where this spec goes beyond the contract wording (owner decisions Q1-Q3 of 2026-10-09), the exact edits are listed in §11 and are applied to the contract first by `/develop`.

## 1. Overview and decisions

**Owns:** the two admin routes `suspendDoctor` / `reinstateDoctor`; the writes of `doctor_profiles.suspended_at |
suspended_by | suspension_reason` and the `identity_sync_status` moves they imply; the shared sync engine (new module
`identity-sync`, §5.1). **Does not own:** the Identity account state (Identity applies it), consultations and their
flags (`consultations` module, behind a port), the local suspension *guards* (already live in `doctors`, `schedules`,
`verification`: `doctor_not_suspended`, `assertEditable`, `isBookable`).

**Dependencies.** `doctors` (shared `DOCTOR_PROFILE_COLUMNS`/mapper, `isBookable` unchanged), `access` (`userGuard`,
`authorize`, `AuditRecorder`), `lib/identity-client` (`setUserStatus`, unchanged), `lib/knex/session-advisory-lock`,
`lib/rate-limit`, `lib/idempotency`. Identity's internal route already accepts `active → suspended` and
`suspended → active` for doctor targets (Identity ADR 0025). **No new dependency, no new env var, no migration.**

| # | Decision (owner, 2026-10-09 — not reopened) | Where it lands |
|---|---|---|
| D1 | Suspend stays **503 `IdentityUnavailable`** until Identity confirms; unbounded durable retry; page after 3 consecutive failures | §3.2, §5.3 |
| D2 | Reinstate is **200 / 202** retry-report-pending; ticket alert after 15 min unsynced; Identity 409 → `failed` + page | §3.3, §5.3 |
| D3 | Reuse `IDENTITY_SYNC_POLL_SECONDS` (10), `IDENTITY_SYNC_RETRY_CAP_SECONDS` (60), `IDENTITY_SYNC_ALERT_AFTER_SECONDS` (900) | §5.3 |
| D4 | Bodies and audit action names exactly as the contract; entity `doctor_profile` | §3, §7 |
| D5 | Suspension flags future consultations, never cancels; `consultations` does not exist, so the flag sits behind a no-op port (`flaggedConsultationIds = []`) | §3.4 |

Decisions taken by this spec (veto in review):

| # | Decision | Reason |
|---|---|---|
| S1 | The job row is inserted **in the decision transaction** (verification D3), not "when inline attempts are exhausted". | Closes the commit-to-insert crash window; no sweeper needed. Supersedes the sweeper prose in `integration.md`/`resilience.md` (Appendix A). |
| S2 | The free-text `reason` is **not** written to audit metadata or logs; audit carries `reasonLength`. The text lives in `doctor_profiles.suspension_reason` (while suspended), in `identity_sync_jobs.reason` (permanent) and in Identity's status history. | Admin free text may contain names; same rule as verification D2; the recorder rejects strings > 500 chars and a 2 KB metadata cap, so a 2000-char reason would turn into a `500` and roll the suspension back. |
| S3 | Inline attempts: suspend and reinstate both use **3 attempts** (`SUSPEND_INLINE_ATTEMPTS`, `REINSTATE_INLINE_ATTEMPTS`, separate constants). With the client's 2 s per-attempt timeout that is the contract's "about 6 s" worst case (≤ 6.7 s with backoff). | Reuses `IdentityClient.setUserStatus(…, attempts)` unchanged; a deadline loop would need wall-clock logic and make tests timing-dependent. |
| S4 | Identity-bound `reason` is clamped to **500 code points** (Identity's `StatusChangeRequest.reason` `maxLength: 500`); Care's stored reason keeps up to 2000. | Without it a 501–2000 char reason makes Identity answer `400` forever and the engine retries forever (suspension: 503 for ever + page). Applies to verification too (§5.2 change (c)). |
| S6 (owner Q1) | A no-op never claims success while Identity is unconfirmed: suspend on an already-suspended doctor answers `200` only when `identity_sync_status='synced'`, else the same `503`; reinstate on a not-suspended doctor whose latest job is a `reinstatement` still `pending`/`failed` answers the same `202`. | Blind retries after `503`/`202` must never read as confirmation. |
| S7 (owner Q2) | Suspend while a reinstatement is unsynced stays `409 InvalidTransition`. | Contract precondition `synced`. |
| S5 | `consultation.flagged_for_followup` rows use entity type `consultation` (entity id = consultation id); every other row uses `doctor_profile`. | Lets `GET /audit-logs?entityType=consultation&entityId=` find the flag; the doctor-scoped rows stay on the profile. |

## 2. Database schema

**No migration.** Everything needed exists: `doctor_profiles` (`suspended_at`, `suspended_by`, `suspension_reason`,
`identity_sync_status`, `chk_doctor_profiles_suspension` ties `suspended_at` and `suspension_reason`) and
`identity_sync_jobs` (migration `20261007120200`: `chk_identity_sync_jobs_kind` already allows `suspension` /
`reinstatement`, `chk_identity_sync_jobs_target_status` ties `suspension→suspended`, `reinstatement→active`,
`uq_identity_sync_jobs_doctor_profile_id_open` = one pending job per profile, `fk_identity_sync_jobs_doctor_profile_id`
covered by that index). `TIMESTAMPTZ` everywhere; soft delete column `doctor_profiles.deleted_at` (every read adds
`whereNull('deleted_at')`); no table is created, so no grants change.

Column writes per transition (all through the repository functions of §3.5):

| Transition | `doctor_profiles` | `identity_sync_jobs` |
|---|---|---|
| suspend (commit) | `suspended_at = now()`, `suspended_by = admin`, `suspension_reason = reason`, `identity_sync_status = 'pending'`, `updated_at` | older pending → `superseded`; new row `kind='suspension'`, `target_status='suspended'`, `reason`, `actor_user_id = admin`, `request_id`, `status='pending'`, `next_attempt_at = now` |
| reinstate (commit) | `suspended_at/by/reason = NULL`, `identity_sync_status = 'pending'`, `updated_at` | same, `kind='reinstatement'`, `target_status='active'` |
| Identity confirms | `identity_sync_status = 'synced'` | `succeeded`, `succeeded_at`, `consecutive_failures = 0` |
| Identity 409 | `identity_sync_status = 'failed'` | `failed`, `last_error_code='InvalidStatusTransition'` |
| transient | — | `attempts += n`, `consecutive_failures += 1`, `last_error_code`, `next_attempt_at` |

`suspended_by` is cleared on reinstate so no stale actor remains; history lives in `audit_logs` (who/when) and the job
rows (reason).

Indexes used (no new index; each serves a query in code):

| Query | Index |
|---|---|
| lock profile by Identity user id (`WHERE user_id = ? AND deleted_at IS NULL FOR UPDATE`) | `uq_doctor_profiles_user_id` (partial, live rows) |
| open job of a profile (`WHERE doctor_profile_id = ? AND status='pending'`), supersede, insert guard | `uq_identity_sync_jobs_doctor_profile_id_open` |
| worker: due pending jobs, `suspension` first (`WHERE status='pending' AND next_attempt_at <= ? ORDER BY (kind='suspension') DESC, next_attempt_at, id LIMIT 50`) | `idx_identity_sync_jobs_pending_next_attempt_at` filters; the sort runs on the tiny due set (re-`EXPLAIN` in §8) |
| runbook history by Identity user id | `idx_identity_sync_jobs_doctor_user_id_id` |

## 3. API contract

Mirrors `operationId`s `suspendDoctor` and `reinstateDoctor` in `contracts/openapi.yaml` (checked 2026-10-09).

### 3.1 Routes, guards, policies

All routes: guard `userGuard()`, `Cache-Control: no-store` (`noStore()`), rate limit then `idempotency({ required: false })`.

| Method + path | Guard | Roles | Ownership | Account state | Audit class | Idempotency-Key | Rate limit |
|---|---|---|---|---|---|---|---|
| `PATCH /api/admin/doctors/{doctorUserId}/suspend` | user | `admin` | `none` (admin acts on any doctor) | token `status=active` (default) | `admin-action` | optional (UUID); 5xx/429 are not stored, so a retry after `503` re-executes (§4 BR8) | `admin-doctors-write` 30/min per admin user (`byUser`) |
| `PATCH /api/admin/doctors/{doctorUserId}/reinstate` | user | `admin` | `none` | token `status=active` | `admin-action` | optional; a stored `202` replays | same limiter name, same bucket |

`policies.ts`: `suspend` and `reinstate` are both `{ kind: "user", roles: ["admin"], owner: { kind: "none" }, audit: "admin-action" }`.
A doctor (including the target doctor suspending themself), a patient, and an unauthenticated caller are denied
(`403 Forbidden`, `401 Unauthorized`); the policy lists the role explicitly, there is no wildcard. `routes.ts`:
`router.patch(path, userGuard(), authorize(p.x), writeLimit(), key(), ctrl.x)`, mounted in `src/routes.ts` via
`buildAdminDoctorsRouter()` **after** the doctors/schedules routers and before any future `GET /doctors/:doctorUserId`.
Express path param is `:doctorUserId` (the contract's `DoctorUserIdPath`: the doctor's **Identity user id**, not the
profile id).

### 3.2 `PATCH /api/admin/doctors/{doctorUserId}/suspend`

Request (`SuspendDoctorDto`, unknown properties rejected, body required):

| Field | Rule |
|---|---|
| path `doctorUserId` | `@ToInt() @IsInt() @Min(1)` (`DoctorUserIdParamsDto`) |
| `reason` | `@IsString() @CodePointLength(3, 2000) @NoControlCharacters("all")` |

Responses:

| Status | Body | When |
|---|---|---|
| `200` | `{ success: true, data: SuspensionResult }` — `{ doctorUserId, suspendedAt, identitySyncStatus: "synced", flaggedConsultationIds }` | Suspension committed **and** Identity confirmed; **or** the doctor was already suspended **and** `identity_sync_status='synced'` (no-op, §3.2.1) |
| `503` | `SuspensionPending`: `{ success: false, error: { code: "IdentityUnavailable", message: "Suspension applied locally; session revocation is pending", details: [], requestId }, suspension: "applied-locally, session-revocation-pending", data: SuspensionResult }` with `data.identitySyncStatus` `pending` or `failed` | Committed locally, Identity not (yet) confirmed; also returned for an already-suspended doctor whose sync is `pending`/`failed` (S6). `data` is **always** present (required after the contract edit) |
| `400` `ValidationFailed` | envelope | bad path id, missing/short/long reason, control characters, unknown property |
| `401` `Unauthorized` / `TokenExpired`, `403` `Forbidden`, `404` `NotFound` (no live profile for `doctorUserId`), `409` `InvalidTransition`, `429` `RateLimited`, `500` `InternalError` | envelope | as in §6 |

`flaggedConsultationIds` comes from the port (§3.4): `[]` today. `suspendedAt` is the committed `suspended_at`.
Controller maps the service outcome: `confirmed` → `sendSuccess(200, SuspensionResultResponseDto.from(view))`; otherwise
`throw IdentityUnavailable.withExtra({ suspension: SUSPENSION_PENDING_MARKER, data: SuspensionResultResponseDto.from(view) })`
(`AppError.extra` renders sibling members; no change to `errorHandler`).

#### 3.2.1 Service algorithm (`AdminDoctorsService.suspend(actor, doctorUserId, reason)`)

1. **Decision transaction** (Knex handler form `this.db.transaction(async (trx) => …)`, no Identity call inside):
   1. `profile = lockProfileByUserId(doctorUserId, trx)` (`FOR UPDATE`, live rows). Absent → `NotFound`.
   2. `profile.suspendedAt !== null` → **no-op**: no write, no audit, no job, no Identity call; ids = `impact.listFlaggedConsultations(ctx, trx)`;
      return `{ view: { suspendedAt: profile.suspendedAt, identitySyncStatus: profile.identitySyncStatus, ids }, confirmed: profile.identitySyncStatus === 'synced' }`
      (S6: `pending`/`failed` renders the same `503`; the worker keeps converging the open job). End.
   3. Require `verificationStatus === 'approved' && identitySyncStatus === 'synced'`, else `InvalidTransition` (409). This also
      rejects a profile whose previous sync is `pending`/`failed`, so no older status change can still be in flight.
   4. `identitySync.supersedeOpen(profile.id, trx)` (defensive: the preconditions imply no open job; the partial unique index would otherwise turn a stray one into a `23505` → 500).
   5. `suspendedAt = applySuspension(profile.id, actor.userId, reason, trx)` (`UPDATE … SET suspended_at = now(), suspended_by, suspension_reason, identity_sync_status = 'pending', updated_at = now() … RETURNING suspended_at`).
   6. `flagged = await impact.flagFutureConsultations(ctx, trx)` (no-op returns `[]`; a real provider sets `needs_admin_followup=true`, `followup_reason='doctor_suspended'` inside this `trx`; it never cancels).
   7. `job = identitySync.enqueue(trx, { profile, kind: suspension, targetStatus: "suspended", reason, actorUserId: actor.userId, requestId })`.
   8. Audit in `trx` (§7.2): `doctor.suspended`, then one `consultation.flagged_for_followup` per flagged id.
   Any throw (including an audit or port failure) rolls the whole transaction back: no suspension, no job, no Identity call.
2. **After commit** (a crash here is safe: the pending job already exists and the worker picks it up within one poll):
   `report = await identitySync.syncNow(job.id, actor, SUSPEND_INLINE_ATTEMPTS)` — takes the per-doctor session advisory lock, calls Identity (≤ 3 attempts), records the result transactionally (§5.2). Never throws for Identity failures.
3. `confirmed = report.profile.identitySyncStatus === 'synced' && report.status === 200`. Return `{ view, confirmed }`.
   `locked === false` (another request or the worker holds the doctor's lock) maps to `pending` → 503; the holder finishes the work.

Metrics (counters, labels without ids): `doctor_suspension_total{outcome="confirmed|pending|failed|noop"}`.

### 3.3 `PATCH /api/admin/doctors/{doctorUserId}/reinstate`

Request: `ReinstateDoctorDto` identical to `SuspendDoctorDto` (`reason` 3–2000 code points, no control characters, unknown properties rejected).

| Status | Body | When |
|---|---|---|
| `200` | `{ success: true, data: ReinstatementResult }` — `{ doctorUserId, reinstatedAt, identitySyncStatus }` | Reinstated and Identity confirmed (`identitySyncStatus: "synced"`); **or** the doctor is not suspended and no reinstatement is unsynced (no-op, `reinstatedAt` = current time, `identitySyncStatus` = current value, e.g. `synced` or `not_required`) |
| `202` | `{ success: true, identitySync: "pending" \| "failed", data: ReinstatementResult }` (**`identitySync` is a top-level sibling of `data`**, unlike Case 1) | Local state committed, Identity unconfirmed (`pending`) or answered 409 (`failed`); also the no-op re-report for a not-suspended doctor whose latest job is a `reinstatement` still `pending`/`failed` (S6) |
| `400`, `401`, `403`, `404`, `409` `InvalidTransition`, `429`, `500` | envelope | §6 |

`reinstatedAt` is the transaction's `now` returned by the service (there is no stored column; a replay with the same
`Idempotency-Key` returns the stored body, a fresh retry is a no-op with a new "current time"). `sendSuccess` gains an
optional `siblings: Record<string, unknown>` option (merged next to `data`; generic helper, `lib/http/response.ts`) for the `202`.

#### 3.3.1 Service algorithm (`AdminDoctorsService.reinstate`)

1. **Decision transaction**: lock the profile by user id (`FOR UPDATE`). Absent → `NotFound`. `suspendedAt === null` → no-op
   (no write/audit/job/call): read the profile's latest job (`findLatestSyncJob(profileId)`, `ORDER BY id DESC LIMIT 1`, served by `idx_identity_sync_jobs_doctor_profile_id_created_at`); if it is `kind='reinstatement'` and `identitySyncStatus` is `pending`/`failed` → `202 { identitySync: <that status> }`, otherwise `200`. `identitySyncStatus !== 'synced'` → `InvalidTransition` (409): the suspension never reached
   Identity (`pending`/`failed`), so an `active` request would be rejected by Identity or race a live suspension job.
   Otherwise `supersedeOpen`, `clearSuspension(profile.id, trx)` (`suspended_at/by/reason = NULL`, `identity_sync_status = 'pending'`),
   `enqueue({ kind: reinstatement, targetStatus: "active", … })`, audit `doctor.reinstated`. Flagged consultations stay flagged; the port is **not** called.
2. After commit: `report = syncNow(job.id, actor, REINSTATE_INLINE_ATTEMPTS)`.
3. Outcome: `synced` → `{ status: 200 }`; `failed` → `{ status: 202, identitySync: "failed" }`; anything else (`pending`, lock not obtained) → `{ status: 202, identitySync: "pending" }`.

The doctor is bookable only when `suspended_at IS NULL` **and** `identity_sync_status='synced'` (`isBookable`, unchanged), so
a pending/failed reinstatement keeps the doctor unbookable. Metrics: `doctor_reinstatement_total{outcome="confirmed|pending|failed|noop"}`.

### 3.4 The consultation-flag port

`TOKENS.SuspensionImpactProvider`; interface in `admin-doctors/types.ts`; default `NoopSuspensionImpactProvider`
(registered in `bootstrap.ts` exactly like `NoopScheduleImpactProvider`); `consultations` rebinds it later.

```ts
interface SuspensionImpactContext { doctorProfileId: number; doctorUserId: number; now: Date }
interface SuspensionImpactProvider {
    /** Inside the suspension transaction: flag future non-terminal consultations; return their ids ascending. Never cancels or moves one. */
    flagFutureConsultations(ctx: SuspensionImpactContext, trx: Knex.Transaction): Promise<number[]>;
    /** Read-only: ids currently flagged `doctor_suspended` (future, non-terminal) for the no-op response. */
    listFlaggedConsultations(ctx: SuspensionImpactContext, conn: Knex): Promise<number[]>;
}
```

### 3.5 Files (build order 2–11)

```
src/app/admin-doctors/
  constants.ts   enums.ts   errors.ts   types.ts   policies.ts   routes.ts
  dto/admin-doctors.request.dto.ts   dto/admin-doctors.response.dto.ts
  repository/admin-doctors.repo.ts        # lockProfileByUserId, applySuspension, clearSuspension (uses doctors mapper, as verification does)
  service/admin-doctors.service.ts        # @injectable, owns the two transactions
  service/noop-suspension-impact.provider.ts
  controller/admin-doctors.controller.ts
src/app/identity-sync/                    # §5.1 (no routes, no controller)
```
`enums.ts`: `AdminDoctorAuditAction { Suspended = "doctor.suspended", Reinstated = "doctor.reinstated", ConsultationFlagged = "consultation.flagged_for_followup" }`.
`errors.ts`: `InvalidTransition = new AppError("InvalidTransition", 409, "The doctor cannot change from the current state")`;
`IdentityUnavailable = new AppError("IdentityUnavailable", 503, "Suspension applied locally; session revocation is pending")` (both codes already in `ErrorCode`).
DI: `TOKENS.AdminDoctorsService`, `AdminDoctorsController`, `SuspensionImpactProvider`, plus `IdentitySyncService`, `SyncTiming` (§5.1); `bootstrap.ts` registers `IdentitySyncService` before `VerificationService`.

## 4. Business rules

| # | Invariant | Enforced by |
|---|---|---|
| BR1 | Only an `approved` doctor with `identity_sync_status='synced'` and `suspended_at IS NULL` can be suspended; otherwise `409 InvalidTransition` and no write | decision transaction under `FOR UPDATE` (service); BR14 explains why `synced` |
| BR2 | Suspension commits `suspended_at/by/reason`, `identity_sync_status='pending'`, the flag call, the job and the audit rows **atomically**; from that commit Care blocks bookings (`isBookable`) and all doctor actions (`doctor_not_suspended`) | one transaction; guards already live in `doctors`/`schedules`/`verification` |
| BR3 | A suspension is reported complete (`200`) only when Identity confirmed; otherwise `503 IdentityUnavailable` + `suspension: applied-locally, session-revocation-pending` | service outcome + controller mapping; integration test |
| BR4 | Suspension retries are unbounded for transient failures (network, timeout, 429, 5xx, one 401 token refresh) and survive restarts | shared engine: no attempt cap; job row in Postgres |
| BR5 | A `409 InvalidStatusTransition` from Identity is never retried: job `failed`, `identity_sync_status='failed'`, local state kept, page `IdentitySyncTransitionRejected` | engine (`rejected-transition` branch) |
| BR6 | `IdentitySuspensionSyncFailing` pages when a suspension job reaches 3 consecutive failed engine attempts (and every 10th after) | engine policy for `kind='suspension'` |
| BR7 | Suspending an already-suspended doctor is a no-op (no job, no audit, no Identity call): `200` when `synced`, the same `503` when `pending`/`failed` (S6) | decision transaction |
| BR8 | Blind retries are safe: a retry after `503` finds the doctor suspended (BR7) and neither duplicates the job, the audit rows, nor the Identity call; a retry after `202` finds the doctor not suspended (BR13) | state preconditions; `Idempotency-Key` is an extra layer, not the guarantee |
| BR9 | Reinstatement requires `suspended_at IS NOT NULL` and `identity_sync_status='synced'`; otherwise `409 InvalidTransition` | decision transaction |
| BR10 | Reinstatement clears the local suspension and sets `pending`; the doctor stays unbookable until `synced`; flags set at suspension stay | one transaction; `isBookable` |
| BR11 | Reinstate answers `200` when Identity confirmed, `202 identitySync pending|failed` otherwise; a transient failure keeps retrying and raises `IdentityReinstatementSyncPending` after `IDENTITY_SYNC_ALERT_AFTER_SECONDS` (900 s) unsynced, once per episode | engine policy for `kind='reinstatement'` |
| BR12 | At most one open job per profile; a newer decision supersedes an older open job in the same transaction, and a superseded job never reaches Identity | `uq_identity_sync_jobs_doctor_profile_id_open`; `supersedeOpen`; engine re-check under the doctor lock |
| BR13 | Reinstating a doctor who is not suspended is a no-op (no write/audit/job/call): `200`, or `202` while the latest `reinstatement` job is `pending`/`failed` (S6) | decision transaction |
| BR14 | A job can only be created from a `synced` profile, so Identity's current status is the one the transition assumes (`active → suspended`, `suspended → active`) | BR1/BR9 preconditions |
| BR15 | Two concurrent suspends (or reinstates) for one doctor create exactly one job and one `doctor.suspended` row; the loser returns the BR7/BR13 no-op | `FOR UPDATE` on the profile |
| BR16 | Outbound status calls for one doctor never run concurrently, across all three job kinds and across API and worker | session advisory lock `IDENTITY_SYNC_LOCK_NAMESPACE = 1102` keyed by profile id |
| BR17 | Suspension flags future non-terminal consultations and never cancels or reschedules them | port contract; no cancel method exists |
| BR18 | The admin is the only caller; `actorUserId` sent to Identity is the verified token subject, never a body value | `authorize` + `actor.userId` |
| BR19 | The Identity-bound `reason` is ≤ 500 code points; Care stores the full text | engine clamp (S4); `truncateCodePoints` |
| BR20 | Audit rows commit or roll back with the state change; an audit failure fails the request without a suspension | `AuditRecorder.record(trx, …)` |

## 5. Cross-service behavior

Care → Identity `PATCH /internal/users/{id}/status` `{ status, reason, actorUserId }` through `lib/identity-client`
(`setUserStatus`: service token cached, single token refresh on 401, 2 s per attempt, `X-Request-Id` forwarded, response
validated by DTO). Case 3 policy **must-not-degrade**, Case 4 **retry-report-pending** (ADR 0004, ADR 0012). Nothing is
served to Identity. Other services: none.

### 5.1 Shared engine: exact extraction

New module `src/app/identity-sync/` (a bounded context without routes; both `verification` and `admin-doctors` call its
**service**, never its repository, and it imports no other module's repository):

| File | Content | Moves from |
|---|---|---|
| `enums.ts` | `IdentitySyncJobKind`, `IdentitySyncJobStatus`, `IdentitySyncAuditAction` (`identity_sync.pending|synced|failed`) | `verification/enums.ts` |
| `constants.ts` | `IDENTITY_SYNC_LOCK_NAMESPACE = 1102` (same value as today's `VERIFICATION_SYNC_LOCK_NAMESPACE`), `IDENTITY_SYNC_LOOP_NAME = "identity-sync"`, `IDENTITY_SYNC_BATCH = 50`, `IDENTITY_REASON_MAX_CODE_POINTS = 500`, `SUSPENSION_FAILURE_PAGE_THRESHOLD = 3`, `SUSPENSION_FAILURE_REPAGE_EVERY = 10` | `verification/constants.ts`, `verification.service.ts` |
| `types.ts` | `IdentitySyncJobRow`, `EnqueueSyncJob`, `SyncAttempt`, `SyncReport`, `SyncTiming { now(): number; random(): number }`, `SyncKindPolicy` | `verification/types.ts` |
| `sync-policy.ts` | `buildSyncPolicies(env): Record<IdentitySyncJobKind, SyncKindPolicy>` (§5.3) | new |
| `repository/identity-sync.repo.ts` | `insertSyncJob`, `findSyncJob`, `findPendingSyncJob`, `supersedePendingSyncJob`, `updateSyncJob`, `listDuePendingJobs(limit, now, conn)`, `setProfileIdentitySync`, `findProfileForSync(id, conn, lock)` (shared `DOCTOR_PROFILE_COLUMNS` mapper), `JOB_COLUMNS` | `verification.repo.ts` |
| `service/identity-sync.service.ts` | `IdentitySyncService` | `VerificationService.attemptSync / syncOutcome / processDueSyncJob / listDueSyncJobIds` |
| `worker/identity-sync.loop.ts` | `buildIdentitySyncLoop({ service: IdentitySyncService, logger, pollSeconds })` | `verification/worker/identity-sync.loop.ts` |

`IdentitySyncService` (constructor `(db, audit, identity, env, timing)`, `@inject` tokens `Db, AuditRecorder, IDENTITY_CLIENT, Env, SyncTiming`;
`TOKENS.SyncTiming` defaults to `{ now: Date.now, random: Math.random }` in `bootstrap.ts`, tests pass fakes):

| Method | Used by | Behavior |
|---|---|---|
| `enqueue(trx, job)` | verification, admin-doctors (inside their decision transaction) | inserts the pending job with `next_attempt_at = timing.now()`; `kind`/`target_status` pairs are enforced by the DB CHECK |
| `supersedeOpen(profileId, trx)` | same | marks the pending job `superseded` |
| `syncNow(jobId, actor, attempts)` | the three inline paths | `attempt(jobId, actor, attempts, dueOnly=false)` then reads the profile; returns `SyncReport { profile, status: 200\|202, identitySync?: "pending"\|"failed" }` (today's `syncOutcome`: `!locked` → `202 pending`; `synced` → `200`; `failed` → `202 failed`; else `202 pending`) |
| `processDue(jobId)` | worker loop | loads the job; returns unless it exists and is `pending`; `attempt(jobId, null, 1, dueOnly=true)`. **No kind filter** — all three kinds |
| `listDueJobIds(limit)` | worker loop | `listDuePendingJobs(limit, new Date(timing.now()))`, `suspension` rows first |

What stays kind-specific and where: the **decision transaction** (preconditions, profile column writes, flag port, audit) stays in
each module's service; `VerificationService` keeps `decide`/`submitInTransaction`/`finishSubmit` but replaces its private
sync code with `identitySync.enqueue/supersedeOpen/syncNow` (3 inline attempts as today); `AdminDoctorsService` does the same
with 3 attempts. **The engine knows no preconditions**; it knows only the job, the profile's `identity_sync_status`, and the kind policy.

`worker-loops.ts` builds one `IdentitySyncService` and passes it to `buildIdentitySyncLoop` and to `new VerificationService(db, audit, storage, identity, env, identitySync)`.
The loop keeps its name `identity-sync` (`node dist/worker.js --once identity-sync` unchanged), batch 50, one job at a time,
abort check between jobs, `identity_sync_jobs_processed` metric. **It does not dispatch by kind**: `processDue` reads the job and
the engine selects `policies[job.kind]` — adding a kind is a policy row plus a DB CHECK, never a new loop.

**Guarding the refactor (behavior-preserving step first, no new kind in the same step):**
1. Before touching code, run and record green: `tests/unit/app/verification/*`, `tests/integration/verification.test.ts`.
2. Move code; the existing tests are the guard and may change only mechanically: constructor wiring (extra `IdentitySyncService`),
   import paths, `service.processDueSyncJob` → `identitySync.processDue`, `service.listDueSyncJobIds` → `identitySync.listDueJobIds`, mocks of
   moved repo functions repointed to `identity-sync.repo`. **No assertion is weakened or removed.** The only assertion change allowed is the additive
   `kind: "verification"` field in the two `alertLogsCarryIds` log expectations.
3. The sync-related unit tests (`staleSyncResultCannotMarkNewDecisionSynced`, `twoWorkersHonourBackoff`, `finishSubmitBuildsNoView`, `alertLogsCarryIds`, the `verification-worker` loop tests) are **ported** to `tests/unit/app/identity-sync/` with identical bodies, then extended per kind (§9).
4. Run the full unit + integration suites green; only then add the new modules. The orchestrator commits the extraction separately from the feature.

Intentional behavior changes inside the extraction (each has its own test): (a) kind-agnostic selection (no `kind='verification'` filter);
(b) policy-driven alerts (§5.3); (c) Identity `reason` clamp to 500 code points and fallback `job.reason ?? job.kind` (was `?? "verification"`) — fixes a latent infinite-retry for verification reasons > 500 chars (S4);
(d) `SyncTiming` injection replaces `Date.now()`/`Math.random()` and the due list takes `now` as a parameter instead of the DB clock;
(e) suspension jobs listed first; (f) `kind` added to the engine's alert log lines. Everything else (locking, superseding, backoff honouring on the worker path, audit actor `system` for worker attempts, `identity_sync.pending` audited once at the first transient failure) is unchanged.

### 5.2 The attempt (unchanged algorithm, now kind-agnostic)

`attempt(jobId, actor, attempts, dueOnly)`: read the job (absent → `NotFound`); `withSessionAdvisoryLock(db, 1102, job.doctor_profile_id, …)` — `undefined` (lock refused, pool pin limit or acquire timeout) = "someone else is syncing", reported as `locked:false`. Inside the lock, re-read: if the job is no longer `pending` or is not the profile's open job → mark `superseded` and stop (the stale target is never sent). Worker path: if `next_attempt_at > timing.now()` stop (another worker just rescheduled). Call `identity.setUserStatus(job.doctor_user_id, job.target_status, clamp(job.reason ?? job.kind), job.actor_user_id, job.request_id ?? currentRequestId, attempts)` **outside any DB transaction**. Then one transaction: lock the profile `FOR UPDATE`, re-check the job is still the open one, and apply exactly one of:

| Identity outcome | Job | Profile `identity_sync_status` | Audit (actor: admin when inline, `system` from the worker) | Log |
|---|---|---|---|---|
| `applied` | `succeeded`, `succeeded_at`, `consecutive_failures=0`, `attempts += n` | `synced` | `identity_sync.synced` `{ jobId }` | — |
| `rejected-transition` (409) | `failed`, `last_error_code='InvalidStatusTransition'`, `attempts += n` | `failed` | `identity_sync.failed` `{ jobId }` | `error` `IdentitySyncTransitionRejected` `{ code, kind, jobId, profileId }` |
| `transient` | `attempts += n`, `consecutive_failures += 1`, `last_error_code`, `next_attempt_at = now + backoffMs(attempts_before, random, cap)` | unchanged (`pending`) | `identity_sync.pending` `{ jobId }` only when `attempts_before = 0` | kind policy alerts (§5.3) |

A crash or DB error after Identity answered `applied` leaves the job `pending`; the worker repeats the idempotent Identity call
(`same status → 200 no-op`) and converges. `last_error_code` stores the HTTP status or error class, never a body.

### 5.3 Per-kind behavior (`sync-policy.ts`)

| | `verification` (Case 1) | `suspension` (Case 3) | `reinstatement` (Case 4) |
|---|---|---|---|
| Inline attempts | 3 | 3 (≈ 6 s worst case, S3) | 3 |
| Worker attempts | 1 per job per tick | 1 per tick, **listed first** | 1 per tick |
| Attempt cap | none | **none (unbounded)** | none |
| Backoff | `backoffMs(attempts, random, IDENTITY_SYNC_RETRY_CAP_SECONDS·1000)` = 200 ms·2ⁿ ±20 %, cap 60 s | same | same |
| Transient alert | `IdentityApprovalSyncPending` (error log, ticket) once, by the first attempt that finds the job older than `IDENTITY_SYNC_ALERT_AFTER_SECONDS` | **none time-based**; `IdentitySuspensionSyncFailing` (error log, **page**) when the new `consecutive_failures` is 3 and again at 13, 23, … `{ jobId, profileId, consecutiveFailures, lastErrorCode }` | `IdentityReinstatementSyncPending` (error log, ticket) once, same rule as verification, 900 s |
| Identity 409 | job/profile `failed`, `IdentitySyncTransitionRejected` | same (**page**); local suspension kept | same; local reinstatement kept (profile unsuspended, unbookable) |
| Caller response | 200 / 202 | 200 / 503 | 200 / 202 |

"Consecutive failures" counts engine attempts (one inline phase = 1, each worker tick = 1) — the existing counter semantics, so verification is
unchanged. With the 10 s poll the page therefore fires roughly 20–30 s after a suspension that cannot reach Identity. Alert rules match the
log lines (`message` = alert name); `kind` distinguishes page vs ticket for `IdentitySyncTransitionRejected` (suspension → page; the other kinds
follow the existing ticket/page rule in `resilience.md`).

## 6. Error codes

| Code | HTTP | When (this module) |
|---|---|---|
| `ValidationFailed` | 400 | bad `doctorUserId`; `reason` missing, < 3 or > 2000 code points, control characters; unknown property |
| `Unauthorized` / `TokenExpired` | 401 | missing, invalid or expired bearer token |
| `Forbidden` | 403 | caller is not `admin`, or the admin token's account state is not `active` |
| `NotFound` | 404 | no live `doctor_profiles` row for `doctorUserId` (also: the id belongs to a non-doctor or a soft-deleted profile) |
| `InvalidTransition` | 409 | suspend: not (`approved` + `synced`); reinstate: suspended but not `synced` |
| `IdentityUnavailable` | 503 | suspend committed locally, Identity unconfirmed or 409-rejected (`suspension` marker + `data`); never returned by reinstate |
| `IdempotencyConflict` / `Conflict` | 422 / 409 | same `Idempotency-Key` with a different body / first request still in flight (`Retry-After: 1`) |
| `RateLimited` | 429 | `admin-doctors-write` exceeded |
| `InternalError` | 500 | unhandled, including an audit or port failure (the transaction rolled back) |

No new code is added; `InvalidTransition` and `IdentityUnavailable` exist in `ErrorCode` and the contract. Retry semantics for clients: `503` and `202` do
not set `Retry-After` (not in the contract); the client may repeat the same call at any time (BR8); `409 InvalidTransition` on reinstate while a suspension is unsynced is retryable by the admin only after ops resolves the sync.

## 7. Security & privacy

### 7.1 RBAC summary

Admin only, no ownership predicate, token `status=active`. Care re-checks nothing from the body. Doctors cannot suspend or reinstate anyone (including themselves); patients and anonymous callers are denied. A suspended doctor remains blocked locally at commit by the existing guards, independent of token expiry (CLAUDE.md → Authentication). The acting admin id goes to Identity as `actorUserId` (data, not authorization).

### 7.2 Audit (same transaction as the change, entity type `doctor_profile` unless stated; metadata ids/statuses only)

| Action | Entity id | Metadata | Actor |
|---|---|---|---|
| `doctor.suspended` | profile id | `{ doctorUserId, jobId, flaggedCount, reasonLength, fromSyncStatus: "synced", toSyncStatus: "pending" }` | admin |
| `consultation.flagged_for_followup` (one per flagged id, none today) | **consultation id**, entity `consultation` (S5) | `{ doctorProfileId, followupReason: "doctor_suspended" }` | admin |
| `doctor.reinstated` | profile id | `{ doctorUserId, jobId, reasonLength, fromSyncStatus: "synced", toSyncStatus: "pending" }` | admin |
| `identity_sync.pending` / `synced` / `failed` | profile id | `{ jobId }` | admin when inline, `system` from the worker |

No-op calls write nothing. Reasons are excluded (S2); `reasonLength` is a number. All keys are camelCase scalars and pass the recorder (`isRedactedKey`, ≤ 20 keys).

### 7.3 Never logged

`reason` text (request, `suspension_reason`, job reason), Identity response bodies, tokens, display names. Logs carry ids, statuses, outcomes
(`doctor_suspension_applied { doctorProfileId, jobId, identitySyncStatus }`, `doctor_reinstatement_applied`, engine alert lines). `last_error_code` is a status/class only.
Rate limit: 30/min per admin (state-changing, each can hold a pinned advisory-lock connection for several seconds). No files, no URLs in DTOs (not applicable).

## 8. Performance

- **Request cost, healthy path** (suspend): decision transaction = 1 `SELECT … FOR UPDATE` (partial unique index on `user_id`) + 1 supersede `UPDATE` (open-job index) + 1 `UPDATE … RETURNING` (PK) + 1 job `INSERT` + `2 + n_flagged` audit `INSERT`s; engine = 2 job reads + lock/unlock + 1 Identity call + 1 transaction (profile `FOR UPDATE`, 2 job reads, job `UPDATE`, profile `UPDATE`, audit `INSERT`) + 1 profile read. About 15 statements, no N+1 (flagging is one provider call over `= ANY`). Target DB portion p95 < 100 ms; the request is bounded by the inline budget (≤ 6.7 s worst case, fast on an instant failure). No Care budget in "Performance rules" covers admin writes; these are this module's.
- **Worker tick:** one lock + at most one Identity attempt per due job, ≤ 50 jobs. During a black-hole outage a tick can take up to 50 × 2 s, so suspension jobs are listed first (`ORDER BY (kind='suspension') DESC, next_attempt_at, id`); `EXPLAIN` the due query on a table with 10k terminal and 50 pending rows and confirm `idx_identity_sync_jobs_pending_next_attempt_at` is used for the filter. Locks pin at most `pool.max − 1` connections (`withSessionAdvisoryLock`); the worker pool is 4.
- Memory/Redis: none; idempotency is Tier 2 and skipped when Redis is down (BR7/BR13 still make retries safe).

## 9. Test plan

Deterministic by construction: no wall-clock assertions in the parallel suite. `IdentitySyncService` takes a `SyncTiming` fake (`FakeClock.now/advance/set`, `random = () => 0.5`);
`IdentityClient` is built with `sleep: () => Promise.resolve()` (existing pattern); tests assert **counts of fake-server calls and database state**, never elapsed
milliseconds. "Make the job due" = `clock.advance(ms)` (never a real sleep, never `setTimeout`); the 15-minute alert uses `clock.advance(901_000)`. Asserting `next_attempt_at` compares to `clock.now() + backoffMs(…)` computed from the same fake.
Concurrency tests assert invariants (one job, one audit row, one Identity PATCH), not which of two racing responses is faster.

### 9.1 Test helper changes

`tests/helpers/fake-identity-server.ts`: allow `suspended → active` (today it answers 409); record PATCH bodies (`statusBodies: { userId, status, reason, actorUserId }[]`); reject `reason` longer than 500 code points with `400 ValidationFailed` (mirrors Identity's contract, catches S4); `statusFailureCode` and `forceConflict` already exist. New `FakeClock` helper in `tests/helpers/`. Fixtures: an approved + synced + bookable doctor (profile row via `ownerDb`, one active consultation type, Identity user `active`).

### 9.2 Unit (`tests/unit/`)

`tests/unit/app/identity-sync/` — ported verification tests (identical bodies) plus:
- `processDue` handles `verification`, `suspension` and `reinstatement` jobs (no kind filter); a non-pending job is ignored.
- `listDueJobIds` returns suspension ids first and passes `now` from the injected timing.
- suspension: `IdentitySuspensionSyncFailing` logged at consecutive failure 3 and 13, not at 1, 2, 4; no time-based alert; reset by success.
- reinstatement: `IdentityReinstatementSyncPending` once after 900 s of fake time, not before; verification keeps `IdentityApprovalSyncPending`.
- 409 for each kind: job and profile `failed`, `identity_sync.failed` audited, `IdentitySyncTransitionRejected` logged with `kind`, `setUserStatus` not called again on the next `processDue`.
- transient: attempts/consecutive_failures/next_attempt_at from the fake clock; `identity_sync.pending` audited only at `attempts_before = 0`.
- a superseded or stale job is marked `superseded` and never sent (each kind); lock refused → `locked:false` → `202 pending`.
- reason clamp: 600-code-point and emoji reasons reach `setUserStatus` as exactly 500 code points; null reason falls back to the kind; ≤ 500 passes untouched.
- `pkg/utils/code-points` `truncateCodePoints` (surrogate pairs never split).

`tests/unit/app/admin-doctors/`:
- service `suspend`: absent → `NotFound`; each of draft/submitted/rejected/approved+pending/approved+failed → `InvalidTransition` with no write, no job, no audit; already suspended → no-op without writes; happy path order (lock → supersede → apply → flag → enqueue → audit) inside one `transaction`; audit or port failure propagates (rollback); `syncNow` called with 3 attempts after the transaction callback resolved; synced → confirmed; pending/failed/lock-not-held → not confirmed with `flaggedConsultationIds` from the port.
- service `reinstate`: absent → `NotFound`; not suspended → no-op carrying the current `identitySyncStatus`; suspended + pending/failed → `InvalidTransition`; happy path clears and enqueues `reinstatement` with target `active`, port not called; outcomes 200 / 202 pending / 202 failed.
- audit entries: names, entity types, metadata keys/values (no `reason` key, `reasonLength` number), flagged rows use entity `consultation`.
- policies/routes: both routes are `admin`, `owner: none`, `audit: admin-action`; every route has `authorize`; `assertRoutesAuthorized` passes.
- DTOs: `reason` 2 chars → fail, 3 → ok, 2000 ok, 2001 fail, control chars fail, unknown property fail, `doctorUserId` 0/-1/`abc` fail; response DTOs match the contract schemas (`SuspensionResult`, `ReinstatementResult`, ISO dates, ids as numbers).
- controller mapping: unconfirmed → `IdentityUnavailable` with `suspension` marker and `data`; `sendSuccess` `siblings` renders `identitySync` next to `data`.
- `NoopSuspensionImpactProvider` returns `[]` for both methods.

### 9.3 Integration (`tests/integration/admin-doctors.test.ts`; real Postgres, Redis, wiring; only Identity faked)

| Scenario | Assertions |
|---|---|
| **RBAC matrix** (`it.each` both routes) | no token 401; expired 401 `TokenExpired`; patient 403; doctor (other and the target themself) 403; admin allowed; admin token `status != active` 403; envelope code asserted via `expectErrorEnvelope` |
| Suspend happy path | 200 body matches `SuspensionResult`; Identity user `suspended`; one PATCH with `{ status: suspended, actorUserId: admin, reason }`, `X-Request-Id` forwarded; profile `suspended_at/by/reason` set, `synced`; job `succeeded`; audit `doctor.suspended` + `identity_sync.synced` (actor admin), no `reason` in metadata; doctor `isBookable=false`, `PATCH /api/doctors/me` → 403 |
| **Identity down → 503 + job** | `503` `IdentityUnavailable`, `suspension` marker, `data.identitySyncStatus=pending`; fake saw exactly 3 PATCH attempts; profile suspended locally (`pending`); job `pending`, `attempts=3`, `consecutive_failures=1`; audit `doctor.suspended` + `identity_sync.pending`; doctor unbookable and blocked from doctor actions |
| **Recovery** | `down=false`, `clock.advance`, loop tick returns `done`; job `succeeded`, profile `synced`, Identity `suspended`, `identity_sync.synced` with actor role `system`; a repeated suspend is the 200 no-op with `synced` |
| Unbounded retry | 5 consecutive failing ticks keep the job `pending` (no cap), `next_attempt_at` follows the fake clock, `IdentitySuspensionSyncFailing` logged once at tick 2 (failure 3) |
| **409 non-retryable** | `forceConflict`: `503` with `data.identitySyncStatus=failed`; job `failed`, profile `failed`, local suspension kept; page log with `kind=suspension`; a later tick makes **no** further PATCH (call count unchanged); suspend again → no-op, reinstate → `409 InvalidTransition` |
| Suspend preconditions | draft, submitted, rejected, approved+pending, approved+failed → 409 and no job/audit/PATCH; no profile / soft-deleted profile / patient user id → 404 |
| Already suspended | second suspend when `synced` → 200; while `pending`/`failed` → the same 503 body; never a new job/audit/PATCH; `flaggedConsultationIds` from the port |
| Suspend during pending reinstatement (S7) | reinstatement unsynced → suspend 409 `InvalidTransition`, no job/audit/PATCH |
| **Concurrency** | two parallel suspends: exactly one job, one `doctor.suspended` row, one Identity PATCH; parallel suspend + reinstate: reinstate sees the committed suspension (`pending` → 409, or `synced` → proceeds) and never produces two open jobs; two parallel reinstates: one job |
| Supersede | a stray open verification job on a synced profile is `superseded` by the suspension transaction and its target never reaches Identity |
| Flag port | provider rebinding returns `[11,12]`: response lists them, two `consultation.flagged_for_followup` rows (entity `consultation`), provider throwing rolls back profile, job and audit |
| Audit atomicity | a recorder that throws on `doctor.suspended` leaves the profile unsuspended, no job, no Identity call, `500` |
| Reinstate happy path | 200, Identity `active`, profile unsuspended + `synced`, job `succeeded`, audit `doctor.reinstated` + `identity_sync.synced`; doctor `isBookable=true` again |
| **Reinstate Identity down** | `202` with top-level `identitySync:"pending"` and `data`; 3 PATCH attempts; profile `suspended_at NULL`, `pending`; `isBookable=false` and the doctor-action guards pass; job `reinstatement`/`active` pending |
| **Bookability gate while pending** | `GET /api/doctors/me` shows `isSuspended=false`, `isBookable=false` until the tick syncs it, then `true`; flags (port) are untouched by reinstate |
| **Blind retry of reinstate** | repeat while pending → `202 identitySync:"pending"` (no-op re-report, S6; `failed` → `202 failed`), exactly one job, one `doctor.reinstated`, no extra PATCH; repeat after sync → 200 `synced`; same `Idempotency-Key` replays the stored `202` |
| Reinstate 409 | `forceConflict`: `202 identitySync:"failed"`; job/profile `failed`; page log; no retry on later ticks; profile stays unsuspended and unbookable |
| Reinstate preconditions | suspended + pending/failed → 409 and no state change; not suspended with no unsynced reinstatement → 200 no-op; unknown → 404 |
| 15-minute alert | `clock.advance(901_000)` then one failing tick logs `IdentityReinstatementSyncPending` once |
| Reason handling | 2000-char reason: stored in full in `suspension_reason`/job, Identity receives 500 code points and answers 200; a verification `reject` with a 600-char reason now reaches `synced`; the synthetic reason marker appears in no captured log line and no `audit_logs.metadata` |
| Idempotency | same key + body replays the stored 200/202; same key + different body → 422 `IdempotencyConflict`; a `503` is not stored (a retry re-executes as the no-op); Redis down → routes still work |
| Rate limit | the 31st request in a minute by one admin → 429 `RateLimited` |
| Worker priority | with 3 verification and 1 suspension job all due, `listDueJobIds` returns the suspension first; the loop processes all four and reports `done` |
| Verification regression | `tests/integration/verification.test.ts` unchanged except wiring; passes (two-worker backoff, 409, pending guard, concurrency) |
| Contract conformance | statuses declared by `suspendDoctor` (200/400/401/403/404/409/429/500/503) and `reinstateDoctor` (200/202/400/401/403/404/409/429/500) read from `contracts/openapi.yaml` via `tests/helpers/contract.ts`; `SuspensionPending` and `ReinstatementResult` schema keys asserted against live responses; no secret/URL in any body |
| Boot | `assertRoutesAuthorized` accepts the new router; `container` resolves the worker's `IdentitySyncService` |

Rule-to-test map: BR1 preconditions · BR2/BR20 happy path + audit atomicity · BR3 503 · BR4 unbounded retry · BR5 409 · BR6 alert unit · BR7/BR13 no-op · BR8 blind retry · BR9/BR10/BR11 reinstate rows · BR12 supersede · BR15 concurrency · BR16 ported two-worker/lock tests · BR17 port · BR18 request-id/actor assertions · BR19 reason handling.

## 10. Out of scope

Cancelling or rescheduling consultations (flag only); the real flagging implementation and `needs_admin_followup` columns (`consultations`); doctor-facing notices; an admin console, list/search of suspended doctors, an admin "retry sync now" endpoint (ops use the runbook SQL); a sweeper (S1 makes it unnecessary); event publication (`doctor.suspended` events are future); reconciliation of Identity-originated status changes; any change to Identity; patient or admin account suspension (Identity's admin API); admin MFA.

## 11. Open questions

None. Owner decisions of 2026-10-09: **Q1** a no-op re-reports pending (S6: suspend no-op `503` while `identity_sync_status != synced`; reinstate no-op `202` while the latest `reinstatement` job is `pending`/`failed`); **Q2** suspend stays `409` while a reinstatement is unsynced (S7); **Q3** the Identity-bound reason is clamped to 500 code points in the engine, no contract change in either service (S4; tested, also fixes verification's latent defect).

### Contract changes required (applied by /develop first)
Edit `contracts/openapi.yaml` before any code:
1. `suspendDoctor` description step 0: replace "Suspending an already-suspended doctor is a **200 no-op** that returns the current state ..." with "an already-suspended doctor is a no-op: **200** when `identitySyncStatus='synced'`, otherwise **503 `IdentityUnavailable`** (`SuspensionPending`, `data.identitySyncStatus` `pending` or `failed`), because revocation is not confirmed". Update the `200` response description to match.
2. `suspendDoctor.x-audit-actions` -> `[doctor.suspended, consultation.flagged_for_followup, identity_sync.pending, identity_sync.failed, identity_sync.synced]`.
3. `reinstateDoctor` description step 0: replace "A doctor who is not suspended is a **200 no-op** ..." with "a doctor who is not suspended is a no-op: **200**, except **202** (`identitySync` `pending`/`failed`) while the latest `reinstatement` job is still `pending`/`failed`". Update the `200` and `202` response descriptions.
4. `components.schemas.SuspensionPending`: add `data` to `required`.

### Platform changes required (/system-design)
None. The alert names used here already exist in the hub observability table; Identity's 500-character `reason` limit is unchanged.

## Appendix A — documentation deltas for `/update-docs`

`docs/service-card.md` **will need updating** (two live admin endpoints, new module `identity-sync`, Case 3/4 now built, suspension/reinstatement jobs; the hub copy is refreshed only by `../vcare-hub/scripts/sync-from-spoke.sh`).
Also: new ADR `0021-identity-sync-engine-module.md` (shared engine, kind policy, `SyncTiming`; no new dependency); `architecture/integration.md` (Case 3/4: job inserted in the decision transaction, sweeper removed, 503 `failed` data, Q1 outcome), `architecture/resilience.md` (durable-jobs section, alert table: `IdentityReinstatementSyncPending`, suspension re-page rule), `architecture/api.md` and `rbac.md` (reinstate no longer "planned"), `architecture/data-model.md` (`identity_sync_jobs` owner module), `architecture/overview.md` (module map: `admin-doctors`, `identity-sync`), `runbook.md` (Case 3 and Case 4 alert rows, "Inspect a job" now covers all kinds, `--once identity-sync` retries every due job of any kind), `docs/INDEX.md`, `docs/system-design.md` router. ADR 0012's "history lives in `audit_logs`" is refined by S2 (reason text lives in job rows and `suspension_reason`, audit has `reasonLength`) — recorded in ADR 0021, ADR 0012 is not rewritten.

## Appendix B — ordered `/develop admin-doctors` tasks (build-order tag)

0. Contract edits §11 (contract first). 
1. [verify] Record the green baseline of verification unit + integration suites. 
2. [engine] Create `identity-sync` (enums, constants, types, repo, service, loop, `SyncTiming`), repoint `VerificationService`, `worker-loops.ts`, `bootstrap.ts`, tokens; port unit tests; full suites green (behavior-preserving + changes (a)–(f) each with a test). 
3. [lib] `pkg/utils/code-points.ts`, `sendSuccess` `siblings`, fake Identity server and `FakeClock` helpers. 
4. [2–3] `admin-doctors` enums, errors, types, entity-free repo. 
5. [4–5] DTOs. 
6. [7] Service + `NoopSuspensionImpactProvider`; register in `bootstrap.ts`. 
7. [8–11] Policies, controller, routes, mount in `src/routes.ts`. 
8. [12] Unit + integration + RBAC + contract + concurrency tests (§9). 
9. [13] Manual QA with CURL against the fake Identity (`/manual-qa`). 
10. [14] Docs per Appendix A.
