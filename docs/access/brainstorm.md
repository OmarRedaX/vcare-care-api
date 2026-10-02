---
title: access — Brainstorm
owner: care-team
service: care-service
module: access
status: draft
diataxis: explanation
last_verified: 2026-10-02
tags: [brainstorm, access, auth, jwks, rbac, audit, postgres-roles, worker]
related: [system-design, rbac, data-model, integration, resilience, adr-0006-health-split-redis-tier-2, adr-0009-audit-logs-monthly-partitions, adr-0016-foundation-runtime-dependencies, foundation-spec]
---

# access — Brainstorm

## Problem & purpose
The foundation shipped without `lib/auth`, `lib/rbac`, or `lib/audit` because it had no business routes. Every business
module needs all three: the first one, `specialties`, needs a verified user, an admin-only policy, and an audit row
for each change. If specialties built them itself, a tiny catalog feature would carry the platform's shared security code
and the first review would be dominated by it.

`access` lands that shared base with **no business routes**: local verification of Identity user tokens, deny-by-default
authorization, and the append-only audit log. It also fixes the latent foundation gaps that the first mounted business
route would expose. After it, `specialties` stays thin (decided 2026-10-02).

## Actors
- **Patient / doctor / admin**: callers presenting Identity-issued user tokens (EdDSA, `typ=user`, `aud` ∋ `vcare-care`).
- **identity-service**: publishes `GET /.well-known/jwks.json`. Care only reads it, and never on a per-request basis.
- **care-worker**: gets its first real loop, which maintains the audit partitions.
- **Operators**: the readiness probe and the runbook (JWKS down, partition missing, rows in the DEFAULT partition).

## In scope (this iteration)
1. **`lib/auth`: user guard only.** It reads `Authorization: Bearer` and verifies the signature against an in-memory
   JWKS cache from `IDENTITY_JWKS_URL`. On an unknown `kid` the cache refreshes, at most once per minute. The guard
   requires `iss=vcare-identity`, `aud` ∋ `vcare-care`, `typ=user`, and an unexpired token. It then sets
   `req.auth = { userId: Number(sub), role, status, emailVerified: ev }` and attaches `userId`/`role` to the request
   logger. If the JWKS is unreachable and no cached key matches, it returns `401 Unauthorized` and never skips
   verification. An expired token gets `401 TokenExpired`. Adds `jose` (already in the locked stack, no ADR needed per ADR 0016).
2. **`lib/rbac`: deny-by-default `authorize(policy)`.** A policy declares:
   - its roles,
   - the account statuses each role may hold (default `active`; the doctors module will declare the onboarding set `pending | active | rejected`),
   - an optional `requireEmailVerified` flag,
   - an optional async ownership resolver that reads the database, never the request body. It answers allow,
     `404 NotFound` (private existence), or `403 Forbidden`.

   A route without a policy fails closed. A boot-time assertion refuses to start if any mounted route lacks
   `authorize`. This mirrors identity's `assert-routes-authorized.ts`, with health as the documented exception.
   The doctors module will later plug in the local `doctor_profiles.suspended_at` check. Its mechanism is a spec detail, and it does not land here.
3. **`lib/audit`.** `audit.record(trx, entry)` writes one `audit_logs` row inside the caller's transaction:
   - actor user id and role from `req.auth`, or `system` for worker actors,
   - `action`, `entity_type`, `entity_id`, `request_id`,
   - `metadata` that holds ids, statuses, and reasons only.

   Only the write side lands here. `GET /audit-logs` belongs to the later `audit` module.
4. **`audit_logs` migration** (ADR 0009). The table is range-partitioned by month with PK `(id, created_at)`. The
   migration creates the DEFAULT partition and partitions for the current month plus `AUDIT_PARTITION_MONTHS_AHEAD`
   months. The three indexes in `data-model.md` come with their queries. Grants are `INSERT`/`SELECT` only for `vcare_app`.
5. **Database roles (decided 2026-10-02).** Migrations run as the owner (`care`). A migration creates a `NOLOGIN`
   group role `vcare_app` that holds the table grants. The API and worker log in as a separate `care_app` user in that
   group. The env splits into `MIGRATION_DATABASE_URL` (owner) and `DATABASE_URL` (app). Every table migration grants
   to `vcare_app` explicitly, and append-only tables get only `INSERT`/`SELECT`. Medical-record amendments will reuse this.
   Compose, `.env.example`, `.env.test`, CI, and the quickstart/runbook are updated.
6. **care-worker `audit-partitions` loop** (decided 2026-10-02). The worker gets its own Postgres wiring. The loop runs
   daily under an advisory lock and is idempotent. It creates missing future partitions, applies grants to them, and logs
   `audit_partition_missing` / `audit_default_partition_nonempty` (alert per ADR 0009).
7. **Readiness: informational `checks.identityJwks: up | down`** (decided 2026-10-02). The value comes from the cache
   state: keys loaded and last refresh OK. The probe makes no network call, and the check never changes `status`
   or the HTTP code (ADR 0006: only Postgres fails readiness). It applies to both public and internal readiness.
8. **Foundation latent gaps fixed here**:
   - [#5](https://github.com/OmarRedaX/vcare-care-api/issues/5) `:param` `URIError` currently becomes a 500,
   - [#6](https://github.com/OmarRedaX/vcare-care-api/issues/6) the route label loses the mount prefix,
   - [#10](https://github.com/OmarRedaX/vcare-care-api/issues/10) no breaker for a stalled-but-ready Redis,
   - [#11](https://github.com/OmarRedaX/vcare-care-api/issues/11) a malformed idempotency record crashes the process.
9. **Error codes:** `TokenExpired` (401) is added next to the existing `Unauthorized`/`Forbidden` in `lib/error/errors.ts`.

## Out of scope
- Service guard, `ServiceTokenRequired`, `InsufficientScope`: these land with the doctors module and the internal summary route (decided 2026-10-02).
- `lib/identity-client`, ownership resolvers for real resources, and the local `suspended_at` check: doctors and later modules.
- `GET /audit-logs` and the audit read model: the `audit` module.
- Any business table or public route, including specialties.
- Foundation gaps routed elsewhere: #7 cursor µs, #8 implicit boolean conversion, and #9 rate-limit member go to `specialties`; #12–#17 stay at their own triggers.
- Archiving or detaching partitions older than 6 years (an ops procedure per ADR 0009).

## Key entities & relationships
- `audit_logs` (partitioned; no FKs, `entity_id` is polymorphic by `entity_type`; `actor_user_id` is an Identity user id with no FK).
- In-memory only: JWKS key set, `AuthContext` (shape already declared in `lib/types/express.d.ts`), `Policy`.
- Postgres roles: `care` (owner), `vcare_app` (group, grants), `care_app` (login, member of `vcare_app`).

## Primary flows / endpoints (with roles + ownership)
No new public or internal business endpoints. Changed: `GET /api/health/ready` and `GET /internal/health/ready` add `checks.identityJwks`.
Flows, all exercised in tests through **test-only routers**, as the foundation did for idempotency:
- Bearer token → user guard → `authorize(policy)` → handler. Missing, invalid, wrong-`aud`/`typ`/`iss`, or expired token → 401.
  Wrong role or status → 403. An ownership resolver can produce 404/403.
- Unknown `kid` → one rate-limited JWKS refresh → verify again. JWKS down with no matching key → 401, and readiness shows `identityJwks: down`.
- Service write → `db.transaction(trx => … audit.record(trx, …))`. If the write rolls back, the audit row rolls back too.
- Worker tick → advisory lock → ensure partitions → grants → DEFAULT-partition check.

## Business rules & state transitions
- Deny by default: no policy means 403 (fail closed). An unpoliced route is a boot error.
- The only principal is the verified token. `X-User-Id`, `X-Role`, and similar headers are ignored.
- `audit_logs` is append-only for the app role, enforced by grants and not by code discipline.
- `metadata` never contains clinical text or PII.
- No state machine in this unit.

## Cross-service touchpoints (case, direction, failure policy)
- Care → Identity `GET /.well-known/jwks.json` (public listener). This is not Case 1–3; there is no service token. Failure
  policy: serve from the cached keys, refresh only on an unknown `kid` (at most once per minute), and answer 401 when no
  key matches. Never fail open. `identityJwks: down` is reported but never fails readiness.

## Privacy & audit
- The logger never logs tokens or `Authorization` headers; both are already redacted. JWKS fetch errors log the URL host and status only.
- `audit_logs.metadata` is checked by a test that captured logs and audit rows contain no fixture PII.
- This unit audits nothing itself. It provides the mechanism.

## Constraints & guideline notes
- `jose` for verification. The HTTP fetch of the JWKS is a spec decision: jose's remote JWKS helper versus `undici` per
  CLAUDE.md's "internal HTTP client" rule. Either way it needs a bounded timeout and a single-flight refresh.
- Transactions follow CLAUDE.md's handler-form rule. `audit.record` takes the caller's `trx` and never opens its own.
- Mirror identity's `lib/auth` / `lib/rbac` shapes where they fit (parity), but Care never signs tokens.
- **Manual QA uses the real Identity running locally** (decided 2026-10-02). Check out identity `feature/auth` (or main
  once merged), then sign up and log in a patient and a doctor, and create the admin via identity's runbook procedure.
  Edge-case tokens (expired, wrong `aud`/`typ`, unknown `kid`) are covered by integration tests with a fake JWKS server,
  not by manual QA. Host port 3000 is taken by an unrelated app on this machine, so identity previously ran on 3020/3120.

## Contract changes expected
- `HealthStatus.checks.identityJwks` is an optional `enum [up, down]` with the description "Reported only; never fails
  readiness." It applies to both ready responses. Nothing else: no new operations.

## Decisions on the former open questions (2026-10-02)
- **Hub deployment doc:** add one sentence saying migrations use the owner credential and the API and worker use the
  app credential. This is a **platform delta**. It is written by `/system-design` (the only phase that edits hub docs),
  together with the earlier `TRUST_PROXY_HOPS` / `DATABASE_POOL_MAX` deltas. Also confirm there that `landscape.md`
  lists the care → identity `/.well-known/jwks.json` read.
- **Grants:** each table migration grants explicitly to `vcare_app` (no `ALTER DEFAULT PRIVILEGES`). The
  `write-migration` skill gains this rule.
- **Doctor suspension:** the `doctor_profiles.suspended_at` check is part of the route's permission check. A policy
  for practising-doctor routes declares it, and `authorize` runs it from the database. Booking also checks the
  **target** doctor (Eligibility rule 6). `access` leaves room for this in the `Policy` type, and the doctors module
  supplies the check.
- **JWKS cache:** maximum key-set age 1 h without a successful refresh (after that, cached keys are not trusted and
  verification answers 401), `clockTolerance` 30 s for `exp`/`nbf`, and a 2 s fetch timeout.
  **Constraint from identity:** the normal refresh cadence stays at Identity's `Cache-Control: max-age=300`. Care
  re-fetches a key set older than 5 min (single-flight) as well as on an unknown `kid` (at most once per minute). The 1 h
  limit is only the stale-if-error window while refreshes fail. This keeps identity's emergency-rotation guarantee
  (`docs/architecture/auth-tokens.md`: a compromised key stops verifying once consumers refetch, ≤ 5 min).
- **Local databases:** migrate the existing **dev** database in place (create the roles, reassign grants, keep data).
  Reset the disposable **test** databases.

## Open questions
- None blocking the spec. The hub sentence above is queued for the next `/system-design` pass.

## Success criteria
- Every RBAC scenario passes through a test router: no token, bad signature, wrong `aud`/`typ`/`iss`, expired →
  `TokenExpired`, wrong role, wrong status, unverified email, ownership 404 versus 403, and an unpoliced route that makes
  boot fail.
- The JWKS refreshes on an unknown `kid` no more than once per minute, and a JWKS outage yields 401 and `identityJwks: down` with readiness still 200.
- As `care_app`, `UPDATE audit_logs` and `DELETE FROM audit_logs` fail with a permission error, and `INSERT`/`SELECT` succeed.
- An audit row written in a rolled-back transaction does not exist.
- The worker loop creates missing partitions idempotently under concurrency (two workers, one advisory lock) and flags a non-empty DEFAULT partition.
- #5, #6, #10, and #11 are fixed with regression tests and closed by the PR.
- Typecheck, lint, unit, and integration pass. Manual QA against the real local Identity: a patient, doctor, and admin token each pass the guard on a test-only route.
