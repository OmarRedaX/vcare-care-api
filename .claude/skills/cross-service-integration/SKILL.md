---
name: cross-service-integration
description: Use when code or design in a vcare service calls, or is called by, the other vcare service — service-token (client-credentials) auth, /internal/* endpoints, batch profile hydration, doctor verification or suspension status changes, timeouts/retries/backoff, caching borrowed data, and choosing a failure policy (degrade vs must-not-degrade). Covers the three platform integration cases and the rules for providers and consumers.
---

# Cross-Service Integration (vcare)

## Overview

vcare has two services with **separate databases**: **Identity** (accounts, tokens, account status) and **Care** (doctors, scheduling, consultations, records). They cooperate over **synchronous HTTP** on network-isolated `/internal/*` routes, authenticated with **short-lived scoped service tokens**. MVP has no message bus.

**Core principle:** every cross-service call has an explicit **failure policy** chosen from the business consequence of failure — not from what is convenient. The same client and mechanism can carry **opposite** policies.

## Anti-patterns (never)
- A shared database, or reading the other service's tables.
- A static, long-lived API key between services.
- Trusting a caller-supplied `X-User-Id` / `X-Role` / any identity header.
- One call per row (N+1 across the network).
- Letting a user token (even an admin's) call `/internal/*`.
- Building ad-hoc HTTP calls in a module — all calls go through the service's client in `lib/`.
- Storing borrowed data (names, emails) long-term as if you owned it.

## Service-token flow

```
Care (consumer)                                   Identity (provider)
───────────────                                   ───────────────────
lib/identity-client
  token cache empty or exp - 30s reached
  POST /internal/auth/token ───────────────────▶  verify client_secret (argon2id) against service_clients
    grant_type=client_credentials                 requested scopes ⊆ allowed_scopes
    client_id, client_secret                      sign JWT (EdDSA): typ=service, sub=client_id,
    scope="users:read users:status:write"           aud=vcare-identity, scope, exp=+300s, jti
    audience=vcare-identity        ◀───────────── { access_token, token_type: "Bearer", expires_in: 300 }
  cache token (single-flight refresh)

  GET /internal/users?ids=4,8,15 ──────────────▶  service-guard: signature ✓ typ=service ✓
    Authorization: Bearer <service token>           aud ∋ vcare-identity ✓ scope users:read ✓
    X-Request-Id: <from inbound request>          (user token → 401 ServiceTokenRequired)
                                   ◀───────────── 200 { success: true, data: [...] }
  on 401 → drop cached token, fetch a new one, retry once
```

Scopes: `users:read` (batch lookup) · `users:status:write` (status changes) · `doctors:read` (Care's `/internal/doctors/:userId/summary`, for admin tooling). The acting admin travels as data (`actorUserId` in the body) for the audit trail — it never grants authorization.

## The three integration cases

| | Case 1 — Verification unlocks the account | Case 2 — Batch profile hydration | Case 3 — Suspension revokes sessions |
|---|---|---|---|
| Direction | Care → Identity | Care → Identity | Care → Identity |
| Endpoint | `PATCH /internal/users/:id/status` `{status: active\|rejected\|pending, reason, actorUserId}` (`pending` on re-open) | `GET /internal/users?ids=…` (≤ 100) | `PATCH /internal/users/:id/status` `{status: suspended, reason, actorUserId}` |
| Trigger | admin approves/rejects an application | search results, consultation lists, doctor's patient list | admin suspends a doctor |
| Criticality | required for the doctor to work | cosmetic (display name/avatar) | **security-critical** |
| **Failure policy** | **retry, keep decision, report pending sync** | **degrade, never fail** | **must not degrade — retry until success + alert** |
| Timeout per attempt | 2 s | 2 s | 2 s |
| Inline attempts | 3 (backoff) | 2 (1 retry) | ~6 s of attempts |
| After inline attempts fail | 202 `identitySync: "pending"`, background retrier, alert after 15 min | serve cache; misses get `displayName: null`, `profileHydrated: false` | 503 `IdentityUnavailable`, durable retry job (no attempt cap, backoff ≤ 60 s), **alert after 3 consecutive failures** |
| Local effect first | decision + `identity_sync_status='pending'` committed | none | `suspended_at` set, future consultations flagged, bookings blocked — committed |
| Gate | doctor bookable only when `approved` **and** `synced` | — | suspension "complete" only when Identity confirmed |
| Provider guarantee | idempotent, transition-validated | one query, unknown ids omitted, no email/phone | status + revoke **all** refresh tokens + history in **one transaction** |

> Cases 2 and 3 use the same client and endpoint family with **opposite failure policies**. One degrades gracefully because a missing name hurts nobody; the other must not, because a suspended doctor with a live session is a patient-safety problem. Picking the wrong one is a **Critical** review finding.

### Case 1 — sequence (Care)
```
BEGIN
  UPDATE doctor_profiles SET verification_status='approved', reviewed_by=$admin, decided_at=now(), identity_sync_status='pending'
  INSERT audit_logs (action='verification.approved', …)
COMMIT
for attempt in 0..2: setUserStatus(userId, 'active')   # 2s timeout, backoff 200ms·2^n ±20%
  success → UPDATE identity_sync_status='synced' → 200
all failed → enqueue retry job → 202 { identitySync: 'pending' }
```

### Case 2 — sequence (Care)
```
ids = distinct user ids on this page
hits = redis MGET identity:user:<id>              # TTL 300s
misses = ids − hits
if misses: for chunk of 100: getUsersBatch(chunk)  # 2s timeout, 1 retry
  success → cache each (SETEX 300)
  failure → metric identity_hydration_degraded++ ; misses stay unknown
render rows: hydrated fields from hits/fresh; unknown → displayName=null, avatarUrl=null, profileHydrated=false
```
Never let hydration sit on the booking path. Never 5xx because of hydration.

### Case 3 — sequence (Care)
```
BEGIN
  UPDATE doctor_profiles SET suspended_at=now(), suspension_reason=$r, identity_sync_status='pending'
  UPDATE consultations SET needs_admin_followup=true WHERE doctor_user_id=$u AND starts_at>now() AND status IN ('booked','waiting')
  INSERT audit_logs (action='doctor.suspended', …)
COMMIT                                             # from here: no bookings, no doctor actions
retry setUserStatus(userId,'suspended') for ~6s
  success → identity_sync_status='synced' → 200
  failure → durable job retries forever (cap 60s backoff), alert after 3 consecutive failures
          → 503 IdentityUnavailable { suspension: 'applied-locally, session-revocation-pending' }
```

## Consumer rules (the client in `lib/identity-client`)
1. One client per target service; modules never call HTTP directly.
2. Per-attempt timeout **2 s** (connect + response) via `undici`; keep-alive pool.
3. Retries only on network errors, timeouts, `429`, `502`, `503`, `504` (and one token refresh on `401`) — never on other `4xx`. "Retry until success" (Case 3) means until success **or a non-retryable answer**: a `409 InvalidStatusTransition` stops the retries, marks `identity_sync_status='failed'`, and pages on-call. Backoff `200 ms · 2^attempt` with ±20 % jitter; respect `Retry-After`.
3a. Field mapping for batch lookup: provider `fullName` → Care `displayName`; `status` is display/search filtering only, never authorization.
4. Retried writes must be idempotent on the provider (status PATCH is).
5. Forward `X-Request-Id` from the inbound request (or the job's stored id).
6. Validate every response body through DTO validation; a malformed body is a failure.
7. Batch always: ≤ 100 ids per call; chunk larger sets; dedupe ids first.
8. Cache borrowed data only with a TTL and only what you display; never cache status for authorization decisions longer than the TTL.
9. Emit metrics per call: `outcome` (ok/timeout/error/degraded), latency, attempt count; alerts per the runbook.
10. Durable retries (Cases 1 and 3) live in the database (a job/outbox row with `next_attempt_at`), so restarts do not lose them.

## Provider rules (Identity `/internal/*`, Care `/internal/doctors/*`)
1. Mounted only on the internal listener; ingress never routes `/internal`.
2. `service-guard`: EdDSA signature, `typ=service`, `aud` ∋ this service, required scope. User token → `401 ServiceTokenRequired`; missing scope → `403 InsufficientScope`.
3. Fast and dependency-light (no outbound calls on these paths); p95 < 50 ms.
4. Writes are idempotent and validated against the domain's transition rules.
5. Responses expose the **minimum** fields the consumer needs (batch lookup: no email, no phone).
6. The contract in `contracts/openapi.yaml` is authoritative; changes are additive first, removals only after the consumer ships — record the change in the hub.
7. Adopt and log the caller's `X-Request-Id`.

## Testing the integration
- **Consumer integration tests** run against a local fake provider built from the provider's synced contract (`../vcare-hub/contracts/<provider>.openapi.yaml`), with modes: healthy, slow (> 2 s), 5xx, malformed body, 401 (expired token).
- Mandatory: Case 1 pending sync keeps the doctor unbookable and later syncs; Case 2 with the provider down still returns results with `profileHydrated:false` and no 5xx; Case 3 with the provider down → 503, local suspension applied, job enqueued, bookings blocked, alert metric emitted; token refresh on 401 happens once.
- **Provider integration tests:** user token rejected on every internal route; scope enforcement; batch cap and omitted unknown ids; suspension revokes all refresh-token families in the same transaction; status PATCH idempotency.

## Checklist for any new cross-service call
```
- [ ] Is a call needed at all? (token claims, cached data, or the hub might already answer it)
- [ ] Provider endpoint exists in the provider's contract (provider lands first) and is synced to the hub
- [ ] Scope defined; service client allowed it
- [ ] Failure policy chosen and written down: degrade / retry-and-report-pending / must-not-degrade
- [ ] Local state committed before the call where the policy needs it
- [ ] Timeout 2 s, retry rules, idempotency on the provider
- [ ] Batched; no per-row calls
- [ ] X-Request-Id forwarded; metrics + alert defined in runbook
- [ ] Hub architecture/landscape.md (and data-ownership.md, deployment.md network rules) updated via /system-design if who-calls-whom changed — the case definition lives in the hub; this repo documents only its consumer/provider implementation (docs-placement skill)
- [ ] Tests for healthy, slow, failing, and malformed provider behavior
```
