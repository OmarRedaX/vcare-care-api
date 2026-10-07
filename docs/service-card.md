---
title: Care Service — Service Card
owner: care-team
service: care-service
status: draft
diataxis: reference
last_verified: 2026-10-08
tags: [service-card, catalog, care]
related: [index, system-design, runbook, integration, data-model]
sync_to_hub: catalog/care-service.card.md
---

# Service Card — care-service

> The cross-cutting summary the hub syncs into `../vcare-hub/catalog/care-service.card.md`
> (via `../vcare-hub/scripts/sync-from-spoke.sh` — never hand-copy). Keep it short and current.

| Field | Value |
|---|---|
| **Name** | care-service |
| **Repo** | `vcare-care-api` |
| **Owner** | care-team |
| **Status** | Foundation, access, specialties, doctor own-profile onboarding, and verification are built and tested (verification 2026-10-08: unit 1154, integration 489, manual QA 274 pass). Verification adds verified direct document upload, submission, the admin review queue and decision, Case 1 with a durable `identity-sync` worker loop, Case 2 hydration on the admin views, and the `upload-intent-purge` loop. Case 1 cannot reach `synced` against real Identity until its internal-users module (`GET /internal/users`, `PATCH /internal/users/{id}/status`) lands; Care keeps the decision and answers 202 pending meanwhile. Search, schedules, and other business modules remain designed. |
| **Tier** | 1 (booking and consultations are on the synchronous patient path) · availability target **99.9 %** monthly (ADR 0005) |
| **Runtime** | Node.js 24 LTS + TypeScript (strict), Express 5. `care-api`: two listeners, public `PORT=3001` (`/api/*`), internal `INTERNAL_PORT=3101` (`/internal/*`), 2–6 tasks. `care-worker`: built loops `audit-partitions`, `identity-sync`, `upload-intent-purge`; planned notification outbox, reminders, cache refresh (1 task) |
| **Datastores** | PostgreSQL 17 (own `care` database, `btree_gist`; primary + async replica; up to `DATABASE_POOL_MAX` + 1 readiness-probe connection per API task, 4 per worker task; two roles — owner `care` for migrations only, app login `care_app` in the `NOLOGIN` group `vcare_app` for `care-api`/`care-worker`, explicit per-table grants, `audit_logs` append-only by grant with column-level `INSERT` — ADR 0018) · Redis 7, Tier 2 (slot/next-available cache, hydration cache, idempotency, rate limits) · object storage (verification documents, record attachments; private bucket; presigned upload with byte verification, 60 s presigned download on demand — ADRs 0013–0014) |

## Responsibilities
The medical marketplace: doctor profiles and credentialing, specialties, working hours, schedule
exceptions and consultation types, computed availability (slots are never stored), booking and the
consultation lifecycle (waiting room, session join, no-show), patient profiles, medical records with a
24 h lock and amendments, help articles (the Phase-2 RAG corpus), and the audit log for all of it.

## Data owned
`specialties`, `doctor_profiles`, `doctor_specialties`, `doctor_languages`, `verification_documents` (built), `upload_intents` (built),
`working_hours`, `schedule_exceptions`, `consultation_types`, `consultations`, `patient_profiles`,
`medical_records`, `medical_record_amendments`, `record_attachments`, `help_articles`, `audit_logs`,
`identity_sync_jobs` (built), `notification_outbox`. Identity accounts are referenced only by `*_user_id BIGINT` (no cross-database FK).
Detail: [architecture/data-model.md](./architecture/data-model.md).

## Depends on
| Dependency | Interface | For | Failure policy |
|---|---|---|---|
| identity-service | `GET /.well-known/jwks.json` (public, port 3000; `IDENTITY_JWKS_URL`) | local verification of user access tokens: in-memory cache refreshed every 5 min (Identity's `max-age`), demand refetch on an unknown `kid` ≤ 1/min | **degrade to cache, fail closed**: cached keys trusted ≤ 1 h after the last successful fetch, then none; no matching key → `401 Unauthorized`, never a skipped verification; readiness reports `checks.identityJwks: up\|down` (informational, never fails readiness); alert `IdentityJwksStale` at 30 min |
| identity-service | `POST /internal/auth/token` (internal, port 3100) | client-credentials service token, scopes `users:read users:status:write` | cached to 30 s before `exp`, single-flight, one refresh on 401; needed by the cases below |
| identity-service | `PATCH /internal/users/:id/status` → `active` / `rejected` / `pending` — **Case 1** | verification decision, re-open, resubmission | **retry-report-pending**: 3 attempts, then 202 `identitySync: pending` + durable job (inserted in the decision transaction; `identity-sync` worker loop retries); Identity 409 → `failed` + alert. **Built (2026-10-08).** Provider route not yet deployed in real Identity (404 → keeps retrying) |
| identity-service | `GET /internal/users?ids=` — **Case 2** | display name (`fullName` → `displayName`), avatar on search and lists | **degrade**: cache 300 s, 1 retry, misses render `profileHydrated: false`, never 5xx. **Built** for the admin application queue/detail and the doctor's own application; provider route not yet deployed in real Identity |
| identity-service | `PATCH /internal/users/:id/status` → `suspended` — **Case 3** | revoke all sessions of a suspended doctor | **must-not-degrade**: ~6 s inline, durable job until success, 503 `IdentityUnavailable` until confirmed, page after 3 failures |
| identity-service | `PATCH /internal/users/:id/status` → `active` from `suspended` — **Case 4** (planned; provider change first) | reinstate a suspended doctor | **retry-report-pending**: 3 attempts, then 202 + durable job; doctor unbookable until synced |
| identity-service | `GET /internal/users/contacts?ids=` (planned; provider change first; scope `users:contact:read`) | recipient email for notifications (`care-worker` only) | **delay**: outbox retries; never cached or stored |
| video room provider | video port (`lib/video`) | room creation and per-participant join tokens | join fails with 5xx-free retry by the client; bookings unaffected |
| email provider | email port (`lib/email`), via `notification_outbox` + `care-worker` | booking confirmation, reminders, reschedule, cancellation, schedule block, "doctor joined" | outbox retries, `dead` after 8; never blocks or rolls back a booking |
| object storage | storage port (`lib/storage`, AWS SDK v3); browsers use presigned URLs directly (hub ADR 0011) | verification documents, record attachments | `complete` or `download-url` fails and can be retried; no row is created without a verified object. **Built** for verification documents (local dev/test: MinIO) |

## Called by
| Caller | Interface | Notes |
|---|---|---|
| patient, doctor, and admin web clients | public `/api/*` with a user bearer token | see the contract |
| admin tooling / future ai-service | `GET /internal/doctors/{userId}/summary` (service token, scope `doctors:read`) | no MVP service client holds `doctors:read` yet |

## Endpoint families
`/api/health/live`, `/api/health/ready` (live; body `checks: { database, redis, identityJwks }`; `/api/health` removed) · `/api/specialties` (live: `GET` list, `POST` create, `PATCH /{id}` update) · doctors onboarding (live: `POST /api/doctors/apply`, `GET/PATCH /api/doctors/me`, `GET /api/doctors/me/application`; draft submit is local, rejected resubmit uses Case 1) · verification documents (live: `POST /api/doctors/me/documents/uploads`, `…/uploads/{uploadId}/complete`, `POST …/{documentId}/download-url`, `DELETE …/{documentId}`) · `/api/doctors`, `/api/doctors/{doctorUserId}`, `/api/doctors/{doctorUserId}/slots` ·
`/api/doctors/me/working-hours`, `/api/doctors/me/exceptions`, `/api/doctors/me/consultation-types` ·
`/api/admin/applications` (live: `GET` queue and `/{id}` detail, `POST /{id}/documents/{documentId}/download-url`, `PATCH /{id}/approve|reject|reopen`) · `/api/admin/doctors/{doctorUserId}/suspend`, `/reinstate` (planned) ·
`/api/patients/me`, `/api/patients/{patientUserId}`, `/api/patients/{patientUserId}/records` ·
`/api/consultations` (book, list, waiting-room, calendar, get, reschedule, cancel, join, start, complete, no-show, record) ·
`/api/records/{id}` (+ attachment uploads, complete, download-url — planned) · `/api/help-articles` · `/api/audit-logs` · `/internal/doctors/{userId}/summary` · `/internal/health/live`, `/internal/health/ready` (live). Other endpoint families are designed in the contract, not yet built.

## Events
None in MVP (HTTP-only). Future candidates (no AsyncAPI yet): `consultation.booked`,
`consultation.rescheduled`, `consultation.cancelled`, `doctor.verified`, `doctor.suspended`.

## Contract
- HTTP: [`contracts/openapi.yaml`](../contracts/openapi.yaml) — source of truth.

## Key links
- Docs index: [INDEX.md](./INDEX.md)
- System design: [system-design.md](./system-design.md)
- Runbook: [runbook.md](./runbook.md)
