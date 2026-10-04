# AGENTS.md — vcare Care Service (`care-service`)

These rules are **binding** for every human and agent working in this repo. They are the production
baseline for the vcare platform, made stricter than the reference `playground-with-context`, plus the
clinical, scheduling, and cross-service rules this service needs. This file is **self-contained** — you do
not need another repo's AGENTS.md to follow it.

- **Source of intent:** the PRD at `../vcare-hub/product/prd.md`. **Source of truth for the API:** `contracts/openapi.yaml`.
- **Cross-service context:** the hub at `../vcare-hub` (start at its `INDEX.md`). Platform-scope docs — overview, deployment topology, capacity model, integration cases, data ownership — live **only** there; see "Doc placement — hub or service".
- **Citing this file:** always cite sections **by name** (e.g. "AGENTS.md → Domain rules"), never by number.
- **Architect trigger:** when the user says **"let's system design"** (or runs `/system-design <topic>`), run the `/system-design` command inline — see "Architect mode — /system-design".

> Status: AI setup only — **no application code exists yet**. Modules are created through the workflow
> (`/system-design` → `/brainstorm` → … → `/update-docs`). Do not scaffold `src/` outside that workflow.

When a rule here conflicts with your defaults, **this file wins**. When a rule here conflicts with
`contracts/openapi.yaml`, **the contract wins** and this file or the spec is stale — flag it.

---

## Mission of this service

Care owns **the medical marketplace**: who the doctors are, when they can see patients, the consultations
between them, and the clinical record those consultations produce.

| Owns (single writer) | Never owns |
|---|---|
| Doctor profiles, languages, fees, `is_accepting_patients`, local suspension state | Passwords, tokens, sessions (Identity) |
| Verification documents and the credentialing decision | Account status as the source of truth (Identity) — Care *requests* status changes |
| Specialties, doctor↔specialty links | Names, emails, phones, avatars (Identity — hydrated, never copied long-term) |
| Working hours, schedule exceptions, consultation types | Video infrastructure (third-party room provider behind a port) |
| Consultations and their lifecycle, waiting room, session join | Payments, prescriptions, labs (out of scope) |
| Patient profiles (demographics, allergies, chronic conditions, timezone) | |
| Medical records, amendments, attachments | |
| Help articles (the Phase-2 RAG corpus) | |
| The audit log for everything above | |

Care **never stores a password, never issues a token, and holds only `user_id` references** to Identity
accounts (`BIGINT`, no cross-database FK). Care is **Tier 1** for booking and consultations; search is the
hot read path; medical records carry the strictest privacy rules on the platform.

Expected bounded contexts (module slugs are fixed by `/brainstorm`, not pre-created): `specialties`,
`doctors`, `verification`, `schedules`, `availability`, `consultations`, `sessions`, `patients`, `records`,
`help-articles`, `audit`, `identity-client` (lib).

---

## Tech stack (locked)

| Concern | Library / tool |
|---|---|
| Runtime | Node.js 24 LTS + TypeScript (`strict: true`, `noUncheckedIndexedAccess: true`) |
| HTTP | `express` v5 |
| Request validation | `class-validator` + `class-transformer` (DTO classes) — also used to validate Identity's internal responses |
| Env validation | `zod` (env only) |
| DI | `tsyringe` with `Symbol.for()` tokens |
| DB | `knex` over `pg` — query builder + **raw-SQL migrations**; Postgres extension `btree_gist` |
| Cache / rate limit / idempotency | `ioredis` |
| JWT verification | `jose` — verify EdDSA tokens against Identity's JWKS (never sign user tokens) |
| Timezones | `luxon` (IANA zones) |
| Internal HTTP client | `undici` (timeouts, keep-alive pool) |
| Object storage | AWS SDK v3 modular (`@aws-sdk/client-s3`, `@aws-sdk/s3-presigned-post`, `@aws-sdk/s3-request-presigner`) — imported only in `lib/storage` (ADR 0015) |
| Security headers | `helmet` |
| Logging | custom structured JSON `Logger` with clinical/PII redaction |
| Testing | `jest` + `supertest` |
| IDs | `BIGSERIAL` primary keys, **exposed as numeric ids** (hub ADR 0004) |

**Forbidden:** every ORM (Prisma, TypeORM, Sequelize, Drizzle, Kysely, MikroORM), NestJS, GraphQL, gRPC,
tRPC, Passport, Auth0/Clerk, `jsonwebtoken`, `moment`/`moment-timezone`, `node-fetch`/`axios` (use `undici`),
and any library that stores slots. Adding **any** new runtime dependency requires an ADR in `docs/adr/` first.

---

## Folder structure and layering

```
src/
  app.ts                     # public express app (mounted under /api)
  internal-app.ts            # internal express app (mounted under /internal) — separate listener
  server.ts                  # bootstrap both listeners + graceful shutdown
  worker.ts                  # care-worker entrypoint — background loops only (ADR 0008)
  bootstrap.ts               # DI registration (the only place that wires app/ into the container)
  migrate.ts                 # migration CLI (latest / rollback / status / make)
  routes.ts                  # mounts public module routers
  internal-routes.ts         # mounts internal module routers
  app/<module>/              # one folder per bounded context
    controller/<module>.controller.ts
    service/<module>.service.ts
    repository/<module>.repo.ts
    entity/<module>.entity.ts
    dto/<module>.request.dto.ts
    dto/<module>.response.dto.ts
    enums.ts  errors.ts  types.ts  routes.ts  policies.ts
  lib/
    auth/            # jwks-cache.ts, user-guard.ts (verify locally), service-guard.ts
    identity-client/ # service-token cache, getUsersBatch (Case 2), setUserStatus (Cases 1 & 3), retry/backoff
    rbac/            # authorize.ts (deny-by-default), ownership resolvers
    audit/           # audit.ts — writes audit_logs rows inside the caller's transaction
    storage/         # object-storage port + S3 adapter: presigned POST/GET, head, byte-range read, promote, delete (ADRs 0013–0015)
    video/           # room-provider port + adapter
    request-id/      # X-Request-Id middleware
    config/          # env.ts (zod)
    di/              # container.ts, tokens.ts
    error/           # AppError.ts, errorHandler.ts (the one error envelope)
    http/            # response.ts, pagination/, cors.ts (dev allowlist), no-store.ts, client-ip.ts
    lifecycle/       # shutdown/readiness state, in-flight request counter
    worker/          # loop runner for care-worker (stop after the current tick)
    idempotency/     # Redis-backed idempotency middleware (required on booking writes)
    rate-limit/      # Redis sliding-window limiter
    knex/  redis/  logger/  types/  validation/
    email/           # notification email port (async, never blocks a booking)
  pkg/
    utils/           # time.ts, interval.ts (pure interval math), string.ts — framework-free
    slots/           # pure slot computation (no DB, no env) — see the timezone-slot-computation skill
  migrations/
tests/
  unit/  integration/  setup.ts
```

**Layering (strict):**
```
app/  → may import lib/, pkg/
lib/  → may import pkg/, config; must NOT import app/<module>/* (only DI tokens at boot)
pkg/  → pure functions; NO imports from lib/ or app/, NO env, NO singletons, NO clock (pass `now`)
```
- Cross-module calls go through **services**, never another module's repository.
- **All calls to Identity go through `lib/identity-client`.** No module builds its own HTTP call to another service.
- `/internal/*` routers are mounted **only** on the internal listener (`INTERNAL_PORT`), never reachable from the public ingress.

---

## Naming conventions

**Files:** `kebab-case` (`consultation-type.repo.ts`); one class per file.
**TypeScript:** `PascalCase` classes/types/enums · `camelCase` variables/methods · `UPPER_SNAKE_CASE` constants and DI token names.
**Database:**
- Tables plural `snake_case` (`doctor_profiles`, `working_hours`, `schedule_exceptions`, `consultation_types`, `consultations`, `medical_records`, `medical_record_amendments`, `record_attachments`, `audit_logs`); columns `snake_case`; booleans `is_*`.
- PK `id BIGSERIAL`; FK columns `BIGINT`; Identity references are `<role>_user_id BIGINT` or `user_id BIGINT` with **no FK** and a comment saying "Identity user id".
- Constraints: `fk_<table>_<col>`, `uq_<table>_<cols>`, `chk_<table>_<what>`, `excl_<table>_<what>`; indexes `idx_<table>_<cols>`.
- Timestamps `created_at`, `updated_at`, `deleted_at`, `<verb>_at` — **always `TIMESTAMPTZ`**. Wall-clock schedule times are `TIME` + the doctor's IANA `timezone`.
- Money: `INT` minor units + `currency CHAR(3)`.
**Routes:** plural nouns, `PATCH` for partial updates and lifecycle actions (`/consultations/:id/cancel`), `me` for the caller's own resources.
**Error codes:** `PascalCase`, stable forever once shipped.

---

## Module file conventions

Every module under `src/app/<module>/` has the same skeleton.

1. **`entity/<module>.entity.ts`** — plain class, `constructor(data: Partial<X>)`, no decorators, no DB knowledge.
2. **`dto/<module>.request.dto.ts`** — `class-validator` classes; every field explicitly validated; unknown properties rejected (`forbidNonWhitelisted: true`). IANA timezones validated with `luxon` (`IANAZone.isValidZone`). Datetimes must be ISO-8601 **with offset**.
3. **`dto/<module>.response.dto.ts`** — plain classes with `static from(entity, viewer)`. **The viewer's role shapes the DTO**: an admin viewer never receives clinical fields (`complaintText`, examination notes, diagnosis, treatment plan, allergies, chronic conditions, attachments).
4. **`repository/<module>.repo.ts`** — exported **functions** with `conn: Knex = db`, explicit `<MODULE>_COLUMNS`, private `toEntity(row)`, `whereNull('deleted_at')` on every read unless the function name says `IncludingDeleted`.
5. **`service/<module>.service.ts`** — `@injectable()`; owns rules and transactions; calls `audit.record(...)` inside the same transaction for every clinical access and every state change listed in "Privacy and logging"; throws `AppError` instances.
6. **`controller/<module>.controller.ts`** — `@injectable()`; arrow-function methods; validate → service → `sendSuccess`. No business logic.
7. **`routes.ts`** — `router.<verb>(path, userGuard | serviceGuard, authorize(policy), [idempotency({ required: true })], ctrl.method)`. A route without `authorize(...)` is a review blocker.
8. **`policies.ts`** — roles + ownership predicate per route (see "Authorization — RBAC and ownership").
9. **`enums.ts`** — string enums matching DB `CHECK` constraints exactly.
10. **`errors.ts`** — exported `AppError` instances: `export const SlotUnavailable = new AppError("SlotUnavailable", 409, "The selected slot is no longer available");`
11. **`types.ts`** — every non-entity interface/type alias. **Inline `interface`/`type` in controller, service, repository, guard, client, or middleware files is forbidden.**

---

## Database rules

- **Migrations are raw SQL** (`knex.raw`), one change per file, real `down`, never edited after running. Use the `write-migration` skill.
- **`TIMESTAMPTZ` everywhere**, UTC on every pool connection. `TIMESTAMP` without time zone is forbidden.
- **Soft delete only** (`deleted_at`) for profiles, records, attachments, help articles, consultation types, exceptions. Hard delete is never exposed; `DELETE` HTTP verbs set `deleted_at`. Clinical tables have **no `ON DELETE CASCADE`**.
- **Overlapping consultations are impossible at the DB level:**
  ```sql
  CREATE EXTENSION IF NOT EXISTS btree_gist;
  ALTER TABLE consultations
    ADD CONSTRAINT excl_consultations_doctor_no_overlap
    EXCLUDE USING gist (doctor_user_id WITH =, tstzrange(starts_at, ends_at, '[)') WITH &&)
    WHERE (status NOT IN ('cancelled', 'no_show') AND deleted_at IS NULL);
  ```
  The service maps SQLSTATE `23P01` (`exclusion_violation`) to `409 SlotUnavailable`. Application checks are a courtesy; **the constraint is the guarantee**.
- `CHECK (ends_at > starts_at)` on consultations; `CHECK (end_time > start_time)` on working hours and custom-hours exceptions; `uq_consultations_idempotency` on `(patient_user_id, idempotency_key)`.
- **Slots are never stored** — no `slots`/`availability` table. Only the inputs (working hours, exceptions, consultation types, consultations) are stored. A Redis cache of a computed window is allowed (derived, TTL, invalidated on input change).
- **Medical records:** `locked_at TIMESTAMPTZ NOT NULL` = `created_at + interval '24 hours'`; updates after `locked_at` are rejected by the service **and** by a trigger; corrections go to `medical_record_amendments` (append-only: no `UPDATE`/`DELETE` grants for the app role).
- **`audit_logs` is append-only** (`actor_user_id, actor_role, action, entity_type, entity_id, request_id, metadata JSONB, created_at`); the app role has `INSERT`/`SELECT` only. `metadata` never contains clinical text or PII.
- **Files:** `verification_documents.object_key` and `record_attachments.object_key` store storage keys, never public URLs.
- **Enum-like columns:** `VARCHAR(n) NOT NULL CHECK (col IN (...))`, never native `ENUM`.
- **Every FK** named and covered by an index whose leading column is the FK column. **Indexes exist only for a query in code**, commented with that query; composite = equality columns then range/sort.
- **No defaults on critical columns** (fees, prices, durations, statuses).
- **Transactions:** service-owned, explicit commit/rollback, never nested. Booking, reschedule, cancel, suspension side-effects, and record writes + their audit rows are each **one transaction**.

---

## API conventions

**Base paths:** public `/api/*` on `PORT` (local `3001`); internal `/internal/*` on `INTERNAL_PORT` (local `3101`); `GET /api/health/live|ready`, `GET /internal/health/live|ready` (readiness fails only on Postgres; Redis is Tier 2 — ADR 0006). Identity runs locally on `3000` / `3100`.

**One error envelope** — identical in both vcare services, produced only by `lib/error/errorHandler.ts`:
```json
{ "success": false, "error": { "code": "SlotUnavailable", "message": "The selected slot is no longer available", "details": [], "requestId": "7f1c…" } }
```
Success: `{ "success": true, "data": <payload>, "meta": { … } }`. Unknown errors → `InternalError` (500), no internals in the body.

**Request id:** accept an incoming UUID `X-Request-Id` or generate one; echo on every response; attach to every log line, every audit row, and **every call to Identity**.

**Time on the wire:** ISO-8601 with offset. Slot and consultation responses carry `startsAt`/`endsAt` in UTC **and** `startsAtLocal`/`endsAtLocal` in the viewer's timezone plus `timezone`.

**Pagination:** every list is cursor-based keyset — `?cursor=<opaque>&limit=<1..100, default 20>`; cursor encodes `(sortValue, id)`; `meta: { nextCursor, hasMore, count }`; fetch `limit + 1`. Filters are whitelisted query params.

**Idempotency:** `Idempotency-Key` (UUID) is **required** on `POST /consultations`, `PATCH /consultations/:id/reschedule`, `PATCH /consultations/:id/cancel` (missing → `400 ValidationFailed`), optional on other writes. Redis-backed for 24 h, keyed by `(route, principal, key)` with a request-body hash: same key + same body → replay original response; same key + different body → `422 IdempotencyConflict`. Booking additionally persists the key on the consultation row (`uq_consultations_idempotency`) so a Redis loss cannot double-book.

**Status codes:** 200 · 201 · 204 · 400 `ValidationFailed` · 401 `Unauthorized`/`TokenExpired` · 403 `Forbidden`/state errors · 404 `NotFound` · 409 conflicts · 422 `IdempotencyConflict` · 429 `RateLimited` · 500 `InternalError` · 503 dependency down (health only). **A Case-2 Identity outage never produces a 5xx.**

**Error codes owned by Care** (stable):

| Code | HTTP | When |
|---|---|---|
| `ValidationFailed` | 400 | DTO validation failed |
| `Unauthorized` / `TokenExpired` | 401 | missing/invalid/expired bearer token |
| `ServiceTokenRequired` | 401 | `/internal/*` without a valid service token |
| `InsufficientScope` | 403 | service token lacks `doctors:read` |
| `Forbidden` | 403 | role or ownership check failed |
| `EmailNotVerified` | 403 | patient booking without a verified email |
| `DoctorNotBookable` | 409 | doctor not verified + active + accepting, or locally suspended |
| `SlotUnavailable` | 409 | slot taken (incl. exclusion violation) or no longer computed as free |
| `OutsideWorkingHours` | 422 | requested interval not inside the doctor's hours for that date (doctor tz) |
| `BookingInPast` | 422 | start ≤ now |
| `BeyondBookingHorizon` | 422 | start > now + 60 days |
| `PolicyWindowViolation` | 409 | patient cancel/reschedule inside the policy window |
| `InvalidTransition` | 409 | lifecycle transition not allowed (incl. any change to a terminal state) |
| `NoShowTooEarly` | 409 | no-show before start + grace |
| `RoomNotOpen` | 409 | join/start outside the session window |
| `RecordRequiresCompleted` | 409 | record on a non-`completed` consultation |
| `NotAssignedDoctor` | 403 | record write by a doctor other than the consultation's doctor |
| `RecordLocked` | 409 | deleting an attachment after the 24 h lock |
| `ApplicationNotReviewable` | 409 | approve/reject on an application not in `submitted` |
| `ScheduleConflictsUnconfirmed` | 409 | blocking time that holds bookings without `confirmConflicts=true` |
| `IdentityUnavailable` | 503 | a **must-succeed** Identity call is still failing (suspension reported as pending) |
| `IdempotencyConflict` | 422 | same key, different body |
| `NotFound` | 404 | absent, or not visible to the caller |
| `Conflict` | 409 | generic uniqueness conflict |
| `RateLimited` | 429 | limiter tripped |
| `InternalError` | 500 | unhandled |

---

## Authentication and service-to-service auth

**User tokens (verified locally, no call per request).** `lib/auth/user-guard` reads `Authorization: Bearer`, verifies the EdDSA signature against Identity's JWKS (`IDENTITY_JWKS_URL`, cached in memory, refreshed on unknown `kid` at most once per minute), and requires `iss=vcare-identity`, `aud` ∋ `vcare-care`, `typ=user`, unexpired. It sets `req.auth = { userId: Number(sub), role, status, emailVerified: ev }`. If the JWKS cannot be fetched and no cached key matches, respond `401 Unauthorized` — never skip verification.

**Account state from the token:** doctor **onboarding** routes (`POST /doctors/apply`, `GET/PATCH /doctors/me`, `POST /doctors/me/documents`, `GET /doctors/me/application`) accept `status ∈ {pending, active, rejected}` — a doctor must be able to apply before approval, and a rejected doctor must be able to read the decision, fix the profile/documents, and resubmit; every **practising** doctor action (schedule, pricing, consultation types, sessions, records) requires `status=active`; patients must have `status=active`; booking requires `emailVerified=true`. Because tokens live up to 15 minutes, Care **also** checks its own `doctor_profiles.suspended_at` on every doctor action and every booking — a suspended doctor is blocked immediately, not at token expiry.

**Service tokens (Care → Identity).** `lib/identity-client` exchanges `SERVICE_CLIENT_ID`/`SERVICE_CLIENT_SECRET` at `POST {IDENTITY_INTERNAL_URL}/internal/auth/token` (client credentials, `audience=vcare-identity`, scopes `users:read users:status:write`), caches the token until 30 s before `exp`, single-flights concurrent refreshes, and retries once on `401` with a fresh token.

**Care's internal endpoint.** `GET /internal/doctors/:userId/summary` requires a service token with `typ=service`, `aud` ∋ `vcare-care`, scope `doctors:read`. **A user token (even an admin's) → `401 ServiceTokenRequired`.** No MVP service client holds `doctors:read`; the endpoint serves admin tooling and the Phase-2 AI service once a client is provisioned in Identity.

**Never trust `X-User-Id`, `X-Role`, `X-Forwarded-User`, or any caller-supplied identity header.** The only principal is the verified token. No shared database with Identity, no static forever-keys.

---

## Authorization — RBAC and ownership

**Deny by default.** `authorize(policy)` on every route; no policy → fail closed. Policies declare **roles** and an **ownership predicate** resolved from the database (never from the request body). Use the `rbac-ownership-guard` skill. Non-owners get `404 NotFound` for resources whose existence is private (consultations, records, patient profiles).

| Capability (PRD §9) | Patient | Doctor | Admin |
|---|:--:|:--:|:--:|
| Search doctors (`GET /doctors`, `/doctors/:id`, `/doctors/:id/slots`) | ✅ | — | ✅ |
| Book own consultation (`POST /consultations`) | ✅ | — | — |
| Reschedule / cancel **on behalf** | — | — | ✅ (reason required) |
| Reschedule / cancel **own** | ✅ outside window | ✅ cancel with reason (own) | — |
| Manage own schedule & pricing (`/doctors/me/*`) | — | ✅ own | — |
| Join session (`/consultations/:id/join`) | ✅ own | ✅ own | — |
| Start / complete / no-show | — | ✅ own | — |
| Write medical record | — | ✅ assigned doctor | — |
| Read clinical records | ✅ own | ✅ patients they have consulted | ❌ never |
| Approve / reject doctor applications | — | — | ✅ |
| Suspend doctors | — | — | ✅ |
| Manage specialties & help articles | — | — | ✅ |
| Read audit logs (`GET /audit-logs`) | — | — | ✅ (metadata only, no clinical content) |

**Ownership rules (PRD §8, Access):**
- Patients access only **their own** consultations, records, and profile.
- Doctors access **their own** schedule, consultations, and the records/profile of patients **they have a `completed` or current consultation with** (`EXISTS` check on `consultations`).
- Admins manage verification, suspension, bookings, specialties, help content — and **never** clinical notes: record endpoints deny admins, and admin DTOs omit clinical fields.
- `GET /patients/:id` and `GET /patients/:id/records`: the patient themself or a doctor with a consultation relationship; every successful call is audited.

---

## Security rules

- **Documents and attachments** never pass through `care-api` as bytes and never get a public or permanent link (ADRs 0013, 0014; hub ADR 0011; `docs/architecture/file-handling.md`):
  - **Upload** = intent → presigned POST to `quarantine/<uuid>` → `complete`. A `verification_documents` / `record_attachments` row is created **only after `complete` verifies the stored object itself**: `HEAD` size 1 B–10 MB and the leading bytes (magic number) are PDF, JPEG, or PNG. The filename and any client- or S3-declared `Content-Type` are never trusted; `file_type` is the detected type. A failed check deletes the quarantine object and returns `400 ValidationFailed`.
  - **Upload intents** (`upload_intents`) are temporary (15 min), single-use, bound to their owner, and re-authorized at `complete`; they are never documents or attachments.
  - **Download** URLs are issued on demand by a `download-url` endpoint, only after `authorize(policy)` and a successful audit insert: presigned GET valid **60 s**, `attachment` disposition, verified content type. Read DTOs never embed URLs.
  - Private bucket, Block Public Access on, TLS-only, CORS `POST` from the web origin only; random object keys, never the client filename.
- **Rate limits (Redis sliding window):** public search and slots 60/min per IP and 120/min per user · booking writes 10/min per user · uploads 20/h per user.
- **Headers:** `helmet`; CORS allowlist from env in local development only — production is a single origin with CORS disabled (hub ADR 0005); `Cache-Control: no-store` on every clinical and consultation response.
- **Env:** every variable declared in `lib/config/env.ts` (zod), no defaults on secrets (`SERVICE_CLIENT_SECRET`, `VIDEO_PROVIDER_KEY`, storage credentials).
- **Video:** join returns a short-lived provider join token for that participant only, issued only inside the session window.
- **Phase-2 AI boundary:** any AI-produced clinical artifact (complaint parse, summary, ICD-10 suggestion) is stored as a **draft** that the doctor must confirm; AI never diagnoses, prescribes, or decides treatment; red-flag symptoms escalate to a human immediately. AI service calls use the same service-token flow with their own scopes.

---

## Privacy and logging

- Structured JSON: `level, message, timestamp (ISO UTC), requestId, service="care-service", userId?, role?, route, status, durationMs`.
- **Never log clinical data or PII:** complaint text, examination notes, diagnosis text/code, treatment plans, allergies, chronic conditions, blood type, date of birth, document or attachment contents/keys/URLs, names, emails, phones, `Authorization` headers, presigned URLs and POST fields, request bodies of clinical or consultation routes. The logger redacts these keys by name as defence in depth — do not rely on it.
- **Every access to clinical records is audited:** reading a record, a patient's record list/timeline, a patient profile's clinical fields, issuing a download URL, creating/updating/amending a record, adding/removing an attachment. The audit row is written **in the same transaction** as the write, or before returning the read.
- **Also audited (PRD 7.12):** every consultation status change, verification decision, suspension, schedule block that affects bookings, admin action on behalf of a user.
- Audit `metadata` holds ids, statuses, and reasons — never clinical text.
- All seed and demo data is fully synthetic.

---

## Cross-service integration

Care is the **consumer** in all three platform integration cases. All calls go through `lib/identity-client`; use the `cross-service-integration` skill. Hub detail: `../vcare-hub/architecture/landscape.md`.

**Client defaults:** per-attempt timeout **2 s**; retries with exponential backoff `200 ms · 2^attempt` ± 20 % jitter; forward `X-Request-Id`; parse responses through DTO validation (a malformed response is a failure, not data).

### Case 1 — Verification unlocks the account (synchronous, required)
`PATCH /admin/applications/:id/approve` (or `/reject` with a reason):
1. In one transaction: record the decision on the doctor profile (`verification_status`, `reviewed_by`, `review_note`, `decided_at`), set `identity_sync_status='pending'`, write the audit row.
2. Call `PATCH /internal/users/:id/status` → `active` (or `rejected`) with up to 3 attempts.
3. Success → `identity_sync_status='synced'`, respond 200. Failure → keep the decision, respond `202` with `identitySync: "pending"`; a background retrier keeps calling (the endpoint is idempotent) and raises an alert after 15 minutes unsynced.
4. The doctor is **not bookable** until `verification_status='approved'` **and** `identity_sync_status='synced'`.
5. **Re-open / resubmit** (`rejected → submitted`) follows the same path with Identity status `pending`, so the account returns to `pending` alongside the application.
6. A `409 InvalidStatusTransition` from Identity is **non-retryable**: set `identity_sync_status='failed'`, alert, and surface it in the admin console — retrying cannot fix drift.

### Case 2 — Batch profile hydration (synchronous, batched, cached, degrades)
Search results, consultation lists, and a doctor's patient list:
1. Collect distinct user ids from the page → **one** `GET /internal/users?ids=` call (chunks of ≤ 100). Never one call per row.
2. Read-through Redis cache `identity:user:<id>` (TTL 300 s); only cache misses go to Identity.
3. **Mapping:** Identity's `fullName` is exposed by Care as `displayName`; `avatarUrl` keeps its name; `status` is used only to hide non-active doctors from search, never for authorization.
4. **Degrade, never fail:** on timeout/error, serve cached entries, and for misses return `displayName: null`, `avatarUrl: null`, `profileHydrated: false`. Search still returns doctors, prices, and slots; booking never waits on hydration. Emit a `identity_hydration_degraded` metric.
5. At most 1 retry here (latency budget beats completeness).

### Case 3 — Suspension revokes sessions (synchronous, security-critical, must not degrade)
`PATCH /admin/doctors/:id/suspend` with a reason:
0. **Precondition:** only an approved, synced doctor (`verification_status='approved'`, `identity_sync_status='synced'`, `suspended_at IS NULL`) can be suspended; otherwise `409 InvalidTransition`. Suspending an already-suspended doctor is a 200 no-op.
1. In one transaction: set `doctor_profiles.suspended_at`, `suspension_reason`, `identity_sync_status='pending'`; flag every future non-terminal consultation `needs_admin_followup=true`; write audit rows. From this commit on, **no new bookings** and **no doctor actions** are possible in Care.
2. Call `PATCH /internal/users/:id/status` → `suspended` **until it succeeds**: inline attempts for ~6 s, then a durable retry job (backoff capped at 60 s, no attempt limit) that survives restarts. "Until it succeeds" covers transient failures (network, timeout, 429, 5xx, 401 token refresh). A `409 InvalidStatusTransition` is **not** transient: stop retrying, keep the local suspension, set `identity_sync_status='failed'`, and page on-call immediately.
3. Alert after **3 consecutive failures** (`IdentitySuspensionSyncFailing`, pages on-call).
4. Respond `200` only when Identity confirmed; otherwise `503 IdentityUnavailable` with `suspension: "applied-locally, session-revocation-pending"` — the admin UI must show that sessions are **not yet** revoked. Never report a suspension as complete before Identity confirms.

> Cases 2 and 3 use the same client with **opposite failure policies**. Choosing the wrong policy is a Critical review finding.

**Doctor account status — Care is the only initiator (hub ADR 0006):** Identity's admin status route refuses doctor targets, so every doctor account-status change goes through Cases 1 and 3 and Care's `suspended_at` / `identity_sync_status` always move with it. Care still excludes non-active doctors from search using fresh hydrated `status` as defence in depth. A `rejected` doctor can sign in at Identity, so resubmission is reachable. Reinstating a suspended doctor goes through Care as **Case 4** (below; hub ADR 0009).

### Case 4 — Reinstatement restores the account (synchronous, retry-report-pending)
`PATCH /admin/doctors/:id/reinstate` with a reason (care ADR 0012): precondition suspended **and** synced (else `409 InvalidTransition`; not suspended → 200 no-op); one transaction clears `suspended_at`, sets `identity_sync_status='pending'`, audits (follow-up flags stay); `PATCH /internal/users/:id/status` → `active` with the **Case 1** policy (3 attempts → `202 identitySync:"pending"` + durable job `kind='reinstatement'`; alert after 15 min; Identity 409 → `failed` + page). The doctor stays unbookable until synced. Requires Identity to allow `suspended → active` on its internal route (provider first).

**Notifications (PRD 7.11)** — booking confirmation, reminder, reschedule, cancellation, "doctor joined" — are sent **asynchronously** through the email port; delivery failure never blocks or rolls back a booking. Mechanism (ADR 0011): a `notification_outbox` row inserted **in the same transaction** as the write, delivered by `care-worker` (SKIP LOCKED, `dead` after 8 attempts); reminders by a 1-minute worker scan (`reminder_24h_sent_at`/`reminder_1h_sent_at`, reset on reschedule); recipient emails fetched at send time from Identity `GET /internal/users/contacts` (scope `users:contact:read`, worker only) — **never cached, stored, or logged** (hub ADR 0010). RabbitMQ is a future option, not MVP.

**Background work** runs only in the separate `care-worker` component (ADR 0008) — never in `care-api` tasks.

---

## Domain rules

Every rule here has a named unit test. "Enforced by" says where the guarantee lives.

**Scheduling**
1. A doctor can never have two overlapping consultations. — *DB exclusion constraint* (+ service pre-check).
2. A booking must fall inside the doctor's working hours for that date, evaluated in the **doctor's timezone**, after applying schedule exceptions. — *service, re-validated inside the booking transaction.*
3. No booking in the past; maximum horizon **60 days** (`BOOKING_HORIZON_DAYS`). — *service.*
4. Duration comes from the consultation type (`ends_at = starts_at + duration_minutes`), never a global constant or the client. — *service.*
5. Booking, reschedule, and cancel are transactional and idempotent on `Idempotency-Key`; concurrent attempts on one slot cannot both succeed. — *transaction + exclusion constraint + idempotency.*

**Eligibility**
6. Only doctors with `verification_status='approved'`, `identity_sync_status='synced'`, `suspended_at IS NULL`, `is_accepting_patients=true`, and at least one active consultation type appear in search or accept bookings.
7. Suspending a doctor flags all future non-terminal consultations for admin follow-up and blocks new bookings immediately (Case 3).
8. Patients must have a verified email (`ev=true`) before booking.

**Lifecycle** — `booked → waiting → in_progress → completed`; `cancelled` and `no_show` are terminal exits.

| Transition | Actor | Condition |
|---|---|---|
| `booked → waiting` | patient (`/join`) | inside the session window |
| `booked/waiting → in_progress` | assigned doctor (`/start`) | inside the session window |
| `in_progress → completed` | assigned doctor (`/complete`) | — |
| `booked/waiting → cancelled` | patient (outside policy window), assigned doctor (reason), admin (reason, any time) | not terminal |
| `booked/waiting → no_show` | assigned doctor or admin | now ≥ `starts_at` + grace |
| reschedule (`starts_at`/`ends_at` change, status stays `booked`) | patient (outside policy window), admin | new slot passes rules 1–5; old interval released in the same transaction |

9. Terminal states (`completed`, `cancelled`, `no_show`) cannot change. — *service + `CHECK`-guarded update (`WHERE status NOT IN (...)`).*
10. Patients cancel or reschedule only **outside the policy window** (default 2 h before start, `CANCELLATION_POLICY_MINUTES=120`); admins have no such restriction.
11. `no_show` only after `starts_at` + grace period (default 10 min, `NO_SHOW_GRACE_MINUTES=10`).
12. The video room opens only within the session window: `[starts_at − 10 min, ends_at + 15 min]` (`WAITING_ROOM_OPEN_MINUTES=10`, `SESSION_OVERRUN_MINUTES=15`).

**Clinical**
13. A medical record exists only for a `completed` consultation (one record per consultation, `uq_medical_records_consultation_id`).
14. Only the consultation's assigned doctor can write that record.
15. Records are **append-only after 24 h**: before `locked_at` the assigned doctor may update in place (each update audited); after `locked_at` a `PATCH /records/:id` creates a `medical_record_amendments` row and the original is untouched — never a silent overwrite. Attachments cannot be deleted after the lock (`RecordLocked`).
16. Patients read their own records and never write clinical fields.

**Access**
17. Patients access only their own consultations, records, and profile.
18. Doctors access their own schedule and the records of patients they have consulted.
19. Admins manage verification, suspension, bookings, and help content — **never clinical notes**.

**Data**
20. All timestamps stored in UTC; every user has a timezone and sees their own.
21. All list endpoints are paginated and filterable.
22. Soft delete for profiles and records; hard delete is never exposed.

**Schedule changes (PRD 7.3, flow F):** blocking time or overriding hours that intersects existing non-terminal consultations returns `409 ScheduleConflictsUnconfirmed` with the affected consultation ids; resubmitting with `confirmConflicts=true` applies the block, flags those consultations `needs_admin_followup`, and queues patient notifications — it never auto-cancels.

**Verification application states:** `draft → submitted → approved | rejected`; `rejected → submitted` when re-opened (admin) or resubmitted (doctor), which also sets the Identity account back to `pending` via the Case 1 path. Only `submitted` is reviewable.

---

## Testing policy

- **Unit tests** (`tests/unit/`): isolate one unit; mock collaborators (repositories, services, Redis, `identity-client`, clock, storage, video, email). Infra-failure scenarios are unit tests. `pkg/slots` is tested exhaustively as pure functions (DST forward/back, split shifts, exceptions, cross-midnight patient rendering). Fast (< 100 ms each).
- **Integration tests** (`tests/integration/`): supertest against the **real** wiring, **real** Postgres (with `btree_gist`), **real** Redis. **Never mock services or repositories.** Mock only system-external dependencies: **Identity** (a local fake HTTP server implementing the contract — including slow and failing modes), the video provider, storage, email. Truncate tables per suite; no infra mocks in `tests/setup.ts`.
- **Contract conformance:** assert status codes, error `code`s, and response shapes from `contracts/openapi.yaml`; Care's Identity fake is built from `../vcare-hub/contracts/identity-service.openapi.yaml`.
- **Mandatory scenarios:** each "Domain rules" rule; RBAC per route (wrong role, non-owner → 404/403, owner allowed, **admin denied on every clinical route**); two concurrent bookings for one slot → exactly one 201 and one 409; idempotent replay returns the same consultation, conflicting body → 422; Case 2 with Identity down still returns search results with `profileHydrated:false`; Case 3 with Identity down → 503, local suspension applied, retry job enqueued, bookings blocked; Case 1 pending sync keeps doctor unbookable; record after 24 h creates an amendment; every clinical read writes an audit row; logs captured during tests contain no clinical fixture strings; slot computation budget test (14 days, busy doctor) < 300 ms; pagination page 2 on the default sort; an upload whose stored bytes are not PDF/JPEG/PNG is rejected at `complete` and creates no row even with a `.pdf` filename and `application/pdf` Content-Type; an expired, closed, or another user's intent cannot be completed; replaying `complete` returns the same row; every `download-url` writes one audit row and admins get 403 on attachment `download-url`.
- Names: `should <do something> when <condition>`. Do not test the framework.

---

## Performance rules

1. No N+1 — batch with `= ANY($1)`; Identity hydration is one batched call per page.
2. Every query backed by an index; `EXPLAIN` search, slots, booking, and calendar queries before merging.
3. Never `SELECT *`.
4. **Budgets (p95):** doctor search < **400 ms** · slot computation for a 14-day window < **300 ms** · booking write < 200 ms · calendar/day view < 200 ms.
5. **Slot computation** loads inputs with a fixed number of queries (hours, exceptions, types, consultations in range — one each), computes in `pkg/slots` in memory, and caches the computed window in Redis (`slots:<doctorId>:<typeId>:<fromDate>:<toDate>`, TTL ≤ 60 s, invalidated on any booking/exception/hours/type change). Use the `timezone-slot-computation` skill.
6. **Search** filters on indexed columns (specialty, language, fee range, accepting, bookable) and sorts by earliest availability using a cached per-doctor `next_available_at` in Redis (derived, TTL-bound), never by computing slots for every row.
7. Read replicas serve discovery reads when introduced; writes and booking re-validation always hit the primary.
8. Notifications and retries run outside the request. Upload and download bytes never pass through `care-api`; `complete` reads at most 16 bytes of the object.

---

## Code style — what to avoid

- ❌ ORMs, decorators on entities, repository classes (use functions)
- ❌ Returning entities or rows from controllers; returning clinical fields to admins
- ❌ Cross-module repository imports; HTTP calls to Identity outside `lib/identity-client`
- ❌ Business logic in controllers or middleware
- ❌ A route without `authorize(...)`
- ❌ Trusting identity headers; trusting a user id from the request body for authorization
- ❌ Storing slots; computing availability in the client's or server's local timezone
- ❌ `Date` arithmetic for schedules — use `luxon` in `pkg/slots` / `pkg/utils/time.ts`
- ❌ Logging clinical data, PII, presigned URLs, object keys, or tokens
- ❌ Creating a document or attachment row before `complete` verified the stored bytes; trusting a filename or a declared `Content-Type`; embedding download URLs in read DTOs
- ❌ Overwriting a locked medical record; deleting audit rows
- ❌ Failing a search or booking because hydration failed; degrading a suspension
- ❌ `try { … } catch (e) { console.log(e) }`; `any` in signatures; inline `interface`/`type` outside `types.ts`
- ❌ Env vars not in `lib/config/env.ts`; defaults on secrets
- ❌ `SELECT *`; `TIMESTAMP` without time zone; hard `DELETE`
- ❌ Changing an endpoint's shape without changing `contracts/openapi.yaml` first

---

## Build order for a new module

0. **Contract** — add/adjust operations in `contracts/openapi.yaml` (`x-roles`, `x-ownership`, every error code, `Idempotency-Key` where required). If it needs a new Identity endpoint, Identity's contract lands first.
1. Migration (tables, constraints incl. exclusion/checks, indexes each commented).
2. `enums.ts`, `errors.ts`, `types.ts`.
3. Entity.
4. Request DTO(s).
5. Response DTO(s) (viewer-aware).
6. Repository functions.
7. Service (register in `container.ts`) — transactions, audit calls, identity-client calls with the correct failure policy.
8. `policies.ts`.
9. Controller (register in `container.ts`).
10. `routes.ts` (guard → authorize → idempotency → handler).
11. Mount in `src/routes.ts` or `src/internal-routes.ts`.
12. Tests (unit + integration + RBAC + contract conformance + concurrency where relevant).
13. Manual QA with CURL.
14. Docs (`docs/<module>/`, `docs/service-card.md`, `docs/INDEX.md`).

Implement one module end-to-end before starting the next (parallel modules only via `/develop-feature-e2e` worktrees).

---

## Out of scope

- Everything in PRD §13: payments, payouts, refunds · insurance · prescriptions/e-pharmacy · labs · the video infrastructure itself · chat between consultations · ratings/reviews · SMS/WhatsApp · group practices/clinics · mobile apps · waiting lists
- Message bus / events in MVP — HTTP only; `consultation.booked`, `consultation.cancelled`, `doctor.suspended`, … are future (no AsyncAPI contract yet); RabbitMQ is the candidate transport when an ADR adopts it
- Phase-2 AI capabilities (separate service; Care only guarantees the draft-confirm boundary and exposes internal APIs via service tokens)
- Account, credential, or token management (Identity)

---

## Workflow and documentation discipline

Feature work runs through slash commands, each backed by a focused subagent. **Every phase reads the relevant docs first and updates them as it works** — docs are part of the deliverable.

| Command | Does | Runs as |
|---|---|---|
| `/system-design <topic>` | interactive architecture dialogue → `docs/system-design.md`, `docs/architecture/*`, `docs/adr/*` for service scope; hub docs for platform scope (classified with the `docs-placement` skill) | inline |
| `/brainstorm <feature>` | interactive intent/scope → `docs/<module>/brainstorm.md` | inline |
| `/construct-spec <module>` | `docs/<module>/spec.md` (parallel recon when ≥ 2 large sources) | `flow-spec-author` |
| `/develop <module> [--fix-review]` | spec → `tasks.md` → code, task by task | `flow-developer` |
| `/write-tests <module>` | unit + integration + RBAC + contract + concurrency tests | `flow-test-author` |
| `/manual-qa <module>` | CURL every endpoint → `manual-qa.md` + `scripts/curl-test-<module>.sh` | `flow-qa-runner` |
| `/review-code <module>` | review lifecycle; parallel dimension reviewers + adversarial verification for non-trivial modules | `flow-code-reviewer` |
| `/update-docs <module>` | reconcile docs + contract with as-built code | `flow-docs-updater` |
| `/develop-feature-e2e <feature>` | the whole loop; independent units in parallel worktrees | orchestrates all |

`/review-code` is deliberately not named `code-review` (that would shadow the bundled command).
Subagents cannot spawn subagents, so **all fan-out is orchestrated by the command**, never inside an agent.

**Task status (`docs/<module>/tasks.md`):** `- [ ]` todo → `- [~]` in progress → `- [x]` done, each task tagged with its "Build order for a new module" step. Never mark `[x]` while typecheck or tests fail.

**Code-review lifecycle:** `/review-code` writes `docs/<module>/reviews/review-<YYYYMMDD-HHMM>.md` (findings `- [ ] OPEN — …` with `file:line`, failure scenario, fix, test gap); `/develop --fix-review` flips them to `- [x] RESOLVED — …` or `- [ ] DISPUTED — …`; re-running `/review-code` verifies each fix and **deletes the file only when everything is verified and nothing new is found**. No review file = clean module.

**Manual QA:** CURL against a local server with `Authorization: Bearer` tokens for a patient, a doctor, and an admin, `Idempotency-Key` on booking writes, and `X-Request-Id`; a local Identity (or its fake) must be running for Cases 1–3; compare to the contract's status and error codes, not to 200; never record clinical fixture text or tokens.

---

## Architect mode — /system-design

**Trigger:** the user says "let's system design" (any casing/phrasing of that intent) or runs `/system-design <topic>`.
Run the `/system-design` command **inline** — never delegate the dialogue or the writing to a subagent.

It works at architecture altitude, like `/brainstorm` one level up:
1. Read the hub first (`../vcare-hub/INDEX.md` → `architecture/overview.md`, then the platform docs the topic touches — `landscape.md`, `data-ownership.md`, `deployment.md`, `capacity.md` — the relevant PRD section, Identity's synced contract), then this repo's `docs/system-design.md`, `docs/architecture/*`, `docs/adr/*`, `contracts/openapi.yaml`.
2. Ask **one question at a time**; for each decision propose **2–3 options with trade-offs and a recommendation**; the user decides.
3. **Classify every output by scope** before writing (see "Doc placement — hub or service"; `docs-placement` skill).
4. Write service-scope results here: `docs/system-design.md` (router), `docs/architecture/<topic>.md` shard(s), `docs/adr/NNNN-<slug>.md` for each decision; flag required contract changes.
5. Write platform-scope results to the hub: `architecture/overview.md`, `deployment.md`, `capacity.md`, `landscape.md`, `data-ownership.md`, `glossary.md`, hub `adr/` for platform-wide decisions. Split topics (capacity, deployment, availability, observability) → the platform part and this service's roll-up row in the hub, the derivation here.

Decided 2026-09-15 (ADRs 0005–0012): availability 99.9 %, health split, metrics, `care-worker`, audit partitions, search ranking cache, notifications, reinstatement; Care capacity and deployment shards written. File handling decided the same day (ADRs 0013–0015, hub ADR 0011; `docs/architecture/file-handling.md`). Remaining good topic: doctor-initiated follow-up booking.

---

## Documentation structure

```
docs/
  INDEX.md             # router — READ FIRST
  service-card.md      # 30-second summary — synced to ../vcare-hub/catalog/care-service.card.md
  system-design.md     # architecture ROUTER → architecture/*.md (one doc = one job)
  architecture/        # SERVICE SCOPE ONLY: overview, data-model, api, scheduling-slots, consultation-lifecycle,
                       # clinical-records, rbac, integration, resilience, infrastructure, future
  runbook.md           # on-call (how-to lens)
  quickstart.md        # first local run (tutorial lens)
  adr/NNNN-*.md        # append-only decisions
  <module>/            # created by the workflow: brainstorm, spec, tasks, manual-qa, reviews/
contracts/
  openapi.yaml         # SOURCE OF TRUTH for the HTTP API (public + /internal)
```

**Doc rules (enforced by every workflow command):**
1. **Frontmatter is mandatory** on every doc under `docs/`: `title, owner, service, status, last_verified, tags, related` (+ `module` for module docs, `diataxis` where it applies). Set `last_verified` to today (absolute date) whenever you touch a doc.
2. **The contract is the source of truth.** `spec.md` and `architecture/api.md` mirror `contracts/openapi.yaml`; on disagreement the contract wins.
3. **`docs/INDEX.md` stays current:** every doc has a row with "read it when…" and its Diátaxis lens.
4. **Diátaxis is a label, not a folder tree** — no `tutorials/`, `how-to/`, `reference/`, `explanation/` directories.
5. **Service card ↔ hub:** update `docs/service-card.md` when responsibilities, owned data, dependencies, or endpoints change; the hub is populated by `../vcare-hub/scripts/sync-from-spoke.sh` — never hand-copy into the hub.
6. **Decisions → ADRs** (`docs/adr/NNNN-*.md`), append-only; supersede, never rewrite.
7. **No per-module folders ahead of time** — `/brainstorm` creates `docs/<module>/` when the module is started.
8. **Clinical examples in docs are synthetic and minimal** — never paste realistic patient data into any doc, spec, or QA record.
9. **Place every doc by scope** (hub ADR 0008): platform-scope content goes to the hub, service-scope content stays here, split topics use the hub roll-up; never `service: platform` in this repo. See "Doc placement — hub or service".
10. **Keep all three repos in sync in the same session.** Any change that affects care, identity, or the hub updates every affected doc, `AGENTS.md`, and shared skill in all three. A Stop hook (`.codex/hooks/docs-sync-check.sh`, identical in both spokes) enforces it: hub freshness, retired terms from `.codex/hooks/retired-terms.txt`, and hub card/contract drift. When a decision retires a name, add it to `retired-terms.txt` in both spokes.

---

## Doc placement — hub or service

Every doc and every fact has **one home, decided by scope** — never by the repo you happen to be working in (hub ADR 0008). Step-by-step procedure, placement table, and checklist: the `docs-placement` skill.

**Scope test — "whose code makes this true, and who must agree on it?"**

| If the doc or fact… | Scope | Home |
|---|---|---|
| describes the platform as a whole or two or more services: system context and container views, edge routing, network zones, how every service is deployed, the release pipeline, the availability roll-up, shared traffic assumptions, cross-service load, integration cases and failure policies, data ownership, shared terms, platform-wide decisions | **platform** | the hub — `../vcare-hub/architecture/{overview,deployment,capacity,landscape,data-ownership}.md`, `glossary.md`, `adr/`, `product/prd.md` |
| is made true only by this service's code: module map, layering, request pipeline, data model, API prose, env vars, this service's capacity derivation, runtime components and scaling, bottlenecks, metrics and alerts, runbook, quickstart, service decisions, module docs | **service** | this repo — `docs/` |
| has both parts (capacity, deployment, availability, observability, data ownership) | **split** | hub: the platform part + one **roll-up** row per service with headline values and a link; here: the derivation, linking to the hub for its inputs |

**When to read the hub**
- Working on this service's internals (a module, migration, route, test) → read `AGENTS.md` and `docs/` only.
- Touching edge routing, networking, deployment, scaling, availability, release, or observability → hub `architecture/deployment.md` first, then the local shard.
- Sizing anything or changing a load assumption → hub `architecture/capacity.md` first, then the local capacity shard.
- Touching a cross-service call, borrowed data, or a shared term → hub `landscape.md`, `data-ownership.md`, `glossary.md`, the other service's synced contract.
- Orienting on the whole system → hub `INDEX.md` → `architecture/overview.md`.

**When to write where**
- **Author each number once.** Platform inputs are authored in the hub; values derived from them are authored here. A local doc may quote a hub value only with a link to it — it is never the place to change it.
- Frontmatter `service: platform` ⇔ the file lives in the hub. Never create a `service: platform` doc here, and never copy a hub doc here; link to it. The Stop hook blocks the first.
- Only `/system-design` hand-edits hub docs (never the synced `catalog/*.card.md` or `contracts/*`). Every other phase writes this repo's `docs/` and **lists** platform deltas for `/system-design`.
- Changing a headline the hub rolls up (task counts, DB class, storage, availability target) updates the hub row in the same session.
- `docs/service-card.md` names hub docs in plain text — the sync rewrites its relative links to point into this repo.

---

## Cross-service context (the hub)

This repo knows only itself. For Identity's contract, who calls whom, data ownership, glossary terms, platform deployment or capacity, or the PRD → the hub at `../vcare-hub`, starting at `INDEX.md`.

Retrieval escalates **cheapest first**; stop as soon as you have the answer:
1. **Local** — grep this repo.
2. **Hub `INDEX.md`** — find where the answer lives.
3. **Hub content** — platform overview, deployment topology, capacity model, landscape (integration), data-ownership, catalog cards, synced contracts, ADRs, glossary, PRD. Every platform-scope answer ends here.
4. **Sibling repo on disk?** If you need detail the hub lacks, check for `../vcare-identity-api`. If present, read its docs directly. **If unsure whether it is checked out, ASK the user** before reaching out.
5. **GitHub MCP peek** — only if not local; read the specific file. Still no clone.
6. **Clone** — only to actually change or run that service. Never clone just to read docs.
