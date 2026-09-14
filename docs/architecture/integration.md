---
title: Cross-Service Integration
owner: care-team
service: care-service
status: draft
diataxis: explanation
last_verified: 2026-09-14
tags: [integration, identity, service-token, case-1, case-2, case-3]
related: [resilience, rbac, runbook, adr-0004-cross-service-failure-policies, future]
---

# Cross-Service Integration (Care → Identity)

Care is the **consumer** in all three platform integration cases. All calls go through `lib/identity-client`.
Implementation guidance: the **`cross-service-integration`** skill. Platform view: `../vcare-hub/architecture/landscape.md`.
Identity's contract (synced): `../vcare-hub/contracts/identity-service.openapi.yaml`.

| Local endpoint | Identity | Port |
|---|---|---|
| JWKS | `GET http://localhost:3000/.well-known/jwks.json` | public listener |
| Token, users, status | `http://localhost:3100/internal/*` | internal listener |

## User-token verification (no call per request)
Identity signs EdDSA access tokens (15 min). Care verifies them locally against the JWKS cached in memory,
refreshing on an unknown `kid` at most once per minute, and requires `iss=vcare-identity`, `aud` ∋ `vcare-care`,
`typ=user`, unexpired. If the JWKS cannot be fetched and no cached key matches → `401 Unauthorized`; verification
is never skipped.

## Service-token flow

```mermaid
sequenceDiagram
    participant IC as Care lib/identity-client
    participant ID as Identity :3100
    Note over IC: cache empty or now >= exp - 30s
    IC->>ID: POST /internal/auth/token<br/>grant_type=client_credentials, client_id, client_secret,<br/>scope="users:read users:status:write", audience=vcare-identity
    ID-->>IC: { access_token (typ=service, 300 s), token_type: Bearer, expires_in: 300 }
    Note over IC: cache; concurrent refreshes single-flighted
    IC->>ID: GET /internal/users?ids=… (Authorization: Bearer service token, X-Request-Id)
    alt 401
        ID-->>IC: 401
        IC->>ID: fetch a new token once, retry the call once
    end
```
The acting admin travels as data (`actorUserId`) for Identity's audit trail; it never grants authorization.
`SERVICE_CLIENT_SECRET` has no default and is never logged.

**Inbound:** `GET /internal/doctors/{userId}/summary` on Care's internal listener requires `typ=service`,
`aud` ∋ `vcare-care`, scope `doctors:read`. No MVP service client holds `doctors:read`; the endpoint serves admin
tooling and the Phase-2 AI service once a client is provisioned in Identity.

## Case 1 — Verification unlocks the account (retry, report pending)
Triggers: `PATCH /admin/applications/:id/approve` (→ `active`), `/reject` (→ `rejected`), `/reopen` and a doctor's
resubmission `rejected → submitted` (→ `pending`).

```mermaid
sequenceDiagram
    participant A as Admin
    participant C as Care
    participant DB as Care DB
    participant ID as Identity
    A->>C: PATCH /admin/applications/12/approve
    C->>DB: BEGIN; verification_status='approved', reviewed_by, review_note, decided_at,<br/>identity_sync_status='pending'; audit verification.approved; COMMIT
    loop up to 3 attempts, 2 s timeout, backoff 200 ms·2^n ±20%
        C->>ID: PATCH /internal/users/204/status {status: active, reason, actorUserId}
    end
    alt 200
        C->>DB: identity_sync_status='synced'
        C-->>A: 200 application
    else transient failures exhausted
        C->>DB: INSERT identity_sync_jobs (kind=verification, status=pending, next_attempt_at)
        C-->>A: 202 { identitySync: "pending" }
        Note over C: background retrier continues; alert IdentityApprovalSyncPending after 15 min
    else 409 InvalidStatusTransition (non-retryable)
        C->>DB: identity_sync_status='failed'; job status='failed'
        C-->>A: 202 { identitySync: "failed" }
        Note over C: alert IdentitySyncTransitionRejected; admin console shows it
    end
```
- The decision is **kept** in every branch; Identity owns the account state, Care owns the medical judgment.
- The doctor is **not bookable** until `verification_status='approved'` **and** `identity_sync_status='synced'`.
- Identity's status PATCH is idempotent, so blind retries are safe.

## Case 2 — Batch profile hydration (degrade, never fail)
Used by search, doctor profile, consultation lists, waiting room, calendar, the admin application queue.

```mermaid
sequenceDiagram
    participant U as Client
    participant C as Care
    participant R as Redis
    participant ID as Identity
    U->>C: GET /api/doctors?specialty=dermatology
    C->>C: SQL page of bookable doctors (no Identity data needed)
    C->>R: MGET identity:user:<id> for distinct ids on the page
    alt misses exist
        C->>ID: GET /internal/users?ids=… (≤ 100 per call, 2 s timeout, 1 retry)
        alt 200
            C->>R: SETEX identity:user:<id> 300 {fullName, avatarUrl, status}
        else timeout / error
            C->>C: metric identity_hydration_degraded++
        end
    end
    C-->>U: 200 doctors (misses: displayName=null, avatarUrl=null, profileHydrated=false)
```
- One call per page (chunked at 100 ids), never per row.
- Mapping: Identity `fullName` → Care `displayName`; `avatarUrl` unchanged; `status` is used **only** to hide
  non-active doctors from search when the cached data is fresh — never for authorization.
- A Case-2 outage never produces a 5xx; booking never waits on hydration.

## Case 3 — Suspension revokes sessions (must not degrade)

```mermaid
sequenceDiagram
    participant A as Admin
    participant C as Care
    participant DB as Care DB
    participant ID as Identity
    A->>C: PATCH /admin/doctors/204/suspend {reason}
    alt already suspended
        C-->>A: 200 no-op (current state)
    else not approved + synced
        C-->>A: 409 InvalidTransition
    end
    C->>DB: BEGIN; suspended_at, suspension_reason, identity_sync_status='pending';<br/>flag future booked/waiting consultations needs_admin_followup;<br/>audit doctor.suspended; COMMIT
    Note over C: from here no bookings and no doctor actions in Care
    loop inline attempts for ~6 s
        C->>ID: PATCH /internal/users/204/status {status: suspended, reason, actorUserId}
    end
    alt 200 (Identity revoked all refresh tokens in one transaction)
        C->>DB: identity_sync_status='synced'
        C-->>A: 200 SuspensionResult
    else transient failures
        C->>DB: INSERT identity_sync_jobs (kind=suspension) — retried forever, backoff ≤ 60 s
        C-->>A: 503 IdentityUnavailable, suspension: "applied-locally, session-revocation-pending"
        Note over C: alert IdentitySuspensionSyncFailing (page) after 3 consecutive failures
    else 409 InvalidStatusTransition
        C->>DB: identity_sync_status='failed'; stop retrying; keep local suspension
        C-->>A: 503 IdentityUnavailable (data.identitySyncStatus=failed)
        Note over C: page on-call immediately (IdentitySyncTransitionRejected)
    end
```
- **Never report a suspension as complete before Identity confirms.** The admin UI must show that sessions are not
  yet revoked while the response is 503.
- "Until it succeeds" covers transient failures only (network, timeout, 429, 5xx, one 401 token refresh).
- Reinstating a suspended doctor is out of scope for MVP.

## Failure policy table
| | Case 1 | Case 2 | Case 3 |
|---|---|---|---|
| Endpoint | `PATCH /internal/users/:id/status` → `active`/`rejected`/`pending` | `GET /internal/users?ids=` | `PATCH /internal/users/:id/status` → `suspended` |
| Criticality | required for the doctor to work | cosmetic | security-critical |
| Policy (`x-failure-policy`) | `retry-report-pending` | `degrade` | `must-not-degrade` |
| Local effect first | decision + `pending` committed | none | suspension + flags committed |
| Per-attempt timeout | 2 s | 2 s | 2 s |
| Inline attempts | 3 | 2 (1 retry) | ~6 s |
| After inline failure | 202 `identitySync: pending`; durable job | cache or null fields; 200 | 503 `IdentityUnavailable`; durable job, no attempt cap |
| Non-retryable Identity 409 | `failed`, alert, 202 `identitySync: failed` | n/a | `failed`, page immediately, 503 |
| Alert | after 15 min unsynced | degraded ratio | after 3 consecutive failures (page) |
| Gate | bookable only when approved **and** synced | — | "complete" only when confirmed |

Rationale and rejected alternatives: [ADR 0004](../adr/0004-cross-service-failure-policies.md).

## Known gap — Identity-originated doctor status changes
MVP is HTTP-only, so a doctor status change made **directly in Identity** (`PATCH /api/users/:id/status`) is not
pushed to Care: `doctor_profiles` would still say approved and unsuspended.

Two mitigations apply together:
1. **Process:** the admin console routes doctor suspension through Care's `PATCH /admin/doctors/:id/suspend`,
   never through Identity directly.
2. **Data:** Care reads `status` from Case 2 hydration and excludes non-active doctors from search when the cached
   entry is fresh (≤ 300 s).

Residual risk: a booking of such a doctor can still succeed within the cache window, and an Identity-side
reinstatement leaves `suspended_at` set in Care. The doctor's own practising actions fail at Identity's token
refresh. Closing the gap (events, or a periodic reconciliation) is the first `/system-design` topic — see
[future.md](./future.md).

## Notifications
Booking confirmation, reminder, reschedule, cancellation, and "doctor joined" emails are sent asynchronously
through the email port and never block or roll back the triggering write. The delivery mechanism (outbox table
vs job queue) is decided in `/system-design` before the module is built.
