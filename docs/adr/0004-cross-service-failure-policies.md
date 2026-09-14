---
title: "ADR 0004: Per-case failure policies for calls to identity-service"
owner: care-team
service: care-service
status: accepted
date: 2026-09-14
diataxis: explanation
last_verified: 2026-09-14
tags: [adr, decision, integration, resilience, identity]
related: [integration, resilience, runbook]
---

# ADR 0004 — Case 1 retry-report-pending, Case 2 degrade, Case 3 must-not-degrade

- **Status:** Accepted • **Date:** 2026-09-14 • **Deciders:** care-team

## Context
Care calls identity-service synchronously in three situations (PRD §5), all through the same client, service-token
flow, 2 s timeout, and backoff:
1. **Verification** — an approval/rejection/re-open must change the account status so the doctor can (or cannot) work.
2. **Hydration** — search and lists need display names and avatars that only Identity stores.
3. **Suspension** — a suspended doctor's sessions must be revoked; a live session is a patient-safety problem.

The consequence of a failed call differs completely between them. MVP is HTTP-only with no message bus.

## Decision
Choose the failure policy from the business consequence, per case, and declare it in the contract
(`x-failure-policy`):

| Case | Policy | Behaviour on failure |
|---|---|---|
| 1 Verification | **retry-report-pending** | commit the decision with `identity_sync_status='pending'`; 3 inline attempts; then 202 `identitySync: "pending"` and a durable `identity_sync_jobs` retrier; alert after 15 min; the doctor stays unbookable until synced |
| 2 Hydration | **degrade** | serve Redis cache (300 s); misses render `displayName: null`, `profileHydrated: false`; 1 retry max; never a 5xx; never on the booking path |
| 3 Suspension | **must-not-degrade** | commit the local suspension and follow-up flags first (bookings and doctor actions blocked); ~6 s inline attempts; then a durable job with no attempt cap (backoff ≤ 60 s); respond 503 `IdentityUnavailable` until confirmed; page after 3 consecutive failures |

For Cases 1 and 3, a non-retryable Identity answer (`409 InvalidStatusTransition`) stops retries, sets
`identity_sync_status='failed'`, and alerts (a page for Case 3), because retries cannot fix state drift.

## Consequences
- ➕ Search and booking survive Identity outages; the hot path has no hard dependency on Identity.
- ➕ A suspension can never be reported as complete while sessions may still be live; Care's local block is immediate.
- ➕ Verification decisions are never lost; bookability waits for Identity, so the two services cannot disagree in the
  dangerous direction (bookable in Care, not active in Identity).
- ➕ Policies are explicit in the contract and reviewable; choosing the wrong one is a Critical review finding.
- ➖ Three code paths and a durable job table to operate; the runbook must cover each alert.
- ➖ Admins see 202/503 responses and must understand "pending" states in the console.
- ➖ The Identity-originated status-change gap remains until events or reconciliation exist.

## Alternatives considered
- **Uniform fail-fast** (any Identity error → 5xx) — rejected: an Identity blip would take down search and every list,
  making Identity a single point of failure for the marketplace, contrary to PRD §4.4.
- **Uniform degrade** (log and continue) — rejected: a suspension would be silently incomplete with sessions alive, and
  an approval could leave a doctor bookable while their account is not active.
- **Async events for all three** (outbox + bus, eventual consistency) — rejected for MVP: no bus in scope; Case 3 needs a
  synchronous confirmation to tell the admin whether sessions are revoked; hydration is a read that events do not
  replace. Events remain the candidate for propagating status changes later ([future.md](../architecture/future.md)).
