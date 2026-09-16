---
title: RBAC and Ownership
owner: care-team
service: care-service
status: draft
diataxis: reference
last_verified: 2026-09-15
tags: [rbac, authorization, ownership, privacy, security]
related: [api, clinical-records, integration, infrastructure, file-handling]
---

# RBAC and Ownership

Implementation guidance: the **`rbac-ownership-guard`** skill. Every route here matches `x-roles` and
`x-ownership` in [`contracts/openapi.yaml`](../../contracts/openapi.yaml); on disagreement the contract wins.

## Principles
1. **Deny by default.** Every route has `authorize(policy)`; a route without a policy fails closed at boot.
2. **The principal is the verified token only** — `req.auth` from the user-guard (user JWT, verified locally via
   Identity's JWKS) or service-guard (service JWT). `X-User-Id`, `X-Role`, `X-Forwarded-User`, body ids, and path
   params never grant access.
3. **Role, then ownership, then account state.** Ownership resolvers query the database with `auth.userId`.
4. **Services re-check** invariants inside the transaction (assigned doctor, status, local suspension).
5. **Admins never see clinical notes.**

## Permissions matrix (PRD §9 as refined by CLAUDE.md)
| Capability | Patient | Doctor | Admin |
|---|:--:|:--:|:--:|
| Search doctors, view profile and slots | ✅ | — | ✅ |
| Book own consultation | ✅ | — | — |
| Reschedule / cancel on behalf | — | — | ✅ (reason) |
| Reschedule / cancel own | ✅ outside window | ✅ cancel own with reason | — |
| Apply / manage own onboarding profile and documents | — | ✅ (`pending`, `active`, or `rejected`) | — |
| Manage own schedule & pricing | — | ✅ (`active`, not suspended) | — |
| Join session | ✅ own | ✅ own | — |
| Start / complete | — | ✅ assigned | — |
| Mark no-show | — | ✅ assigned | ✅ |
| Write medical record | — | ✅ assigned | — |
| Read clinical records | ✅ own | ✅ consulted patients | ❌ never |
| Approve / reject / re-open applications | — | — | ✅ |
| Suspend doctors | — | — | ✅ |
| Manage specialties & help articles | — | — | ✅ |
| Read audit logs (metadata only) | — | — | ✅ |
| `/internal/doctors/:userId/summary` | service token with `doctors:read` only | | |

## Account-state requirements
| Route group | Requirement | Error |
|---|---|---|
| Doctor **onboarding**: `POST /doctors/apply`, `GET/PATCH /doctors/me`, `POST /doctors/me/documents`, `GET /doctors/me/application` | token `status ∈ {pending, active, rejected}`; `PATCH /doctors/me` also not locally suspended | 403 `Forbidden` |
| Doctor **practising**: working hours, exceptions, consultation types, waiting room, calendar, join/start/complete/cancel/no-show, records | token `status=active` **and** `doctor_profiles.suspended_at IS NULL` (checked every request) | 403 `Forbidden` |
| Patients (all routes) | token `status=active` | 403 `Forbidden` |
| Booking | `emailVerified=true` (`ev` claim) | 403 `EmailNotVerified` |
| Booking target doctor | bookable (Domain rule 6) | 409 `DoctorNotBookable` |

The local `suspended_at` check closes the up-to-15-minute window in which a suspended doctor's access token is
still valid.

## Per-route policy table
| Route | Roles | Ownership (`x-ownership`) | Audit |
|---|---|---|---|
| `GET /specialties` | patient, doctor, admin | none | — |
| `POST /specialties`, `PATCH /specialties/:id` | admin | none | admin-action |
| `POST /doctors/apply`, `GET/PATCH /doctors/me`, `POST /doctors/me/documents`, `GET /doctors/me/application` | doctor (pending, active, or rejected) | self — profile by `auth.userId` | — |
| `GET /doctors`, `GET /doctors/:doctorUserId`, `GET /doctors/:doctorUserId/slots` | patient, admin | none (patients see bookable doctors only) | — |
| `GET/PUT /doctors/me/working-hours`, `GET/POST /doctors/me/exceptions`, `DELETE /doctors/me/exceptions/:id`, `GET/POST /doctors/me/consultation-types`, `PATCH /doctors/me/consultation-types/:id` | doctor (active, not suspended) | self; `:id` must belong to the caller's profile, else `deny-not-found` | admin-action when a block with conflicts is confirmed |
| `GET /admin/applications` | admin | none | — |
| `GET /admin/applications/:id` | admin | none | admin-action |
| `PATCH /admin/applications/:id/approve`, `/reject`, `/reopen` | admin | none | admin-action |
| `PATCH /admin/doctors/:doctorUserId/suspend` | admin | none | admin-action |
| `PATCH /admin/doctors/:doctorUserId/reinstate` (planned, ADR 0012) | admin | none | admin-action |
| `GET /patients/me` | patient | self | clinical-read |
| `PATCH /patients/me` | patient | self | clinical-write |
| `GET /patients/:patientUserId`, `GET /patients/:patientUserId/records` | patient, doctor | `consulted-patient-or-self`: patient `:id = auth.userId`; doctor has a `completed` or current consultation with the patient; else `deny-not-found` | clinical-read |
| `POST /consultations` | patient (active, email verified) | `self` — `patient_user_id := auth.userId` | — |
| `GET /consultations` | patient, doctor, admin | `participant-or-admin` — own rows; admin all with admin DTO | — |
| `GET /consultations/:id` | patient, doctor, admin | `participant-or-admin`; others `deny-not-found` | clinical-read for participants |
| `PATCH /consultations/:id/reschedule` | patient, admin | `patient-owner-or-admin` | admin-action for admin |
| `PATCH /consultations/:id/cancel` | patient, doctor, admin | `participant-or-admin`; doctor/admin reason required | admin-action for admin |
| `PATCH /consultations/:id/join` | patient, doctor | `participant` | — |
| `PATCH /consultations/:id/start`, `/complete` | doctor | `assigned-doctor` | — |
| `PATCH /consultations/:id/no-show` | doctor, admin | `assigned-doctor-or-admin` | admin-action for admin |
| `GET /consultations/waiting-room`, `GET /consultations/calendar` | doctor | self | — |
| `POST /consultations/:id/record` | doctor | `assigned-doctor` + consultation `completed` | clinical-write |
| `GET /records/:id` | patient, doctor | owning patient, author, or doctor who consulted the patient; else `deny-not-found` | clinical-read |
| `PATCH /records/:id` | doctor | `assigned-doctor` (author) | clinical-write |
| `POST /records/:id/attachments`, `DELETE /records/:id/attachments/:aid` | doctor | `assigned-doctor`; delete only before lock | clinical-write |
| `POST /records/:id/attachments/uploads`, `…/uploads/:uploadId/complete` (planned, ADR 0013) | doctor (active, not suspended) | `assigned-doctor`; `complete` also requires intent owner = caller (else `deny-not-found`) and re-checks assignment | clinical-write on complete |
| `POST /records/:id/attachments/:aid/download-url` (planned, ADR 0014) | patient, doctor | same as `GET /records/:id`; admins 403 | clinical-read (`attachment.url_issued`) |
| `POST /doctors/me/documents/uploads`, `…/uploads/:uploadId/complete`, `POST /doctors/me/documents/:documentId/download-url` (planned) | doctor (pending, active, or rejected) | self; uploads only while the application is `draft`/`rejected`; intent owner = caller | `verification.document_uploaded` / `verification.document_url_issued` |
| `POST /admin/applications/:id/documents/:documentId/download-url` (planned) | admin | none | admin-action (`verification.document_url_issued`) |
| `GET /help-articles`, `GET /help-articles/:id` | patient, doctor, admin | none (published and own audience; admins see drafts) | — |
| `POST/PATCH/DELETE /help-articles*` | admin | none | admin-action |
| `GET /audit-logs` | admin | none | — |
| `GET /internal/doctors/:userId/summary` | service | scope `doctors:read` | — |

Status changes on consultations are always audited (`consultation.<status>`) regardless of the audit class above.

## Deny-not-found vs forbidden
| Situation | Response | Why |
|---|---|---|
| Wrong role for the capability (e.g. patient calls an admin route, admin calls a record route) | 403 `Forbidden` | the capability's existence is public |
| Allowed role, resource is private and not the caller's (consultation, record, patient profile, own-profile sub-resource `:id`) | 404 `NotFound` | do not reveal that the id exists |
| Allowed role and owner, but the doctor is not the assigned doctor for a record write | 403 `NotAssignedDoctor` | the caller already sees the consultation |
| User token on `/internal/*` | 401 `ServiceTokenRequired` | only service principals |
| Service token without `doctors:read` | 403 `InsufficientScope` | |

## Viewer-aware DTOs
Response DTOs are built with `from(entity, viewer)`:

| Resource | Patient (owner) | Doctor (participant / consulted) | Admin |
|---|---|---|---|
| Consultation | all fields incl. `complaintText`, local times in `patientTimezone` | all fields incl. `complaintText`, local times in doctor tz | **no `complaintText`**; lifecycle, parties, times, `needsAdminFollowup` |
| Patient profile | all fields | all fields | not served |
| Medical record / amendments / attachments | all fields | all fields | not served |
| Doctor profile | public view | own full view on `/doctors/me` | public view + `status` (bookable/not) |
| Verification application | own, document metadata; URLs on demand | — | full, document metadata; URLs on demand (audited) |
| Audit log entry | — | — | metadata only (never clinical text) |

## Tests every route needs
Unauthenticated → 401; each role not allowed → 403; allowed role non-owner → 404 (private) or 403; owner → success;
account-state violations → the specific error; admin denied on every clinical route and admin DTOs contain no
clinical fields; audited routes write exactly one row with no clinical text; spoofed identity headers or body ids
have no effect; `/internal` with a user token → 401 `ServiceTokenRequired`.
