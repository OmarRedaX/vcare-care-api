---
title: patients — Brainstorm
owner: care-team
service: care-service
module: patients
status: implemented
diataxis: explanation
last_verified: 2026-10-11
tags: [brainstorm, patients, patient-profile, clinical-privacy]
related: [data-model, api, rbac, clinical-records, access-spec, audit-spec]
---

# patients — Brainstorm

Scope decided 2026-10-11 (branch `feature/patients`, from `main` @ ebad097). First of three modules: patients → consultations → discovery.

## Problem & purpose
PRD §7.9: a patient maintains demographics, allergies, chronic conditions and timezone, and never edits
medical-record fields. The profile is also the prerequisite for booking: `consultations` needs a patient with a known
timezone (Domain rule 20, "every user has a timezone") to render local times.

## Actors
- **Patient** (Identity `status=active`) — creates and updates their own profile; reads it back.
- **Doctor / admin** — no route in this slice (see Out of scope). Admins are never allowed on clinical profile fields.

## In scope (this iteration)
- `GET /api/patients/me` (404 until created) and `PATCH /api/patients/me` (upsert; `timezone` required on create).
- Table `patient_profiles` (per `docs/architecture/data-model.md`), soft delete, unique live row per `user_id`.
- Audit rows: `patient_profile.read` on every read, `patient_profile.updated` in the same transaction as the write.
- `Cache-Control: no-store` on both responses; clinical redaction in logs.

## Out of scope
- `GET /api/patients/{patientUserId}` and `GET /api/patients/{patientUserId}/records`: both need the doctor↔patient
  relationship `EXISTS` on `consultations` (and the timeline needs `medical_records`). They ship with `consultations`
  (profile read) and `records` (timeline). The contract operations stay as written; this module does not mount them.
- Hydrating names/avatars (Identity-owned); no `fullName` in the profile.
- Profile deletion endpoint; `deleted_at` exists for the platform rule, not exposed.

## Key entities & relationships
`patient_profiles` — `user_id` (Identity id, no FK), `date_of_birth`, `gender`, `blood_type`, `allergies TEXT[]`,
`chronic_conditions TEXT[]`, `timezone` (IANA). Referenced logically by `consultations.patient_user_id`.

## Primary flows / endpoints (roles + ownership)
| Endpoint | Roles | Ownership | Audit |
|---|---|---|---|
| GET /api/patients/me | patient | self (`auth.userId`) | clinical-read |
| PATCH /api/patients/me | patient | self | clinical-write |

## Business rules
- Create requires `timezone`; PATCH is partial, `minProperties: 1`, unknown properties rejected, `null` clears the nullable scalar fields.
- Allergies and conditions: ≤ 50 items, ≤ 200 chars each (the database enforces the 50-item cap with a `CHECK`; request validation enforces the per-item rules: length, non-blank, no duplicates).
- Timezone validated with luxon `IANAZone.isValidZone`; date of birth is a calendar date not in the future.
- Concurrent first-time PATCHes resolve on `uq_patient_profiles_user_id` (the loser retries as an update, never a 500).

## Cross-service touchpoints
None. No Identity call: the principal and role come from the verified token; no name or email is stored.

## Privacy & audit
Allergies, conditions, blood type and date of birth are clinical/PII: never logged, never in audit metadata (ids and
changed field *names* only), `no-store` on responses.

## Constraints & guideline notes
Patient routes accept `status=active` only. Email verification is **not** required for the profile (only for booking).
Idempotency-Key optional (a PATCH is naturally idempotent).

## Contract changes expected
None expected; the operations and schemas already exist. Spec confirms.

## Open questions
- Whether `GET /patients/{id}` ships with consultations (recommended) or with records. When those routes ship they must keep the contract access: the patient themself and a doctor with a completed or current consultation with that patient; admins never.

## Success criteria
A patient can create, read and amend only their own profile; admin and doctor tokens get 403; every read/write leaves an
audit row; no clinical fixture string appears in logs.
