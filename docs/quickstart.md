---
title: Care Service — Quickstart
owner: care-team
service: care-service
status: draft
diataxis: tutorial
last_verified: 2026-10-08
tags: [tutorial, getting-started, care, docker, health]
related: [infrastructure, api, integration, scheduling-slots, foundation-spec, access-spec, runbook]
---

# Quickstart (tutorial)

From zero to a running service on your machine, then (once the modules exist) to a booked consultation.

> **Built today (foundation 2026-09-28, access 2026-10-02, specialties 2026-10-04, doctors 2026-10-05, verification 2026-10-08):** both listeners, the four health
> probes, migrations (incl. `audit_logs`, the app database role, and the `specialties` table with its 20-row synthetic
> starter catalog), user-token verification against Identity's JWKS, the worker with its `audit-partitions` loop, and
> the specialty catalog routes, doctor onboarding, and verification (verified document upload, submission, admin queue and decision, the `identity-sync` and `upload-intent-purge` worker loops). They need a user token from a running Identity — see `scripts/curl-test-specialties.sh` and `scripts/curl-test-verification.sh` for full examples. Case 1 additionally needs an Identity that serves `/internal/users` and `/internal/users/{id}/status`; real Identity does not yet (its internal-users module is pending), so use a contract-compliant shim, or accept `202 identitySync: pending`. Steps 1–3 work now. Steps 4–9 are marked `(planned)`: they show the intended shape once the business
> modules are built through the workflow. All ids and text below are synthetic.

## 1. Prerequisites
- Node.js 24 LTS (`engines` is `>=24 <25`, enforced by `engine-strict`)
- Docker with Compose — the local stack runs PostgreSQL 17 (with `btree_gist`), Redis 7, and MinIO (S3 for verification uploads; a digest-pinned community build, [ADR 0020](./adr/0020-local-s3-emulator-image.md))
- For steps 4–9 only `(planned)`: a running identity-service on `3000` (public, JWKS) and `3100` (internal), or a
  local fake built from `../vcare-hub/contracts/identity-service.openapi.yaml` that serves JWKS,
  `/internal/auth/token`, `/internal/users`, and `/internal/users/:id/status`, plus a service client registered in
  Identity for Care with scopes `users:read users:status:write`

## 2. Configure
```bash
cp .env.example .env
```
`.env.example` targets the compose infrastructure with the app on the host (full list in
[architecture/infrastructure.md](./architecture/infrastructure.md)):
```bash
NODE_ENV=development
PORT=3001
INTERNAL_PORT=3101
INTERNAL_HOST=127.0.0.1                                  # must be an IP literal, not "localhost"
MIGRATION_DATABASE_URL=postgres://care:care@localhost:5433/care      # OWNER: only the migrate commands use it
DATABASE_URL=postgres://care_app:care_app@localhost:5433/care         # APP login (care_app): care-api, care-worker
REDIS_URL=redis://localhost:6380
IDENTITY_JWKS_URL=http://localhost:3000/.well-known/jwks.json         # wherever your local identity public listener runs
IDENTITY_INTERNAL_URL=http://localhost:3100                           # Identity internal listener (service token, users, status)
SERVICE_CLIENT_ID=care-local-synthetic                                # synthetic; register the same client in Identity
SERVICE_CLIENT_SECRET=synthetic-local-service-secret
STORAGE_BUCKET=care-private                                           # MinIO from compose; private bucket
STORAGE_REGION=us-east-1
STORAGE_ENDPOINT=http://localhost:9002
STORAGE_ACCESS_KEY_ID=care-local
STORAGE_SECRET_ACCESS_KEY=synthetic-minio-secret
STORAGE_FORCE_PATH_STYLE=true
AUDIT_PARTITION_MONTHS_AHEAD=2
CORS_ORIGINS=http://localhost:5173                       # honoured only in development
```
The two database URLs must name **different** roles: migrations run as the owner `care`; the app logs in as
`care_app`, which `npm run migrate:ensure-app-login` creates from `DATABASE_URL`
([ADR 0018](./adr/0018-db-role-split-explicit-grants-partition-function.md)). Neither URL may carry `options`,
`statement_timeout`, `query_timeout`, or `application_name` in its query string. `IDENTITY_JWKS_URL` has no default:
Care boots without Identity (readiness shows `identityJwks: "down"`), but every authenticated request answers `401`
until the JWKS can be fetched. `IDENTITY_INTERNAL_URL`, `SERVICE_CLIENT_ID`, `SERVICE_CLIENT_SECRET` and the `STORAGE_*` variables are required (verification, 2026-10-08); the TTL and worker-interval variables have defaults (see the full list in the infrastructure shard). If a value is invalid, the process
exits at once with one `invalid_environment` line naming the key (see [runbook.md](./runbook.md) → Boot and
shutdown log lines).

## 3. Install, migrate, run

### Option A — app on the host (hot reload)
```bash
npm install
docker compose up -d postgres redis minio minio-setup   # Postgres 127.0.0.1:5433, Redis 127.0.0.1:6380, MinIO 127.0.0.1:9002 (host loopback only); Git Bash: prefix with MSYS_NO_PATHCONV=1
npm run migrate                       # as the owner: btree_gist, the vcare_app role, audit_logs + partitions
npm run migrate:ensure-app-login      # creates/updates the care_app login from DATABASE_URL
npm run dev                           # public listener :3001, internal listener 127.0.0.1:3101
npm run dev:worker                    # care-worker: audit-partitions (daily), identity-sync (10 s), upload-intent-purge (5 min)
# one tick of a loop: npm run build && node dist/worker.js --once identity-sync   (or upload-intent-purge)
```

### Option B — everything in containers
```bash
docker compose up -d --build          # postgres, redis, minio (+ minio-setup), migrate (one-off: latest + ensure-app-login), care-api, care-worker
```
The containers reach a host-run Identity at `host.docker.internal:3000`; override with `IDENTITY_JWKS_URL=… docker
compose up -d`.
`care-api` runs with `NODE_ENV=production` here (so CORS is off); its public listener is published on `3001`, the
internal listener on `127.0.0.1:3101` only.

### Check it
```bash
curl -s http://localhost:3001/api/health/live       # {"status":"ok"}
curl -s http://localhost:3001/api/health/ready      # {"status":"ok","checks":{"database":"up","redis":"up","identityJwks":"up"}}
curl -s http://127.0.0.1:3101/internal/health/ready # same body, internal listener
```
Stop Redis (`docker compose stop redis`) and readiness stays `200` with `"status":"degraded"`; stop Postgres and it
turns `503` with `"status":"down"`. `identityJwks` is `"up"` only while Identity's JWKS was fetched within the last
hour and the latest refresh succeeded; it never changes the status code. The old `GET /api/health` no longer exists and returns a `404 NotFound` envelope.
Health requests are logged at `debug`, so they do not appear at `LOG_LEVEL=info`.

Other useful commands: `npm run migrate:status`, `npm run migrate:rollback`, `npm run migrate:make <snake_name>`
(all load `.env`), `npm run dev:worker`, `npm test`, and
`npm run test:infra:up && npm run test:integration` (test stack on `127.0.0.1:5434` / `127.0.0.1:6381`).

### If `npm run migrate` says "migration directory is corrupt"
Migration names are recorded **without** the file extension since 2026-09-28. A dev volume migrated earlier still
holds `20260915000000_create_extension_btree_gist.js`. Either recreate the dev database (this deletes all local data):
```bash
docker compose down -v
```
or rename the recorded rows in place:
```bash
docker compose exec postgres psql -U care -d care \
  -c "UPDATE knex_migrations SET name = regexp_replace(name, '\.(js|ts)$', '')"
```
The test stack keeps its data on `tmpfs`, so it never needs this.

### Migrating an existing dev volume in place (access, 2026-10-02)
A dev database created before `access` keeps its data; only the roles and `audit_logs` are added:
```bash
cp .env .env.bak && diff .env .env.example          # add MIGRATION_DATABASE_URL, IDENTITY_JWKS_URL, AUDIT_PARTITION_MONTHS_AHEAD;
                                                     # switch DATABASE_URL to care_app (see step 2)
npm run migrate                                      # runs as the owner (MIGRATION_DATABASE_URL)
npm run migrate:ensure-app-login                     # creates care_app (member of vcare_app)
```
No business tables exist yet, so there is nothing to re-grant. The test databases are disposable instead:
`npm run test:infra:down && npm run test:infra:up` (the integration global setup migrates and provisions `care_app`).

## 4. Get tokens (planned)
Log in through Identity (tokens come from Identity, never from Care):
```bash
PATIENT=$(curl -s -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"patient1@example.test","password":"<synthetic>"}' | jq -r .data.accessToken)
ADMIN=$(curl -s -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin1@example.test","password":"<synthetic>"}' | jq -r .data.accessToken)
```
The patient must have a verified email (`ev=true`) to book.

## 5. Admin approves a doctor (Integration Case 1)
A seeded doctor (user id `204`) has submitted an application (profile id `12`):
```bash
curl -s -X PATCH http://localhost:3001/api/admin/applications/12/approve \
  -H "Authorization: Bearer $ADMIN" -H "Content-Type: application/json" \
  -H "X-Request-Id: 5b3c1e8a-2f4d-4a61-9e0b-7c2d1a3f4e55" \
  -d '{"note":"Documents verified"}'
```
- `200` → Identity confirmed the account is `active`; the doctor becomes bookable once they have hours and a type.
- `202` with `identitySync: "pending"` → Identity was unreachable; the decision is kept and a retry job runs.
  The doctor stays **unbookable** until synced. Stop your Identity fake to see this path; `node dist/worker.js --once identity-sync` retries once. Against real Identity today this is always the outcome (its internal status route is not deployed yet).
- `409` with `Retry-After: 5` → the account is still `pending` from a resubmit/reopen that has not reached Identity; retry after the sync.

## 6. Search doctors (planned)
```bash
curl -s "http://localhost:3001/api/doctors?specialty=dermatology&language=ar&sort=earliest_availability&limit=10" \
  -H "Authorization: Bearer $PATIENT"
```
If Identity is down, results still arrive with `displayName: null` and `profileHydrated: false`.

## 7. See slots in your timezone (planned)
```bash
curl -s "http://localhost:3001/api/doctors/204/slots?typeId=31&from=2026-09-21T00:00:00Z&to=2026-09-28T00:00:00Z&timezone=America/New_York" \
  -H "Authorization: Bearer $PATIENT"
```
Each slot has `startsAt`/`endsAt` in UTC and `startsAtLocal`/`endsAtLocal` rendered in `America/New_York`.
A doctor's Monday morning in `Africa/Cairo` may show as your Sunday night.

## 8. Book with an Idempotency-Key (planned)
```bash
KEY=$(uuidgen)
curl -s -X POST http://localhost:3001/api/consultations \
  -H "Authorization: Bearer $PATIENT" -H "Content-Type: application/json" \
  -H "Idempotency-Key: $KEY" \
  -d '{"doctorId":204,"typeId":31,"startsAt":"2026-09-21T06:00:00Z","complaintText":"Synthetic example complaint","patientTimezone":"America/New_York"}'
```
Expect `201` with `status: "booked"`. Run the **same** command again: you get the same consultation back, not a
second booking. Change the body but keep the key: `422 IdempotencyConflict`. Book the same slot with a new key:
`409 SlotUnavailable`. Send the same key again while the first request is still running: an immediate
`409 Conflict` with `Retry-After: 1`; retry after a second to get the replay.

## 9. List your consultations (planned)
```bash
curl -s "http://localhost:3001/api/consultations?scope=upcoming" -H "Authorization: Bearer $PATIENT"
```

## Next
- Routes, roles, and error codes → [architecture/api.md](./architecture/api.md) and [the contract](../contracts/openapi.yaml)
- How slots are computed → [architecture/scheduling-slots.md](./architecture/scheduling-slots.md)
- What happens when Identity is down → [architecture/integration.md](./architecture/integration.md)
