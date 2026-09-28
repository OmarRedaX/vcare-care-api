---
title: API Reference (human view)
owner: care-team
service: care-service
status: draft
diataxis: reference
last_verified: 2026-09-28
tags: [api, reference, routes, rbac]
related: [rbac, integration, consultation-lifecycle, clinical-records, scheduling-slots, file-handling]
---

# API — care-service (human view)

> **Derived from [`contracts/openapi.yaml`](../../contracts/openapi.yaml).** On any disagreement the contract wins.
> Error codes, schemas, and headers are defined there; this page groups routes by tag with their policy.

**Conventions.** Public base `http://localhost:3001/api`, internal base `http://localhost:3101/internal`.
Success `{ success: true, data, meta? }`; errors use the shared envelope
`{ success: false, error: { code, message, details, requestId } }` (`details` is always present, `[]` when empty).
Every response echoes `X-Request-Id`: a valid incoming UUID is adopted **lower-cased**, anything else is replaced by a
generated one.
Lists are cursor-paginated (`cursor`, `limit` 1–100 default 20, `meta: { nextCursor, hasMore, count }`).
Ids are int64 numbers; datetimes ISO-8601 with offset. Every route may also return `401`, `429`, and `500`.

Legend — **Idem**: `req` = `Idempotency-Key` required, `opt` = optional. **Case**: identity-service integration
case and policy (1 retry-report-pending · 2 degrade · 3 must-not-degrade).

## health
| Method | Path | Roles | Ownership | Notes |
|---|---|---|---|---|
| GET | `/api/health/live` | public | none | 200 `{ status: "ok" }`; no dependency checks, never 503 (ADR 0006) |
| GET | `/api/health/ready` | public | none | 200 `ok`/`degraded` (Redis down) · 503 `down` (Postgres down or draining); body `{ status, checks: { database, redis } }` |
| GET | `/internal/health/live`, `/internal/health/ready` | public (internal listener only) | none | same bodies as the public pair |

Implemented by the foundation (2026-09-28). Health bodies are bare JSON (not enveloped) with `Cache-Control: no-store`;
unknown query parameters are ignored. The old `/api/health` and `/internal/health` paths no longer exist and return
`404 NotFound`, as does any other method on a health path (including `OPTIONS`). Each listener serves only its own
prefix: `/internal/*` on the public listener and `/api/*` on the internal listener are `404`.

## specialties
| Method | Path | Roles | Ownership | Audit | Errors |
|---|---|---|---|---|---|
| GET | `/api/specialties` | patient, doctor, admin | none | — | 400 |
| POST | `/api/specialties` | admin | none | admin-action | 400, 403, 409 `Conflict`, 422 (Idem opt) |
| PATCH | `/api/specialties/{id}` | admin | none | admin-action | 400, 403, 404, 409 |

## doctors-onboarding (account `status` pending, active, or rejected)
| Method | Path | Roles | Ownership | Audit / Case | Errors |
|---|---|---|---|---|---|
| POST | `/api/doctors/apply` | doctor | self | Case 1 on resubmission (`rejected → submitted`, Identity `pending`) | 200, 201, 202 `identitySync`, 400 (missing documents), 403, 409 `Conflict` |
| GET | `/api/doctors/me` | doctor | self | — | 404 until applied |
| PATCH | `/api/doctors/me` | doctor | self (not locally suspended) | — | 400, 403, 404 |
| POST | `/api/doctors/me/documents` | doctor | self | — (multipart, 20/h) — **to be replaced**, ADR 0013 | 400 (MIME/size), 403, 404, 409 |
| POST | `/api/doctors/me/documents/uploads` (planned, ADR 0013) | doctor | self; application `draft`/`rejected` | — (20/h) | 201 intent, 400, 403, 404, 409 |
| POST | `/api/doctors/me/documents/uploads/{uploadId}/complete` (planned) | doctor | self (intent owner) | `verification.document_uploaded` | 201, 200 replay, 400 bad bytes, 404, 409, 410 `UploadIntentExpired` |
| POST | `/api/doctors/me/documents/{documentId}/download-url` (planned, ADR 0014) | doctor | self | `verification.document_url_issued` | 200 `{ url, expiresAt }` (60 s), 404 |
| GET | `/api/doctors/me/application` | doctor | self | — | 404 |

## doctors-discovery
| Method | Path | Roles | Ownership | Case | Notes |
|---|---|---|---|---|---|
| GET | `/api/doctors` | patient, admin | none | 2 degrade | filters `specialty, language, name, minFee, maxFee, availableFrom, availableTo`; `sort=earliest_availability\|price\|experience`; bookable doctors only; p95 < 400 ms |
| GET | `/api/doctors/{doctorUserId}` | patient, admin | none (non-bookable → 404 for patients) | 2 degrade | includes `nextAvailableSlots` |
| GET | `/api/doctors/{doctorUserId}/slots` | patient, admin | none | — | `typeId, from, to` (≤ 14 days), `timezone`; p95 < 300 ms |

## schedules (account `status` active, not locally suspended)
| Method | Path | Roles | Ownership | Audit | Errors |
|---|---|---|---|---|---|
| GET | `/api/doctors/me/working-hours` | doctor | self | — | |
| PUT | `/api/doctors/me/working-hours` | doctor | self | admin-action when conflicts confirmed | 400, 409 `ScheduleConflictsUnconfirmed` (body lists ids) |
| GET | `/api/doctors/me/exceptions` | doctor | self | — | `fromDate`, `toDate` |
| POST | `/api/doctors/me/exceptions` | doctor | self | admin-action when conflicts confirmed | 400, 409 `ScheduleConflictsUnconfirmed` / `Conflict`, 422 (Idem opt) |
| DELETE | `/api/doctors/me/exceptions/{id}` | doctor | self (`:id` in own profile, else 404) | — | 204, 404 |
| GET | `/api/doctors/me/consultation-types` | doctor | self | — | `isActive` |
| POST | `/api/doctors/me/consultation-types` | doctor | self | — | 400, 409, 422 (Idem opt) |
| PATCH | `/api/doctors/me/consultation-types/{id}` | doctor | self (`:id` in own profile, else 404) | — | 400, 404, 409 |

## admin-verification
| Method | Path | Roles | Ownership | Audit | Case | Responses |
|---|---|---|---|---|---|---|
| GET | `/api/admin/applications` | admin | none | — | 2 degrade | `status` filter, oldest first |
| GET | `/api/admin/applications/{id}` | admin | none | admin-action (document metadata; URLs on demand once ADR 0014 ships) | 2 degrade | 404 |
| POST | `/api/admin/applications/{id}/documents/{documentId}/download-url` (planned, ADR 0014) | admin | none | admin-action `verification.document_url_issued` | — | 200 `{ url, expiresAt }` (60 s), 404 |
| PATCH | `/api/admin/applications/{id}/approve` | admin | none | admin-action | **1 retry-report-pending** | 200 synced · 202 `identitySync: pending\|failed` · 409 `ApplicationNotReviewable` |
| PATCH | `/api/admin/applications/{id}/reject` | admin | none | admin-action | **1** | same; `reason` required |
| PATCH | `/api/admin/applications/{id}/reopen` | admin | none | admin-action | **1** (Identity `pending`) | 200 · 202 · 409 `ApplicationNotReviewable` |

`{id}` is the application id = doctor profile id.

## admin-doctors
| Method | Path | Roles | Ownership | Audit | Case | Responses |
|---|---|---|---|---|---|---|
| PATCH | `/api/admin/doctors/{doctorUserId}/suspend` | admin | none | admin-action | **3 must-not-degrade** | 200 only when Identity confirmed (or already suspended: no-op) · 409 `InvalidTransition` (not approved+synced) · 503 `IdentityUnavailable` + `suspension: "applied-locally, session-revocation-pending"` |
| PATCH | `/api/admin/doctors/{doctorUserId}/reinstate` (planned, ADR 0012) | admin | none | admin-action | **4 retry-report-pending** | 200 when Identity confirmed (or not suspended: no-op) · 202 `identitySync: pending\|failed` · 409 `InvalidTransition` (suspension not synced) · 404 |

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
