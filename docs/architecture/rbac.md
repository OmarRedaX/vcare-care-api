---
title: RBAC and Ownership
owner: care-team
service: care-service
status: draft
diataxis: reference
last_verified: 2026-10-08
tags: [rbac, authorization, ownership, privacy, security]
related: [api, clinical-records, integration, infrastructure, file-handling, access-spec, specialties-spec, doctors-spec, adr-0018-db-role-split-explicit-grants-partition-function]
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
doctors module. It is live on `PATCH /doctors/me`; the other three onboarding routes stay readable or usable by a
locally suspended doctor when their token state allows it. Later practising routes must add this check. Booking's check of the **target** doctor is a consultations service rule,
not a policy check.

## Per-route policy table
| Route | Roles | Ownership (`x-ownership`) | Audit |
|---|---|---|---|
| `GET /specialties` | patient (active), doctor (pending, active, or rejected — a doctor picks specialties while applying), admin (active) — contract `x-account-state` | none | — |
| `POST /specialties`, `PATCH /specialties/:id` | admin | none | admin-action |
| `POST /doctors/apply`, `GET/PATCH /doctors/me`, `GET /doctors/me/application`, `DELETE /doctors/me/documents/:documentId` (live) | doctor (pending, active, or rejected) | self — profile by `auth.userId`; `PATCH /me` checks local suspension | `doctor.profile_created` / `doctor.profile_updated` on real writes |
| `GET /doctors`, `GET /doctors/:doctorUserId`, `GET /doctors/:doctorUserId/slots` | patient, admin | none (patients see bookable doctors only) | — |
| `GET/PUT /doctors/me/working-hours`, `GET/POST /doctors/me/exceptions`, `DELETE /doctors/me/exceptions/:id`, `GET/POST /doctors/me/consultation-types`, `PATCH /doctors/me/consultation-types/:id` | doctor (active, not suspended) | self; `:id` must belong to the caller's profile, else `deny-not-found` | admin-action when a block with conflicts is confirmed |
| `GET /admin/applications` (live) | admin | none | — |
| `GET /admin/applications/:id` (live) | admin | none | `verification.documents_viewed` (metadata only, no URL) |
| `PATCH /admin/applications/:id/approve`, `/reject`, `/reopen` (live) | admin | none; approve/reject refused with `409 Conflict` + `Retry-After: 5` while `identity_sync_status` is `pending` | `verification.approved|rejected|reopened`, `identity_sync.pending|synced|failed` |
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
| `POST /doctors/me/documents/uploads`, `…/uploads/:uploadId/complete`, `POST /doctors/me/documents/:documentId/download-url` (live) | doctor (pending, active, or rejected) | self; uploads only while the application is `draft`/`rejected`; intent owner = caller | `verification.document_uploaded` / `verification.document_url_issued` |
| `POST /admin/applications/:id/documents/:documentId/download-url` (live) | admin | none; document must belong to the application | admin-action (`verification.document_url_issued`) |
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
