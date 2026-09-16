---
title: "ADR 0012: Admin doctor reinstatement with a retry-report-pending policy (Case 4)"
owner: care-team
service: care-service
status: accepted
date: 2026-09-15
diataxis: explanation
last_verified: 2026-09-15
tags: [adr, decision, integration, suspension, reinstatement, identity]
related: [integration, resilience, rbac, api, adr-0004-cross-service-failure-policies, hub-adr-0009-doctor-reinstatement-via-care]
---

# ADR 0012 — Admin doctor reinstatement with a retry-report-pending policy (Case 4)

- **Status:** Accepted • **Date:** 2026-09-15 • **Deciders:** care-team

## Context
A suspended doctor could not be reinstated through any API: Identity's admin route refuses doctor targets (hub ADR
0006) and its internal status route refuses `suspended → active`. The only path was a manual ops procedure that
edits both services and risks drift. Hub ADR 0009 makes Care the initiator of reinstatement.

## Decision
- `PATCH /api/admin/doctors/:id/reinstate` `{ reason }` — role `admin`, `Idempotency-Key` optional, audited
  (`doctor.reinstated`).
- **Precondition:** `suspended_at IS NOT NULL` and `identity_sync_status='synced'` (the suspension reached Identity);
  otherwise `409 InvalidTransition`. Reinstating a doctor who is not suspended and synced-active → `200` no-op.
- **One transaction:** clear `suspended_at` and `suspension_reason` (history lives in `audit_logs`), set
  `identity_sync_status='pending'`, write the audit row. Consultations flagged `needs_admin_followup` at suspension
  **stay flagged** — the admin resolves them explicitly.
- **Call** `PATCH /internal/users/:id/status` `{ status: "active", reason, actorUserId }` (new provider transition
  `suspended → active`, identity contract change first).
- **Failure policy — retry, report pending** (Case 1 policy): 3 inline attempts; success → `synced`, `200`; otherwise
  `202 { identitySync: "pending" }` and an `identity_sync_jobs` row with `kind='reinstatement'`; ticket alert after
  15 min unsynced; Identity `409 InvalidStatusTransition` → `failed`, page.
- **Bookability gate unchanged:** the doctor is bookable only when `suspended_at IS NULL` **and**
  `identity_sync_status='synced'`, so a pending reinstatement keeps the doctor blocked.
- A newer suspension supersedes an open reinstatement job (and vice versa), as for Cases 1 and 3.

## Consequences
- ➕ No manual cross-service edits; audit, retries, and alerts in one place (Care).
- ➕ Safe direction on failure: the doctor stays blocked until Identity agrees.
- ➖ Contract changes in both services (provider first); `identity_sync_jobs.kind` and `target_status` checks widen.
- ➖ The admin console must render a pending reinstatement.

## Alternatives considered
- **Must-not-degrade (Case 3 policy)** — rejected: reinstatement restores access, it is not security-critical; paging
  on it adds ops load for no safety gain.
- **Re-verification (doctor resubmits the application)** — rejected: a mistaken suspension would force full
  re-credentialing.
- **Stay ops-only** — rejected: manual drift risk between two databases.
