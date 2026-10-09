---
title: API Reference (human view)
owner: care-team
service: care-service
status: draft
diataxis: reference
last_verified: 2026-10-09
tags: [api, reference, routes, rbac]
related: [rbac, specialties-spec, doctors-spec, schedules-spec, integration, consultation-lifecycle, clinical-records, scheduling-slots, file-handling]
---

# API — care-service (human view)

> **Derived from [`contracts/openapi.yaml`](../../contracts/openapi.yaml).** On any disagreement the contract wins.
> Error codes, schemas, and headers are defined there; this page groups routes by tag with their policy.

**Conventions.** Public base `http://localhost:3001/api`, internal base `http://localhost:3101/internal`.
Success `{ success: true, data, meta? }`; errors use the shared envelope
`{ success: false, error: { code, message, details, requestId } }` (`details` is always present, `[]` when empty).
Every response echoes `X-Request-Id`: a valid incoming UUID is adopted **lower-cased**, anything else is replaced by a
generated one.
Lists are cursor-paginated (`cursor` opaque, ≤ 1024 characters; `limit` 1–100 default 20, canonical integers only;
`meta: { nextCursor, hasMore, count }`).
Ids are int64 numbers; datetimes ISO-8601 with offset. Every route may also return `401`, `429`, and `500`.

Legend — **Idem**: `req` = `Idempotency-Key` required, `opt` = optional. **Case**: identity-service integration
case and policy (1 retry-report-pending · 2 degrade · 3 must-not-degrade).

## health
| Method | Path | Roles | Ownership | Notes |
|---|---|---|---|---|
| GET | `/api/health/live` | public | none | 200 `{ status: "ok" }`; no dependency checks, never 503 (ADR 0006) |
| GET | `/api/health/ready` | public | none | 200 `ok`/`degraded` (Redis down) · 503 `down` (Postgres down or draining); body `{ status, checks: { database, redis, identityJwks? } }` — `identityJwks` is informational (JWKS cache state, no network call) and never changes `status` or the code |
| GET | `/internal/health/live`, `/internal/health/ready` | public (internal listener only) | none | same bodies as the public pair |

Implemented by the foundation (2026-09-28). Health bodies are bare JSON (not enveloped) with `Cache-Control: no-store`;
unknown query parameters are ignored. The old `/api/health` and `/internal/health` paths no longer exist and return
`404 NotFound`, as does any other method on a health path (including `OPTIONS`). Each listener serves only its own
prefix: `/internal/*` on the public listener and `/api/*` on the internal listener are `404`.

## specialties
| Method | Path | Roles | Ownership | Audit | Errors |
|---|---|---|---|---|---|
| GET | `/api/specialties` | patient (active), doctor (pending, active, or rejected), admin (active) | none | — | 400, 401, 403, 429 (60/min per IP + 120/min per user) |
| POST | `/api/specialties` | admin | none | admin-action (`specialty.created`) | 400, 401, 403, 409 `Conflict`, 422 `IdempotencyConflict` (Idem opt), 429 |
| PATCH | `/api/specialties/{id}` | admin | none | admin-action (`specialty.updated`) | 400, 401, 403, 404, 409 `Conflict`, 429 |

Implemented by the `specialties` module (2026-10-04; [spec](../specialties/spec.md)). `GET` is keyset-paginated by
`(name, id)`; non-admins see active rows only and `includeInactive=true|false` is honoured for admins only (any other
value is `400`). `POST`/`PATCH` validate lengths in Unicode code points (contract = database); `name` rejects control
characters and `description` rejects NUL (`400`). A `PATCH` that changes nothing answers `200` without an audit row;
`{}` is `400`; an unknown or non-canonical id is `404`. `409 Conflict` carries `details[0].field` `name` or `slug`.
`POST`/`PATCH` declare `429` but mount no limiter. Rows are never deleted (no `DELETE` route).

## doctors-onboarding (account `status` pending, active, or rejected)

The self-owned onboarding routes and the verification document routes below are live (verification module, 2026-10-08).
`POST /apply` with `submit=true` is the submission path: a draft submit is local (no Identity call, 200 or 201); a
rejected resubmit uses Case 1 (200 synced, 202 `identitySync: pending|failed`). A submitted application locks
profile and document edits with `409 ApplicationNotEditable`; `submit=true` without a live license and id document
is `400 ValidationFailed` on `documents`. `POST /apply` takes an optional `Idempotency-Key`. Its write rate limit and the
`PATCH /me` limit are 20/min per user; the two reads are 120/min per user. Document intent creation is 20/h per user;
`complete` and `DELETE` use 20/min with an optional `Idempotency-Key`; document `download-url` is 120/min. Intent
creation and both `download-url` routes mount no idempotency middleware (signed POST policies and URLs are never
stored in Redis, and each issued URL gets its own audit row). All responses are `no-store`.

| Method | Path | Roles | Ownership | Audit / Case | Errors |
|---|---|---|---|---|---|
| POST | `/api/doctors/apply` | doctor | self | `doctor.profile_created` / `doctor.profile_updated`; `verification.submitted` on submit; Case 1 on rejected resubmit | 200, 201; 202 `identitySync`; 400 (missing documents), 403, 409 `ApplicationNotEditable`/`Conflict`, 422 |
| GET | `/api/doctors/me` | doctor | self | — | 404 until applied |
| PATCH | `/api/doctors/me` | doctor | self (not locally suspended) | `doctor.profile_updated` on a real change | 400, 403, 404, 409 `ApplicationNotEditable` |
| POST | `/api/doctors/me/documents/uploads` | doctor | self; application `draft`/`rejected` | — (20/h) | 201 `UploadIntent`, 400, 403, 404, 409 `ApplicationNotEditable`/`Conflict` |
| POST | `/api/doctors/me/documents/uploads/{uploadId}/complete` | doctor | self (intent owner) | `verification.document_uploaded` once | 201, 200 replay, 400 bad bytes (`field: file`), 404, 409, 410 `UploadIntentExpired`, 422 |
| POST | `/api/doctors/me/documents/{documentId}/download-url` | doctor | self | `verification.document_url_issued` per issue | 200 `{ url, expiresAt }` (60 s), 404 |
| DELETE | `/api/doctors/me/documents/{documentId}` | doctor | self; application `draft`/`rejected` | `verification.document_deleted` | 204, 404, 409 `ApplicationNotEditable`, 422 |
| GET | `/api/doctors/me/application` | doctor | self | — | 404; documents are metadata only; Identity name/avatar fields degrade to null |

## doctors-discovery
| Method | Path | Roles | Ownership | Case | Notes |
|---|---|---|---|---|---|
| GET | `/api/doctors` | patient, admin | none | 2 degrade | filters `specialty, language, name, minFee, maxFee, availableFrom, availableTo`; `sort=earliest_availability\|price\|experience`; bookable doctors only; p95 < 400 ms |
| GET | `/api/doctors/{doctorUserId}` | patient, admin | none (non-bookable → 404 for patients) | 2 degrade | includes `nextAvailableSlots` |
| GET | `/api/doctors/{doctorUserId}/slots` | patient, admin | none | — | `typeId, from, to` (≤ 14 days), `timezone`; p95 < 300 ms |

## schedules (live, schedules module, 2026-10-09; account `status` active, not locally suspended)
All eight routes: doctor, token status `active`, not locally suspended (`doctor_not_suspended`, re-checked under the profile lock on writes), ownership `self` (every row scoped by the caller's live profile; no id in a path or body can name another doctor). A caller with no live profile gets `404`. Rate limits: writes 30/min per user, reads 120/min per user (`429` + `Retry-After`). A path `id` that is not a positive integer is `404`. [Spec](../schedules/spec.md).

| Method | Path | Roles | Ownership | Audit | Errors |
|---|---|---|---|---|---|
| GET | `/api/doctors/me/working-hours` | doctor | self | — | 200 `{ timezone, days }` (`days: []` before any PUT); 404 |
| PUT | `/api/doctors/me/working-hours` | doctor | self | `schedule.hours_replaced`; `schedule.conflicts_confirmed` when conflicts are confirmed | 400 (duplicate weekday, overlap, `end <= start`, > 6 intervals/day), 404, 409 `ScheduleConflictsUnconfirmed` (body lists ids). An identical set is a 200 no-op (no write, no audit). Ignores `Idempotency-Key` |
| GET | `/api/doctors/me/exceptions` | doctor | self | — | `fromDate` (default today in the doctor's timezone), `toDate`; keyset `(date, id)`; 400, 404 |
| POST | `/api/doctors/me/exceptions` | doctor | self | `schedule.exception_created`; `schedule.conflicts_confirmed` | 201 (rows ascending by date); 400 (past date, shape, > 60 dates), 404, 409 `ScheduleConflictsUnconfirmed` / `Conflict` (a live exception on any date: nothing created), 422 (Idem opt) |
| DELETE | `/api/doctors/me/exceptions/{id}` | doctor | self (`:id` in own profile, else 404) | `schedule.exception_deleted`; `schedule.conflicts_confirmed` | 204; `?confirmConflicts` strict boolean (400); 404; 409 `ScheduleConflictsUnconfirmed` (only for a `custom_hours` dated today or later) |
| GET | `/api/doctors/me/consultation-types` | doctor | self | — | `isActive`; keyset by `id`; 400, 404 |
| POST | `/api/doctors/me/consultation-types` | doctor | self | `consultation_type.created` | 201; 400 (currency must be allowed and equal the profile currency), 404, 409 `Conflict` (duplicate live name, or the 20-type cap), 422 (Idem opt) |
| PATCH | `/api/doctors/me/consultation-types/{id}` | doctor | self (`:id` in own profile, else 404) | `consultation_type.updated` (changed field names only) | 400 (`{}` or a `null` member), 404, 409 `Conflict`; a no-op is a 200 with no write. Ignores `Idempotency-Key` |

As built: `409 ScheduleConflictsUnconfirmed` and its `conflicts` body are wired but the default `ScheduleImpactProvider` returns no affected consultations until `consultations` exists, so the path is proved with a stub provider only. `isBookable` on `GET /api/doctors/me` now needs a live active consultation type.
## admin-verification (live, verification module, 2026-10-08)
All admin routes: admin, token status `active`, 120/min per user, `no-store`. `approve`/`reject`/`reopen` take an optional `Idempotency-Key`.

| Method | Path | Roles | Ownership | Audit | Case | Responses |
|---|---|---|---|---|---|---|
| GET | `/api/admin/applications` | admin | none | — | 2 degrade | `status` filter (default `submitted`), oldest `(submittedAt, id)` first, signed keyset cursor; doctor block degrades to nulls; 400 bad filter/cursor |
| GET | `/api/admin/applications/{id}` | admin | none | `verification.documents_viewed` (metadata only) | 2 degrade | 200 with document metadata, no URL; 404 |
| POST | `/api/admin/applications/{id}/documents/{documentId}/download-url` | admin | none; document must belong to the application | `verification.document_url_issued` per issue | — | 200 `{ url, expiresAt }` (60 s), 404 |
| PATCH | `/api/admin/applications/{id}/approve` | admin | none | `verification.approved`, `identity_sync.*` | **1 retry-report-pending** | 200 synced · 202 `identitySync: pending\|failed` · 409 `ApplicationNotReviewable`, or `Conflict` + `Retry-After: 5` while `identity_sync_status='pending'` · 422 |
| PATCH | `/api/admin/applications/{id}/reject` | admin | none | `verification.rejected`, `identity_sync.*` | **1** | same; `reason` required |
| PATCH | `/api/admin/applications/{id}/reopen` | admin | none | `verification.reopened`, `identity_sync.*` | **1** (Identity `pending`) | 200 · 202 · 409 `ApplicationNotReviewable` · 422; `reason` required |

`{id}` is the application id = doctor profile id.

## admin-doctors
| Method | Path | Roles | Ownership | Audit | Case | Responses |
|---|---|---|---|---|---|---|
| PATCH | `/api/admin/doctors/{doctorUserId}/suspend` | admin | none | admin-action | **3 must-not-degrade** | 200 only when Identity confirmed (or already suspended and `synced`: no-op; an unsynced no-op re-reports the same 503) · 409 `InvalidTransition` (not approved+synced) · 422 `IdempotencyConflict` · 503 `IdentityUnavailable` + `suspension: "applied-locally, session-revocation-pending"` |
| PATCH | `/api/admin/doctors/{doctorUserId}/reinstate` (live, ADR 0012) | admin | none | admin-action | **4 retry-report-pending** | 200 when Identity confirmed (or not suspended with no unsynced reinstatement: no-op) · 202 `identitySync: pending\|failed` (also the no-op re-report while the latest reinstatement is unsynced) · 409 `InvalidTransition` (suspension not synced) · 422 `IdempotencyConflict` · 404 |

## patients
| Method | Path | Roles | Ownership | Audit | Notes |
|---|---|---|---|---|---|
| GET | `/api/patients/me` | patient | self | clinical-read | 404 until created |
| PATCH | `/api/patients/me` | patient | self | clinical-write | upsert; `timezone` required on create |
| GET | `/api/patients/{patientUserId}` | patient, doctor | consulted-patient-or-self (else 404) | clinical-read | admins never |
| GET | `/api/patients/{patientUserId}/records` | patient, doctor | consulted-patient-or-self (else 404) | clinical-read | timeline: profile + records newest first |

## consultations
| Method | Path | Roles | Ownership | Idem | Audit / Case | Errors |
|---|---|---|---|---|---|---|
| POST | `/api/consultations` | patient (active, `emailVerified`) | self (`patient_user_id := auth.userId`) | **req** | `consultation.booked` | 400, 403 `EmailNotVerified`/`Forbidden`, 404, 409 `DoctorNotBookable`/`SlotUnavailable`, 422 `OutsideWorkingHours`/`BookingInPast`/`BeyondBookingHorizon`/`IdempotencyConflict`, 429 (10/min) |
| GET | `/api/consultations` | patient, doctor, admin | own; admin all (no `complaintText`) | — | Case 2 degrade | filters `scope, status, from, to`, admin `doctorUserId, patientUserId, needsAdminFollowup` |
| GET | `/api/consultations/waiting-room` | doctor | self | — | Case 2 | literal path, not an id |
| GET | `/api/consultations/calendar` | doctor | self | — | Case 2 | `from`, `to` (≤ 7 days), `timezone`; p95 < 200 ms |
| GET | `/api/consultations/{id}` | patient, doctor, admin | participant-or-admin (else 404) | — | clinical-read (participants); Case 2 | admin view omits `complaintText` |
| PATCH | `/api/consultations/{id}/reschedule` | patient, admin | patient-owner (outside window) or admin (reason) | **req** | admin-action | 409 `PolicyWindowViolation`/`InvalidTransition`/`DoctorNotBookable`/`SlotUnavailable`, 422 booking codes |
| PATCH | `/api/consultations/{id}/cancel` | patient, doctor, admin | participant (doctor reason) or admin (reason) | **req** | admin-action | 409 `PolicyWindowViolation`/`InvalidTransition`, 422 |
| PATCH | `/api/consultations/{id}/join` | patient, doctor | participant | — | `consultation.waiting` | 409 `RoomNotOpen`/`InvalidTransition` |
| PATCH | `/api/consultations/{id}/start` | doctor | assigned-doctor | — | `consultation.started` | 409 `RoomNotOpen`/`InvalidTransition` |
| PATCH | `/api/consultations/{id}/complete` | doctor | assigned-doctor | — | `consultation.completed` | 409 `InvalidTransition` |
| PATCH | `/api/consultations/{id}/no-show` | doctor, admin | assigned-doctor or admin | — | admin-action | 409 `NoShowTooEarly`/`InvalidTransition` |

## records (admins are never allowed)
| Method | Path | Roles | Ownership | Audit | Errors |
|---|---|---|---|---|---|
| POST | `/api/consultations/{id}/record` | doctor | assigned-doctor | clinical-write | 403 `NotAssignedDoctor`, 409 `RecordRequiresCompleted`/`Conflict` |
| GET | `/api/records/{id}` | patient, doctor | owning patient, author, or doctor who consulted the patient (else 404) | clinical-read | attachment metadata only once ADR 0014 ships |
| PATCH | `/api/records/{id}` | doctor | assigned-doctor | clinical-write | 200 in place before lock · 201 amendment after lock (`reason` required) · 403 `NotAssignedDoctor` |
| POST | `/api/records/{id}/attachments` | doctor | assigned-doctor | clinical-write | 400 MIME/size, 403, 429 (20/h) — **to be replaced**, ADR 0013 |
| POST | `/api/records/{id}/attachments/uploads` (planned, ADR 0013) | doctor | assigned-doctor | — (20/h) | 201 intent, 400, 403 `NotAssignedDoctor`, 404 |
| POST | `/api/records/{id}/attachments/uploads/{uploadId}/complete` (planned) | doctor | assigned-doctor (intent owner) | clinical-write `attachment.added` | 201, 200 replay, 400 bad bytes, 403, 404, 409, 410 |
| POST | `/api/records/{id}/attachments/{attachmentId}/download-url` (planned, ADR 0014) | patient, doctor | as `GET /api/records/{id}` (admins 403) | clinical-read `attachment.url_issued` | 200 `{ url, expiresAt }` (60 s), 403, 404 |
| DELETE | `/api/records/{id}/attachments/{attachmentId}` | doctor | assigned-doctor | clinical-write | 204, 409 `RecordLocked` |

## help-articles
| Method | Path | Roles | Ownership | Audit |
|---|---|---|---|---|
| GET | `/api/help-articles` | patient, doctor, admin | none (published + own audience; admins see drafts) | — |
| GET | `/api/help-articles/{id}` | patient, doctor, admin | none (hidden → 404) | — |
| POST | `/api/help-articles` | admin | none | admin-action |
| PATCH | `/api/help-articles/{id}` | admin | none | admin-action |
| DELETE | `/api/help-articles/{id}` | admin | none (soft delete) | admin-action |

## audit
| Method | Path | Roles | Ownership | Notes |
|---|---|---|---|---|
| GET | `/api/audit-logs` | admin | none | filters `actorUserId, action, entityType, entityId, from, to`; metadata only |

## internal (listener `:3101`, service token)
| Method | Path | Auth | Scope | Notes |
|---|---|---|---|---|
| GET | `/internal/doctors/{userId}/summary` | service token (`typ=service`, `aud` ∋ `vcare-care`) | `doctors:read` | user token → 401 `ServiceTokenRequired`; missing scope → 403 `InsufficientScope`; no MVP client holds the scope |

## Future events
None published in MVP. Reserved names (`x-future-events`): `consultation.booked`, `consultation.rescheduled`,
`consultation.cancelled`, `doctor.verified`, `doctor.suspended`. See [future.md](./future.md).
