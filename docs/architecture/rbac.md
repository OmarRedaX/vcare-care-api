---
title: RBAC and Ownership
owner: care-team
service: care-service
status: draft
diataxis: reference
last_verified: 2026-10-18
tags: [rbac, authorization, ownership, privacy, security]
related: [api, consultations-spec, schedules-spec, clinical-records, integration, infrastructure, file-handling, records-spec, access-spec, specialties-spec, doctors-spec, adr-0018-db-role-split-explicit-grants-partition-function]
---

# RBAC and Ownership

Implementation guidance: the **`rbac-ownership-guard`** skill. Every route here matches `x-roles` and
`x-ownership` in [`contracts/openapi.yaml`](../../contracts/openapi.yaml); on disagreement the contract wins.

## Principles
1. **Deny by default.** Every route has `authorize(policy)`; `authorize(undefined)` or an invalid policy throws at
   route registration, and `assertRoutesAuthorized(app.router)` stops the process at boot when any route **method**
   (per verb; `.all` entries count for every verb) lacks `authorize`, lacks a guard before it, or runs any other
   handler before it (`route_without_policy` / `route_without_guard` / `handler_before_authorize`), and when any
   non-route layer is neither a router (sub-apps included), an error handler, nor middleware explicitly marked
   `markPreAuth` (`middleware_without_policy` — so `router.use(path, handler)` cannot serve unpoliced), and when any
   walked router has a `router.param` / `app.param` callback (`param_callback_without_policy` — Express runs those
   before the route's guard; never use `router.param`, load by id inside the service after `authorize`). Health is
   the only exemption from guard + policy, by explicit marker (`markProbeExempt`); it is not exempt from the param
   check.
2. **The principal is the verified token only** — `req.auth` from the user-guard (user JWT, verified locally via
   Identity's JWKS cached in memory, `lib/auth`) or the service-guard (service JWT, planned for the internal-summary module).
   `X-User-Id`, `X-Role`, `X-Forwarded-User`, body ids, and path params never grant access; ownership resolvers and
   checks receive only `auth` and the path params, never the body.
3. **Role, then account state, then checks, then ownership** (as built, `lib/rbac/authorize.ts`): no principal 401 →
   role 403 → token status 403 (default `active`; `suspended` is never admissible and lands here as `403 Forbidden`)
   → email 403 `EmailNotVerified` → policy checks 403 (e.g. the doctors module's `doctor_not_suspended`) → ownership
   404/403. Status, email, and checks run before ownership, so a caller who may not act at all cannot probe whether a
   private id exists. Ownership resolvers query the database with `auth.userId`.
4. **Services re-check** invariants inside the transaction (assigned doctor, status, local suspension).
5. **Admins never see clinical notes.**

## Policy shape (as built — `src/lib/rbac/types.ts`)
| Member | Meaning |
|---|---|
| `kind: "user"` | user-token policy (`ServicePolicy` with `scope` arrives with `serviceGuard`) |
| `roles` | explicit list, no wildcard — a new role gets nothing until a policy names it |
| `owner` | mandatory: `{ kind: "none" }`, `{ kind: "self" }` (`/me`), or `{ kind: "resolver", name, resolve }` returning `allow` / `deny-not-found` / `deny-forbidden` |
| `accountState.statuses` | allowed token statuses per role, default `["active"]`; never `suspended` (boot error) |
| `accountState.emailVerified` | `true` → `ev=false` gets `403 EmailNotVerified` |
| `checks` | DB-backed conditions per role (`{ name, appliesTo, run }`), denial `403 Forbidden`, logged as `check:<name>` |
| `audit` | declarative class (`clinical-read`, `clinical-write`, `admin-action`) mirroring `x-audit`; the service writes the rows with `AuditRecorder.record(trx, …)` |

Every denial logs `info access_denied { reason, route }` — a reason and the route pattern, never ids. A resolver or
check that throws → `500 InternalError`. Route composition: `rateLimit(byIp)? → userGuard() → authorize(policy) →
rateLimit(byUser)? → idempotency()? → handler`; every module `routes.ts` returns `sealRouter(router)`.

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
| Doctor **onboarding**: `POST /doctors/apply`, `GET/PATCH /doctors/me`, `POST /doctors/me/documents`, `GET /doctors/me/application`; and the read-only catalog `GET /specialties` (built 2026-10-04) | token `status ∈ {pending, active, rejected}`; `PATCH /doctors/me` also not locally suspended | 403 `Forbidden` |
| Doctor **practising**: working hours, exceptions, consultation types, waiting room, calendar, join/start/complete/cancel/no-show, records | token `status=active` **and** `doctor_profiles.suspended_at IS NULL` (checked every request) | 403 `Forbidden` |
| Patients (all routes) | token `status=active` | 403 `Forbidden` |
| Any token with `status=suspended` | never admissible (no Care policy may list it) | 403 `Forbidden` (Care has no `AccountSuspended` code) |
| Booking | `emailVerified=true` (`ev` claim) | 403 `EmailNotVerified` |
| Booking target doctor | bookable (Domain rule 6) | 409 `DoctorNotBookable` |

The local `suspended_at` check closes the up-to-15-minute window in which a suspended doctor's access token is
still valid. It is a policy `AccessCheck` named `doctor_not_suspended` (`appliesTo: ["doctor"]`) supplied by the
doctors module. It is live on `PATCH /doctors/me` and, since 2026-10-09, on all eight `schedules` routes (re-read under the profile row lock on writes); the other three onboarding routes stay readable or usable by a
locally suspended doctor when their token state allows it. Since 2026-10-12 it is also on `PATCH /consultations/:id/cancel` and `GET /patients/:patientUserId` (doctor callers); since 2026-10-18 on the two record writes (`POST /consultations/:id/record`, `PATCH /records/:id`, `403`), while the two record reads fold the suspension into the ownership resolver (`404`). Reads of a doctor's own consultations (`GET /consultations`, `GET /consultations/:id`) stay open to a locally suspended doctor. Later practising routes must add this check. Booking's check of the **target** doctor is a consultations service rule,
not a policy check (`FOR SHARE` on the profile row, so it serializes with a suspension).

## Per-route policy table
| Route | Roles | Ownership (`x-ownership`) | Audit |
|---|---|---|---|
| `GET /specialties` | patient (active), doctor (pending, active, or rejected — a doctor picks specialties while applying), admin (active) — contract `x-account-state` | none | — |
| `POST /specialties`, `PATCH /specialties/:id` | admin | none | admin-action |
| `POST /doctors/apply`, `GET/PATCH /doctors/me`, `GET /doctors/me/application`, `DELETE /doctors/me/documents/:documentId` (live) | doctor (pending, active, or rejected) | self — profile by `auth.userId`; `PATCH /me` checks local suspension | `doctor.profile_created` / `doctor.profile_updated` on real writes |
| `GET /doctors`, `GET /doctors/:doctorUserId`, `GET /doctors/:doctorUserId/slots` | patient, admin | none (patients see bookable doctors only) | — |
| `GET/PUT /doctors/me/working-hours`, `GET/POST /doctors/me/exceptions`, `DELETE /doctors/me/exceptions/:id`, `GET/POST /doctors/me/consultation-types`, `PATCH /doctors/me/consultation-types/:id` | doctor (active, not suspended) | self; `:id` must belong to the caller's profile, else `404` (scoped repository queries; **live since 2026-10-09**) | every write audits in its transaction (`schedule.hours_replaced`, `schedule.exception_created`/`_deleted`, `consultation_type.created`/`_updated`, plus `schedule.conflicts_confirmed`); the three conflict-capable routes declare `audit: admin-action`. Rate limits: writes 30/min, reads 120/min per user. Patient and admin are `403` on every route |
| `GET /admin/applications` (live) | admin | none | — |
| `GET /admin/applications/:id` (live) | admin | none | `verification.documents_viewed` (metadata only, no URL) |
| `PATCH /admin/applications/:id/approve`, `/reject`, `/reopen` (live) | admin | none; approve/reject refused with `409 Conflict` + `Retry-After: 5` while `identity_sync_status` is `pending` | `verification.approved|rejected|reopened`, `identity_sync.pending|synced|failed` |
| `PATCH /admin/doctors/:doctorUserId/suspend` (live, 2026-10-09) | admin (token `status=active`; a doctor, including the target, and a patient get `403 Forbidden`) | none; `doctorUserId` is the doctor's Identity user id; 30/min per admin, one bucket shared with reinstate | admin-action: `doctor.suspended`, `consultation.flagged_for_followup` (entity `consultation`), `identity_sync.*`; reason text never in audit metadata (`reasonLength` only) |
| `PATCH /admin/doctors/:doctorUserId/reinstate` (live, 2026-10-09, ADR 0012) | admin | none; same limiter | admin-action: `doctor.reinstated`, `identity_sync.*` |
| `GET /patients/me` (live, 2026-10-11) | patient (token `status=active`; doctor and admin `403`) | self | clinical-read: `patient_profile.read`, metadata `{ patientUserId }` |
| `PATCH /patients/me` (live, 2026-10-11) | patient (as above) | self | clinical-write: `patient_profile.updated`, metadata `{ created, changedFields }` (names only) |
| `GET /patients/:patientUserId` (**live**, 2026-10-12) | patient, doctor (token `status=active`; doctor not locally suspended; admin `403`) | `consulted-patient-or-self`: patient `:id = auth.userId`; doctor has a `booked`, `waiting`, `in_progress` or `completed` consultation with the patient (decision D-R4; `EXISTS` over `idx_consultations_doctor_user_id_patient_user_id`); else `deny-not-found`; a non-numeric id is `404`; no profile yet `404` | clinical-read: `patient_profile.read`, metadata `{ patientUserId, viewerRole }` |
| `GET /patients/:patientUserId/records` (**live**, 2026-10-18, `records`) | patient, doctor (token `status=active`; admin `403`) | resolver `records_timeline_reader`: patient `:patientUserId = auth.userId`; doctor not locally suspended **and** holds the D-R4 relationship with the patient; else `deny-not-found` (a suspended doctor, `me` and any non-numeric id included). A separate resolver from `consulted_patient_or_self` because a suspended doctor is answered `404` here, `403` on `GET /patients/:id` | clinical-read: `patient_records.listed` (entity type `patient_records`, entity id = the patient's user id), one row per call |
| `POST /consultations` (**live**, 2026-10-12) | patient (active, email verified) | `self` — `patient_user_id := auth.userId` | `consultation.booked` |
| `GET /consultations` (**live**) | patient, doctor, admin | none at the guard; the repository `WHERE` comes from `auth` (patient own, doctor own, admin all with the admin DTO); admin-only filters (`doctorUserId`, `patientUserId`, `needsAdminFollowup`) by a non-admin → `403 Forbidden` | — (list items carry no clinical text) |
| `GET /consultations/:id` (**live**) | patient, doctor, admin | resolver `consultation_participant_or_admin` (patient owner, assigned doctor, or admin; others and non-numeric ids `deny-not-found`) | `consultation.read` for participants; none for admin |
| `PATCH /consultations/:id/reschedule` (**live**) | patient, admin | resolver `consultation_patient_or_admin`; admin `reason` required (`400`) | `consultation.rescheduled` for any caller (policy class admin-action) |
| `PATCH /consultations/:id/cancel` (**live**) | patient, doctor, admin | resolver `consultation_participant_or_admin`; doctor (assigned only, not locally suspended) and admin `reason` required (`400`) | `consultation.cancelled` for any caller (policy class admin-action) |
| `PATCH /consultations/:id/join` | patient, doctor | `participant` | `consultation.waiting` on the patient transition only |
| `PATCH /consultations/:id/start`, `/complete` | doctor | `assigned-doctor` | — |
| `PATCH /consultations/:id/no-show` | doctor, admin | `assigned-doctor-or-admin` (admin passes; other doctors `404`) | admin-action for admin; admin exempt from the local-suspension check |
| `GET /consultations/waiting-room`, `GET /consultations/calendar` | doctor | self | — |
| `POST /consultations/:id/record` (**live**, 2026-10-18) | doctor (active; check `doctor_not_suspended`, `403`) | resolver `record_write_consultation`: `allow` only when the consultation's `doctor_user_id = auth.userId`; every other caller (related or not, any status) `deny-not-found`. The service re-checks in the transaction (a mismatch is `404`) and then requires `completed` | clinical-write: `record.created` |
| `GET /records/:id` (**live**) | patient, doctor (admin `403`) | resolver `record_reader`: patient owns the record; doctor not locally suspended (`deny-not-found` otherwise) **and** author or D-R4 relationship with the record's patient; else `deny-not-found` | clinical-read: `record.read` |
| `PATCH /records/:id` (**live**) | doctor (active; check `doctor_not_suspended`, `403`) | resolver `record_write_record`: `allow` for the author **or** a doctor with a D-R4 relationship to the patient, else `deny-not-found`; the service then answers `403 NotAssignedDoctor` to a related non-author | clinical-write: `record.updated` (before the lock) / `record.amended` (after); a pre-lock no-op writes one `record.read` |
| `POST /records/:id/attachments`, `DELETE /records/:id/attachments/:aid` | doctor | `assigned-doctor`; delete only before lock | clinical-write |
| `POST /records/:id/attachments/uploads`, `…/uploads/:uploadId/complete` (planned, ADR 0013) | doctor (active, not suspended) | `assigned-doctor`; `complete` also requires intent owner = caller (else `deny-not-found`) and re-checks assignment | clinical-write on complete |
| `POST /records/:id/attachments/:aid/download-url` (planned, ADR 0014) | patient, doctor | same as `GET /records/:id`; admins 403 | clinical-read (`attachment.url_issued`) |
| `POST /doctors/me/documents/uploads`, `…/uploads/:uploadId/complete`, `POST /doctors/me/documents/:documentId/download-url` (live) | doctor (pending, active, or rejected) | self; uploads only while the application is `draft`/`rejected`; intent owner = caller | `verification.document_uploaded` / `verification.document_url_issued` |
| `POST /admin/applications/:id/documents/:documentId/download-url` (live) | admin | none; document must belong to the application | admin-action (`verification.document_url_issued`) |
| `GET /help-articles`, `GET /help-articles/:id` | patient, doctor, admin | none (published and own audience; admins see drafts) | — |
| `POST/PATCH/DELETE /help-articles*` | admin | none | admin-action |
| `GET /audit-logs` | admin | none | — |
| `GET /internal/doctors/:userId/summary` | service | scope `doctors:read` | — |

Status changes on consultations are always audited regardless of the audit class above. Built so far: `consultation.booked`, `.rescheduled`, `.cancelled` (any caller role, `byRole` in the metadata) and `consultation.read`; since 2026-10-15 (`sessions`) also `consultation.waiting` (patient `booked → waiting` only), `.started`, `.completed` and `.no_show` (metadata `byRole`, `fromStatus`, `noteLength?`; never the note, tokens or room ids). Token-only re-joins and the waiting-room and calendar views write no audit row (no clinical field is returned).

**Doctor-patient relationship (decision D-R4, 2026-10-12).** A doctor "has consulted" a patient when a non-deleted consultation in `booked`, `waiting`, `in_progress` or `completed` links them. `booked` is included so a doctor can read the intake profile before the visit; a `cancelled` or `no_show`-only relationship grants nothing. Every read is audited. The `records` routes (live 2026-10-18) reuse the same `PatientRelationshipChecker` port (`TOKENS.PatientRelationship`, implemented by `ConsultationsService`) inside their own resolvers (`record_reader`, `records_timeline_reader`, `record_write_record`); `record_write_consultation` deliberately uses **no** relationship (assigned doctor only).

## Deny-not-found vs forbidden
| Situation | Response | Why |
|---|---|---|
| Wrong role for the capability (e.g. patient calls an admin route, admin calls a record route) | 403 `Forbidden` | the capability's existence is public |
| Allowed role, resource is private and not the caller's (consultation, record, patient profile, own-profile sub-resource `:id`) | 404 `NotFound` | do not reveal that the id exists |
| `PATCH /records/{id}` by a doctor with a consultation relationship to the patient who is not the record's author | 403 `NotAssignedDoctor` | the caller already sees the record id in the patient timeline. Creating a record (`POST /consultations/{id}/record`) by anyone but the assigned doctor is `404` instead: the timeline does not list record-less consultations, so a 403 would be an existence oracle |
| User token on `/internal/*` | 401 `ServiceTokenRequired` | only service principals |
| Service token without `doctors:read` | 403 `InsufficientScope` | |

## Viewer-aware DTOs
Response DTOs are built with `from(entity, viewer)`:

| Resource | Patient (owner) | Doctor (participant / consulted) | Admin |
|---|---|---|---|
| Consultation | get-one and own write responses: all fields incl. `complaintText`, local times in `patientTimezone`; list items omit `complaintText` | same, local times in the doctor's zone | **no `complaintText`** (also on write responses); lifecycle, parties, times, `cancelReason`, `needsAdminFollowup` (decision D-R7: `cancelReason` is administrative context, clients must not put clinical detail in it) |
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
