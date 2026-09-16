---
title: Infrastructure
owner: care-team
service: care-service
status: draft
diataxis: reference
last_verified: 2026-09-15
tags: [infrastructure, env, logging, errors, health, configuration, deployment]
related: [overview, resilience, runbook, quickstart, deployment, capacity, adr-0006-health-split-redis-tier-2, hub-deployment, hub-adr-0005-single-origin-edge-routing, hub-adr-0007-managed-container-platform]
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
| `UPLOAD_INTENT_TTL_SECONDS` | `900` | | upload intent lifetime ([file-handling.md](./file-handling.md), ADR 0013) |
| `UPLOAD_POLICY_TTL_SECONDS` | `300` | | presigned POST validity; must be ≤ `UPLOAD_INTENT_TTL_SECONDS` |
| `DOWNLOAD_URL_TTL_SECONDS` | `60` | | presigned GET validity; must be ≤ 60 (ADR 0014) |
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
| `CORS_ORIGINS` | `http://localhost:5173` | | comma-separated allowlist — local development only; production is single-origin with CORS disabled (hub ADR 0005) |
| `LOG_LEVEL` | `info` | | `debug` only in development |
| `RATE_LIMIT_SEARCH_PER_IP_PER_MIN` | `60` | | |
| `RATE_LIMIT_SEARCH_PER_USER_PER_MIN` | `120` | | |
| `RATE_LIMIT_BOOKING_PER_USER_PER_MIN` | `10` | | |
| `RATE_LIMIT_UPLOADS_PER_USER_PER_HOUR` | `20` | | |
| `RATE_LIMIT_FALLBACK_DIVISOR` | `2` | | per-instance fallback limit when Redis is down ([ADR 0006](../adr/0006-health-split-redis-tier-2.md)) |
| `WORKER_POLL_INTERVAL_MS` | `1000` | | `care-worker` outbox and sync-job polling ([ADR 0008](../adr/0008-care-worker-component.md)) |
| `WORKER_BATCH_SIZE` | `20` | | rows claimed per poll |
| `OUTBOX_MAX_ATTEMPTS` | `8` | | notification attempts before `dead` ([ADR 0011](../adr/0011-notification-outbox-and-reminders.md)) |
| `OUTBOX_RETENTION_DAYS` | `30` | | purge of `sent` outbox rows |
| `REMINDER_SCAN_INTERVAL_MS` | `60000` | | reminder scan cadence |
| `AUDIT_PARTITION_MONTHS_AHEAD` | `2` | | partitions pre-created ([ADR 0009](../adr/0009-audit-logs-monthly-partitions.md)) |

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
conditions, blood type, date of birth, document or attachment contents, object keys, presigned URLs and POST fields, names, emails,
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

## Health ([ADR 0006](../adr/0006-health-split-redis-tier-2.md))
| Endpoint | Listener | Checks | Status |
|---|---|---|---|
| `GET /api/health/live`, `GET /internal/health/live` | both | event loop responsive; no dependencies | 200 `ok` |
| `GET /api/health/ready`, `GET /internal/health/ready` | both | Postgres `SELECT 1` (500 ms, fatal); Redis `PING` and JWKS cache state (reported only) | 200 `ok`/`degraded`; 503 if Postgres is down or shutdown is in progress |
Load balancers use readiness; the orchestrator restarts on liveness. Redis is Tier 2 and never fails readiness.
Identity reachability is **not** a health dependency: Care must stay up (degraded) when Identity is down.
(Contract change pending: these replace `GET /api/health` and `GET /internal/health`.)

## HTTP hardening
`helmet`; CORS allowlist from `CORS_ORIGINS` in development only (single origin in production, hub ADR 0005); `Cache-Control: no-store` on clinical and consultation responses;
body size limits (JSON 100 kB; no multipart routes — file bytes go straight to object storage, ADR 0013); Redis sliding-window rate limits as listed above; graceful
shutdown drains both listeners and stops the retrier loop after its current batch.

## Runtime notes
The platform deployment topology — edge routing, private network, every service's components, the availability
roll-up, and the release pipeline — is platform-scope and authored in the hub
(`../vcare-hub/architecture/deployment.md`; hub ADRs 0005, 0007, 0008). Care-specific runtime facts:

- One image runs both listeners; `PORT` receives every `/api/*` prefix the edge does not route to Identity;
  `INTERNAL_PORT` admits only registered service clients and admin tooling.
- Background loops (Identity-sync retrier, notification outbox, reminders, `next-available` refresh, audit
  partitions) run in the separate `care-worker` component ([ADR 0008](../adr/0008-care-worker-component.md));
  graceful shutdown stops each loop after its current batch.
- Outbound: `care-api` → Identity internal LB and JWKS, video room provider, object storage; `care-worker` →
  Identity internal LB, email provider.

Components, sizing, availability, metrics, and alerts: [deployment.md](./deployment.md) and [capacity.md](./capacity.md).