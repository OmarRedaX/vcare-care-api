---
title: API Reference (human view)
owner: care-team
service: care-service
status: draft
diataxis: reference
last_verified: 2026-10-21
tags: [api, reference, routes, rbac]
related: [rbac, record-attachments-spec, consultations-spec, sessions-spec, patients-spec, specialties-spec, doctors-spec, schedules-spec, integration, consultation-lifecycle, clinical-records, scheduling-slots, file-handling, records-spec]
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
Ids are int64 numbers; datetimes ISO-8601 with offset. Every operation declares its possible errors in the contract; all four health operations include `500 InternalError`.

Legend — **Idem**: `req` = `Idempotency-Key` required, `opt` = optional. **Case**: identity-service integration
case and policy (1 retry-report-pending · 2 degrade · 3 must-not-degrade).

## health
| Method | Path | Roles | Ownership | Notes |
|---|---|---|---|---|
| GET | `/api/health/live` | public | none | 200 `{ status: "ok" }`; no dependency checks, never 503 (ADR 0006) |
| GET | `/api/health/ready` | public | none | 200 `ok`/`degraded` (Redis down) · 503 `down` (Postgres down or draining); body `{ status, checks: { database, redis, identityJwks? } }` — `identityJwks` is informational (JWKS cache state, no network call) and never changes `status` or the code |
| GET | `/internal/health/live`, `/internal/health/ready` | public (internal listener only) | none | same bodies as the public pair |

Implemented by the foundation (2026-09-28). Health bodies are bare JSON (not enveloped) with `Cache-Control: no-store`;
unknown query parameters are ignored. Unexpected health failures use the shared error envelope. The old `/api/health` and `/internal/health` paths no longer exist and return
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
| GET | `/api/doctors` (planned, availability slice 2) | patient, admin | none | 2 degrade | filters `specialty, language, name, minFee, maxFee, availableFrom, availableTo`; `sort=earliest_availability\|price\|experience`; bookable doctors only; p95 < 400 ms |
| GET | `/api/doctors/{doctorUserId}` (planned, availability slice 2) | patient, admin | none (non-bookable → 404 for patients) | 2 degrade | includes `nextAvailableSlots` |
| GET | `/api/doctors/{doctorUserId}/slots` (**live**, 2026-10-21) | patient, admin | none (non-bookable doctor, unknown doctor, or a `typeId` that is unknown, inactive or another doctor's → 404 for both roles) | — | `typeId, from, to` (≤ 14 days, else 400), `timezone` (IANA, ≤ 64, else 400); window clipped to `[now, now + 60 days]` (an empty window is 200 with `data: []`); `meta: { from, to, timezone, doctorTimezone, count }`; rate limit 60/min per IP and 120/min per user; no audit, no `Idempotency-Key`; p95 < 300 ms (measured about 19 ms on a miss with 150 busy consultations) |

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

As built: `409 ScheduleConflictsUnconfirmed` and its `conflicts` body are fed by the real `ScheduleImpactProvider` since `consultations` (2026-10-12): future `booked`/`waiting`/`in_progress` rows outside the new open intervals are listed (already-flagged ones included); with `confirmConflicts=true` only newly flagged rows get a `schedule_blocked` outbox row. `isBookable` on `GET /api/doctors/me` now needs a live active consultation type.
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
| GET | `/api/patients/me` (live, 2026-10-11) | patient | self | clinical-read | 404 until created; 120/min per user; `no-store` (also on parser-level 400s) |
| PATCH | `/api/patients/me` (live, 2026-10-11) | patient | self | clinical-write | upsert; `timezone` required on create; 200 for create and update; 20/min per user |
| GET | `/api/patients/{patientUserId}` (live, 2026-10-12, `consultations`) | patient, doctor | consulted-patient-or-self (else 404) | clinical-read (`patient_profile.read`) | patient: own id only; doctor: a `booked`, `waiting`, `in_progress` or `completed` consultation with that patient (decision D-R4), not locally suspended (`403`); **admin `403`**; no profile yet or non-numeric id `404`; 120/min per user; `no-store` |
| GET | `/api/patients/{patientUserId}/records` (live, 2026-10-18, `records`) | patient, doctor | consulted-patient-or-self (else 404) | clinical-read (`patient_records.listed`, one row per call) | timeline: `data.patient` (profile, `null` when none) + `data.records` newest first with amendments; keyset `(created_at, id)`; admin `403`; suspended doctor, `me` or non-numeric id `404`; 60/min per user; `no-store`. See `records` below |

## consultations
Live (2026-10-12, `consultations` module, [spec](../consultations/spec.md)): `POST` book, `GET` list, `GET /{id}`, `PATCH /{id}/reschedule`, `PATCH /{id}/cancel`; every response of the `/api/consultations` prefix is `no-store`, including parser-level `400`s and `401`s. The three writes require `Idempotency-Key` (Redis, 24 h; a replay returns the stored body; booking also replays from `uq_consultations_idempotency` after a Redis loss). A non-numeric `{id}` is `404`, not `400`. Rate limits: the three writes share 10/min per patient or doctor (admin 60/min), reads 120/min per user. `complaintText` is returned by get-one and by the actor's own write response, never by list items and never to admins; `cancelReason` is visible to participants and admins. List items are read through the `CONSULTATION_LIST_COLUMNS` projection. Write responses carry unhydrated `doctor`/`patient` participants (`profileHydrated: false`); list and get-one hydrate through Case 2. The six session routes (waiting-room, calendar, join, start, complete, no-show; live 2026-10-15, `sessions` module, [spec](../sessions/spec.md)) take no `Idempotency-Key` (the status guard makes a retry safe), are `no-store`, and never return `complaintText`. `join` and `start` share a 10/min per user bucket (`consultations-session-user`); `complete` and `no-show` use the write buckets; waiting-room and calendar the read bucket. `join`/`start` answer `503 VideoUnavailable` when the video provider fails or exceeds its 2 s bound (state unchanged before commit, repairable by repeating `join` after it). The session window is half-open `opensAt <= now < closesAt`; a terminal row answers `InvalidTransition` before `RoomNotOpen`. A locally suspended doctor gets `403` on all doctor session routes (an admin no-show is exempt). Since the `records` module (2026-10-18) `POST /api/consultations` accepts `followUpOfRecordId` (a live record of the caller written by the chosen doctor, else `404 NotFound`; ownership only) and `Consultation.hasRecord` is truthful on get-one, list and the doctor calendar (one batched lookup over the `completed` rows; write responses are `false` by construction, except a booking replayed through the database idempotency path).

| Method | Path | Roles | Ownership | Idem | Audit / Case | Errors |
|---|---|---|---|---|---|---|
| POST | `/api/consultations` | patient (active, `emailVerified`) | self (`patient_user_id := auth.userId`) | **req** | `consultation.booked` | 400, 403 `EmailNotVerified`/`Forbidden`, 404, 409 `DoctorNotBookable`/`SlotUnavailable`, 422 `OutsideWorkingHours`/`BookingInPast`/`BeyondBookingHorizon`/`IdempotencyConflict`, 429 (10/min) |
| GET | `/api/consultations` | patient, doctor, admin | own; admin all (no `complaintText`) | — | Case 2 degrade | filters `scope` (`upcoming`: `endsAt > now`, `past`: `endsAt <= now`, `all`; D-R8: an overdue `in_progress` row matches neither until `sessions`), `status`, `from`, `to`, `timezone`; admin-only `doctorUserId, patientUserId, needsAdminFollowup` (a non-admin gets `403`) |
| GET | `/api/consultations/waiting-room` | doctor | self | — | Case 2 degrade | literal path, not an id; `booked`/`waiting` rows whose window is open now, `(startsAt, id)`, at most 100, not paginated; any query member `400`; `403` when suspended |
| GET | `/api/consultations/calendar` | doctor | self | — | Case 2 | `from`, `to` required (`[from, to)`, `from < to`, at most 7 days inclusive, else `400`), optional `timezone` (echo of `from`/`to`); every status plus the doctor's exceptions (`exceptions[].date` doctor-local), at most 1000 rows; p95 < 200 ms |
| GET | `/api/consultations/{id}` | patient, doctor, admin | participant-or-admin (else 404) | — | clinical-read (participants); Case 2 | admin view omits `complaintText` |
| PATCH | `/api/consultations/{id}/reschedule` | patient, admin | patient-owner (outside window) or admin (reason) | **req** | admin-action | 409 `PolicyWindowViolation`/`InvalidTransition`/`DoctorNotBookable`/`SlotUnavailable`, 422 booking codes |
| PATCH | `/api/consultations/{id}/cancel` | patient, doctor, admin | participant (doctor reason) or admin (reason) | **req** | admin-action | 409 `PolicyWindowViolation`/`InvalidTransition`, 422 |
| PATCH | `/api/consultations/{id}/join` | patient, doctor | participant | — | `consultation.waiting` (only on the patient `booked → waiting` transition; a doctor on `booked` or a re-join gets a token with no audit) | 200 `SessionJoin`, 409 `RoomNotOpen`/`InvalidTransition`, 503 `VideoUnavailable`, 429 (10/min) |
| PATCH | `/api/consultations/{id}/start` | doctor | assigned-doctor | — | `consultation.started` (+ one `doctor_joined` outbox row) | 200 `SessionJoin`, 409 `RoomNotOpen`/`InvalidTransition` (a second `start` is `InvalidTransition`), 503 `VideoUnavailable`, 429 (10/min) |
| PATCH | `/api/consultations/{id}/complete` | doctor | assigned-doctor | — | `consultation.completed` | 200, 409 `InvalidTransition` (only from `in_progress`; no window check), 429 |
| PATCH | `/api/consultations/{id}/no-show` | doctor, admin | assigned-doctor or admin | — | admin-action (`consultation.no_show`; `noteLength` only, the optional `note` is not stored) | 200, 409 `NoShowTooEarly` (before `startsAt` + grace)/`InvalidTransition` (only from `booked`/`waiting`), 429 |

## records (admins are never allowed)
The first four rows are **live** (2026-10-18, `records` module, [spec](../records/spec.md)); the attachment rows are **live** since 2026-10-20 (`record-attachments` module, [spec](../record-attachments/spec.md)). Admins get `403 Forbidden` on every record route at the role step, before any lookup. All record responses are `no-store` (`/api/records` joined `NO_STORE_PREFIXES`, so parser-level errors carry it too). **No record route takes an `Idempotency-Key`** (a retried create is `409 Conflict`; no record text reaches Redis). Rate limits per user: create and `PATCH` share one bucket of 20/min, `GET /records/{id}` 120/min, the timeline 60/min. Every successful read is audited before the response and a failed audit insert fails the read (`500`). A locally suspended doctor gets `403 Forbidden` on create/`PATCH` and `404` on both reads. A non-numeric `{id}` is `404`. `MedicalRecord.attachments` lists the live attachment metadata (no URL, no key; `[]` when none) on `GET /records/{id}`, each timeline item and the `PATCH` `200`; the create `201` carries `[]` and the amendment `201` has no attachment list. Attachment routes: only the record's author writes (every other doctor `404`, `NotAssignedDoctor` is never returned), admins `403` at the role step, no `Idempotency-Key`, all `no-store`.

| Method | Path | Roles | Ownership | Audit | Errors |
|---|---|---|---|---|---|
| POST | `/api/consultations/{id}/record` (live) | doctor | assigned-doctor only; **every other caller `404`** (a related doctor included; `NotAssignedDoctor` is never returned here) | clinical-write `record.created` | 201; 400, 403, 404, 409 `RecordRequiresCompleted`/`Conflict` (a repeat, or a retried create), 429. Check order: role/state/suspension, resolver `404`, rate limit, body `400`, then the transaction gate |
| GET | `/api/records/{id}` (live) | patient, doctor | owning patient, author, or doctor who consulted the patient (else 404); suspended doctor 404 | clinical-read `record.read` | 200 with amendments oldest first; 400 (any query member), 403 (admin), 404, 429 |
| PATCH | `/api/records/{id}` (live) | doctor | resolver admits the author or a doctor with a relationship to the patient (else 404); the service answers 403 to the latter | clinical-write `record.updated` / `record.amended`; a pre-lock no-op writes one `record.read` | 200 in place before lock (also the no-op, with the current record) · 201 `MedicalRecordAmendment` after lock (`reason` required, always appended) · 400 (no record field, `reason` rules) · 403 `Forbidden` / `NotAssignedDoctor` (a related doctor who is not the author) · 404 · 409 `RecordLocked` (trigger backstop) · 429 |
| GET | `/api/patients/{patientUserId}/records` (live) | patient, doctor | see `patients` above | clinical-read `patient_records.listed` | 200 + `meta`; 400 (cursor, `limit`, unknown member), 403 (admin), 404, 429 |
| POST | `/api/records/{id}/attachments/uploads` (live) | doctor | record author only (resolver `record_attachment_writer`; related or stranger doctor `404`); active, not locally suspended (`403`) | — (20/h per user) | 201 `UploadIntent`; 400, 403, 404, 409 `AttachmentLimitReached` (20 live), 429 |
| POST | `/api/records/{id}/attachments/uploads/{uploadId}/complete` (live) | doctor | record author; intent owner, kind and record must match (else `404`) | clinical-write `attachment.added` (once; none on replay) | 201 new, 200 replay; 400 (stored file invalid, `field: file`; or a request body), 403, 404, 409 `Conflict` (`Retry-After: 1` only when the intent lock is held) / `AttachmentLimitReached`, 410 `UploadIntentExpired`, 429 (20/min, shared with delete) |
| POST | `/api/records/{id}/attachments/{attachmentId}/download-url` (live) | patient, doctor | as `GET /api/records/{id}` (admin `403`; suspended doctor `404`); attachment must be live and in this record | clinical-read `attachment.url_issued`, committed before the URL is signed | 200 `{ url, expiresAt }` (60 s); 400 (a request body), 403, 404, 429 (120/min) |
| DELETE | `/api/records/{id}/attachments/{attachmentId}` (live) | doctor | record author; attachment live and in this record | clinical-write `attachment.removed` | 204 (soft delete; the stored object is kept); 400 (a request body), 403, 404 (before the lock verdict), 409 `RecordLocked` (after the 24 h lock), 429 (20/min, shared with complete) |

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
| GET | `/api/audit-logs` | admin | none | newest first; filters `actorUserId, action, entityType, entityId` (exact match; `entityId` needs `entityType`), window `[from, to)` (defaults: `to` now, `from` 30 days earlier; `from > to` 400, `from == to` empty); signed cursor (`{t,id,from,to}`, exactly two segments) freezes both bounds, ms precision, tamper or a rotated secret -> 400 `cursor`; every cross-field problem is reported in one 400; 120/min per admin; `no-store`; metadata only, reading writes no audit row |

## internal (listener `:3101`, service token)
| Method | Path | Auth | Scope | Notes |
|---|---|---|---|---|
| GET | `/internal/doctors/{userId}/summary` | service token (`typ=service`, `aud` ∋ `vcare-care`) | `doctors:read` | user token → 401 `ServiceTokenRequired`; missing scope → 403 `InsufficientScope`; no MVP client holds the scope |

## Future events
None published in MVP. Reserved names (`x-future-events`): `consultation.booked`, `consultation.rescheduled`,
`consultation.cancelled`, `doctor.verified`, `doctor.suspended`. See [future.md](./future.md).
