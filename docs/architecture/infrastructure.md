---
title: Infrastructure
owner: care-team
service: care-service
status: draft
diataxis: reference
last_verified: 2026-09-14
tags: [infrastructure, env, logging, errors, health, configuration]
related: [overview, resilience, runbook, quickstart]
---

# Infrastructure — care-service

## Environment variables
Every variable is declared and validated in `lib/config/env.ts` (zod); the process refuses to start on invalid
env. **Secrets have no defaults.** Values shown are local defaults.

| Variable | Default (local) | Secret | Purpose |
|---|---|---|---|
| `NODE_ENV` | `development` | | |
| `PORT` | `3001` | | public listener (`/api/*`) |
| `INTERNAL_PORT` | `3101` | | internal listener (`/internal/*`), private interface only |
| `DATABASE_URL` | `postgres://care:care@localhost:5432/care` | yes (credentials) | primary |
| `DATABASE_READ_URL` | unset | yes | optional read replica for discovery reads |
| `DATABASE_POOL_MAX` | `20` | | |
| `REDIS_URL` | `redis://localhost:6379` | yes (credentials) | caches, idempotency, rate limits |
| `IDENTITY_JWKS_URL` | `http://localhost:3000/.well-known/jwks.json` | | user-token verification keys |
| `IDENTITY_INTERNAL_URL` | `http://localhost:3100` | | Identity internal listener |
| `IDENTITY_TIMEOUT_MS` | `2000` | | per-attempt timeout for Identity calls |
| `SERVICE_CLIENT_ID` | `care-service` | | client-credentials id |
| `SERVICE_CLIENT_SECRET` | — | **yes, no default** | client-credentials secret |
| `JWT_AUDIENCE` | `vcare-care` | | expected `aud` on user and service tokens |
| `JWT_ISSUER` | `vcare-identity` | | expected `iss` |
| `HYDRATION_CACHE_TTL_SECONDS` | `300` | | Case 2 cache TTL |
| `SIGNED_URL_SECRET` | — | **yes, no default** | HMAC key for document/attachment URLs |
| `SIGNED_URL_TTL_SECONDS` | `600` | | must be ≤ 600 |
| `BOOKING_HORIZON_DAYS` | `60` | | Domain rule 3 |
| `CANCELLATION_POLICY_MINUTES` | `120` | | Domain rule 10 |
| `NO_SHOW_GRACE_MINUTES` | `10` | | Domain rule 11 |
| `WAITING_ROOM_OPEN_MINUTES` | `10` | | Domain rule 12 (window opens before start) |
| `SESSION_OVERRUN_MINUTES` | `15` | | Domain rule 12 (window closes after end) |
| `SLOT_CACHE_TTL_SECONDS` | `60` | | must be ≤ 60 |
| `NEXT_AVAILABLE_CACHE_TTL_SECONDS` | `300` | | |
| `STORAGE_ENDPOINT` | `http://localhost:9000` | | S3-compatible object storage |
| `STORAGE_REGION` | `us-east-1` | | |
| `STORAGE_BUCKET` | `care-private` | | private bucket; never public |
| `STORAGE_ACCESS_KEY_ID` | — | **yes, no default** | |
| `STORAGE_SECRET_ACCESS_KEY` | — | **yes, no default** | |
| `UPLOAD_MAX_BYTES` | `10485760` | | 10 MB cap |
| `VIDEO_PROVIDER_URL` | provider base URL | | room provider behind `lib/video` |
| `VIDEO_PROVIDER_KEY` | — | **yes, no default** | |
| `VIDEO_JOIN_TOKEN_TTL_SECONDS` | `300` | | per-participant token lifetime |
| `EMAIL_PROVIDER_URL` | provider base URL | | behind `lib/email` |
| `EMAIL_PROVIDER_KEY` | — | **yes, no default** | |
| `EMAIL_FROM` | `no-reply@vcare.example.test` | | |
| `CORS_ORIGINS` | `http://localhost:5173` | | comma-separated allowlist |
| `LOG_LEVEL` | `info` | | `debug` only in development |
| `RATE_LIMIT_SEARCH_PER_IP_PER_MIN` | `60` | | |
| `RATE_LIMIT_SEARCH_PER_USER_PER_MIN` | `120` | | |
| `RATE_LIMIT_BOOKING_PER_USER_PER_MIN` | `10` | | |
| `RATE_LIMIT_UPLOADS_PER_USER_PER_HOUR` | `20` | | |

## Database connection
- `pg` pool via Knex; every connection runs `SET TIME ZONE 'UTC'`.
- Migrations are raw SQL (`knex.raw`), one change per file, real `down` ([ADR 0001](../adr/0001-no-orm-knex-raw-sql.md)).
  The first migration creates `btree_gist`.
- The application role (`vcare_app`) has `INSERT`/`SELECT` only on `audit_logs` and `medical_record_amendments`.
- **Read replica (when introduced):** discovery reads (search, doctor profile, slots) may use `DATABASE_READ_URL`.
  Writes, booking/reschedule re-validation, ownership checks for clinical data, and audit writes always use the
  primary. Replica lag is acceptable for discovery because booking re-proves availability on the primary.

## Logging
Structured JSON, one line per event:
`level, message, timestamp (ISO UTC), requestId, service="care-service", userId?, role?, route, status, durationMs`.

**Never logged:** complaint text, examination notes, diagnosis text or code, treatment plans, allergies, chronic
conditions, blood type, date of birth, document or attachment contents, object keys, signed URLs, names, emails,
phones, `Authorization` headers, service or video tokens, request bodies of clinical or consultation routes.
The logger also redacts these keys by name (`complaintText`, `examinationNotes`, `diagnosisText`, `diagnosisCode`,
`treatmentPlan`, `allergies`, `chronicConditions`, `bloodType`, `dateOfBirth`, `objectKey`, `downloadUrl`,
`joinToken`, `authorization`, `fullName`, `displayName`, …) as defence in depth — callers must not pass them.
Tests assert that captured logs contain no clinical fixture strings.

## Error envelope
Produced only by `lib/error/errorHandler.ts`, identical to identity-service:
```json
{ "success": false, "error": { "code": "SlotUnavailable", "message": "The selected slot is no longer available", "details": [], "requestId": "3f0e4c1a-7b5d-4e2a-9c61-0d2b8a6f5e11" } }
```
- `details` is `[{ field, issue }]` for `ValidationFailed`.
- Two errors add a sibling member next to `error`: `ScheduleConflictsUnconfirmed` adds `conflicts.consultationIds`;
  the Case 3 `IdentityUnavailable` adds `suspension: "applied-locally, session-revocation-pending"`.
- Unknown errors → `InternalError` (500); stacks are logged server-side only.
- Codes are PascalCase and stable forever; the list is the `ErrorCode` enum in the contract.

## Request id
`lib/request-id` adopts an incoming `X-Request-Id` if it is a UUID, otherwise generates one; sets `req.requestId`;
echoes it on every response; binds it to every log line; writes it to `audit_logs.request_id`; forwards it on
every Identity call; stores it on `identity_sync_jobs` so retries keep the trace.

## Health
| Endpoint | Listener | Checks | Status |
|---|---|---|---|
| `GET /api/health` | public | Postgres `SELECT 1`, Redis `PING`, JWKS cache state (informational) | 200 `ok`/`degraded`, 503 `down` if Postgres or Redis fails |
| `GET /internal/health` | internal | same | same |
Identity reachability is **not** a health dependency: Care must stay up (degraded) when Identity is down.

## HTTP hardening
`helmet`; CORS allowlist from `CORS_ORIGINS`; `Cache-Control: no-store` on clinical and consultation responses;
body size limits (JSON 100 kB, multipart 10 MB); Redis sliding-window rate limits as listed above; graceful
shutdown drains both listeners and stops the retrier loop after its current batch.

## Deployment shape
One container image, two listeners. The public ingress routes only `/api/*` to `PORT`; `INTERNAL_PORT` is exposed
only on the private network to identity-service's egress and admin tooling. The retrier loop runs in every
instance (`SKIP LOCKED` keeps it safe).
