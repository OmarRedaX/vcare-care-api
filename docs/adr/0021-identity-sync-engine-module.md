---
title: "ADR 0021 — Identity-sync engine as its own module"
owner: care-team
service: care-service
status: accepted
diataxis: explanation
last_verified: 2026-10-09
tags: [adr, identity-sync, worker, suspension, reinstatement, verification, durable-jobs]
related: [adr-0004-cross-service-failure-policies, adr-0008-care-worker-component, adr-0012-doctor-reinstatement, adr-0017-generic-helpers-and-transaction-scoping, admin-doctors-spec, verification-spec]
---

# ADR 0021 — Identity-sync engine as its own module

Date: 2026-10-09 · Status: accepted · Builds on [ADR 0004](./0004-cross-service-failure-policies.md) and [ADR 0012](./0012-doctor-reinstatement.md) (does not change their failure policies)

## Context
Verification (Case 1) owned a private "call Identity, then record the result" engine inside `VerificationService`
(`attemptSync`, `syncOutcome`, `processDueSyncJob`) and a worker loop that only picked `kind='verification'` jobs.
Suspension (Case 3, must-not-degrade) and reinstatement (Case 4, retry-report-pending) need the same machinery: a durable
job inserted with the decision, a per-doctor advisory lock, a guarded Identity call outside any transaction, one result
transaction, backoff, and kind-specific alerts. Copying it into `admin-doctors` would duplicate the riskiest code in the
service; letting `admin-doctors` call `VerificationService` would invert the dependency (CLAUDE.md → Folder structure and layering).

## Decision
1. A new bounded context `src/app/identity-sync/` (no routes, no controller) owns the engine: enums, constants, types,
   `sync-policy.ts`, `IdentitySyncService`, the repository for `identity_sync_jobs` and its profile sync column, and the
   `identity-sync` worker loop. `verification` and `admin-doctors` call its **service** (`enqueue`, `supersedeOpen`, `syncNow`,
   `findLatestJob`); the worker calls `processDue` / `listDueJobIds`.
2. **The engine knows no preconditions.** Each module keeps its decision transaction (preconditions, profile columns, ports,
   audit) and hands the engine a job. The engine knows only the job, the profile's `identity_sync_status` and the kind policy.
3. **Adding a kind is a policy row plus a DB `CHECK` value.** `buildSyncPolicies(env)` maps each `IdentitySyncJobKind` to a
   `SyncKindPolicy`; the loop never branches on kind. Today: `verification` and `reinstatement` raise a ticket alert once
   after `IDENTITY_SYNC_ALERT_AFTER_SECONDS` unsynced (`IdentityApprovalSyncPending`, `IdentityReinstatementSyncPending`);
   `suspension` has no time rule and pages on consecutive failures 3, 13, 23, ... (`IdentitySuspensionSyncFailing`).
4. **Time and randomness are injected** (`TOKENS.SyncTiming`, `{ now(), random() }`), so tests drive backoff and the 15-minute
   alert with a fake clock instead of sleeps. Production binds `SYSTEM_SYNC_TIMING`.
5. **The Identity-bound `reason` is clamped to 500 code points** (Identity's `StatusChangeRequest.reason` limit) by the engine
   (`pkg/utils/code-points.ts`); Care stores the full text (up to 2000) in `doctor_profiles.suspension_reason` and
   `identity_sync_jobs.reason`. This also fixes a latent defect: a verification reason of 501-2000 characters made Identity
   answer `400` for ever and the job retried for ever.
6. **The job row is inserted in the decision transaction** for all three kinds (supersedes the "sweeper" idea in
   `integration.md` / `resilience.md`: there is no commit-to-insert window to sweep).
7. Due jobs are listed **suspension first** (`ORDER BY (kind = 'suspension') DESC, next_attempt_at, id`) so a black-hole
   outage that makes a tick slow never queues the security-critical kind behind the others.
8. The reason text is never written to audit metadata or logs (audit carries `reasonLength`); this refines, without
   rewriting, ADR 0012's "history lives in `audit_logs`": who/when is in `audit_logs`, the text is in the profile and job rows.

No new dependency, no new environment variable, no migration (the table and its `CHECK` constraints already allow all three kinds).

## Consequences
- One engine, one lock namespace (`1102`, same value as before), one worker loop name (`identity-sync`, so
  `node dist/worker.js --once identity-sync` retries every due job of any kind).
- Intentional behavior changes inside the extraction, each covered by a test: kind-agnostic selection, policy-driven alerts,
  the reason clamp and fallback `job.reason ?? job.kind`, `SyncTiming` injection (the due list takes `now` from it instead of
  the database clock; transient failures stamp `updated_at` from it too), suspension-first ordering, and `kind` on the engine's alert log lines.
- Everything else (locking, superseding, backoff honoured on the worker path, audit actor `system` for worker attempts,
  `identity_sync.pending` audited once at the first transient failure) is unchanged; the existing verification tests moved
  mechanically and no assertion was weakened.
- `admin-doctors` stays a thin module; a future kind (for example a patient-facing status sync) needs a policy row, not a loop.

## Alternatives considered
- **Keep the engine in `verification` and import it from `admin-doctors`.** Rejected: cross-module repository or private-method
  coupling, and verification would own suspension semantics.
- **Copy the engine per module.** Rejected: three copies of lock, supersede and backoff logic diverge; Case 3 must not degrade.
- **A generic `lib/` job runner.** Rejected: the engine reads and writes `doctor_profiles` and audit rows (Care rules); `lib/`
  must not import `app/`. Only the domain-free pieces (`backoffMs`, `withSessionAdvisoryLock`, code-point truncation) live in `lib/` and `pkg/`.
