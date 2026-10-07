---
title: doctors — Brainstorm
owner: care-team
service: care-service
module: doctors
status: draft
diataxis: explanation
last_verified: 2026-10-04
tags: [brainstorm, doctors, onboarding, profile, specialties]
related: [specialties-spec, access-spec, rbac, data-model, api, integration]
---

# doctors — Brainstorm

Scope decided with the user on 2026-10-04 (branch `feature/doctors`, from `main` @ 66284e6 after the specialties merge).

## Problem & purpose
A doctor must be able to create and maintain a professional profile **before** any review happens. This module owns
the `doctor_profiles` row and its two child sets (languages, specialties) and the doctor's own onboarding routes.
It is the first slice of the doctor marketplace; verification (documents + admin decision), schedules, availability
and search build on it in their own modules.

## Actors
- **Doctor** (Identity account `status ∈ pending, active, rejected`) — creates a draft, edits it, reads it back.
- **Admin / patient** — no route in this slice (public read, admin review and search are later modules).
- No service callers in this slice (`/internal/doctors/:userId/summary` is deferred).

## In scope (this iteration)
- `POST /api/doctors/apply` — create the caller's profile as a `draft` (201) or update an existing `draft`/`rejected` one (200).
- `GET /api/doctors/me` — the caller's full own view (404 until applied).
- `PATCH /api/doctors/me` — partial update of profile fields, timezone and `isAcceptingPatients`.
- `GET /api/doctors/me/application` — the caller's application state (status, review note, sync state) as the contract defines it.
- Tables: `doctor_profiles`, `doctor_languages`, `doctor_specialties` (one migration each concern, raw SQL).
- Env: an allowlist of fee currencies.

## Out of scope
- Documents, uploads, `lib/storage`, `/doctors/me/documents*` → module `verification` (ADRs 0013–0015).
- Admin approve / reject / reopen and Integration Case 1 → `verification`.
- Suspend / reinstate and Cases 3 / 4 → their own module (needs `lib/identity-client`).
- `GET /doctors`, `GET /doctors/:id`, `/slots`, Case 2 hydration, `next_available_at` cache → `availability` / search module.
- Working hours, exceptions, consultation types → `schedules`.
- `GET /internal/doctors/:userId/summary` → later (no client holds `doctors:read`).
- Any Identity call. This slice makes **none**, so `lib/identity-client` is not built here.

## Key entities & relationships
- `doctor_profiles` — as in `architecture/data-model.md`: one live profile per Identity user (`uq_doctor_profiles_user_id` partial unique on `user_id WHERE deleted_at IS NULL`). New rows start `verification_status='draft'`, `identity_sync_status='not_required'`, `is_accepting_patients` set explicitly (no defaults on critical columns), `suspended_at NULL`.
- `doctor_languages` — one row per ISO 639-1 code (`^[a-z]{2}$`), unique per profile.
- `doctor_specialties` — links to `specialties(id)` (`ON DELETE RESTRICT`), exactly one `is_primary`, at most 5, unique per profile.
- Money is `consultation_fee INT` minor units + `currency CHAR(3)`; the wire shape is `Money { amount, currency }`.
- Identity user id is the owner key; no FK, comment on the column.

## Primary flows / endpoints (with roles + ownership)
| Route | Role / account state | Ownership | Notes |
|---|---|---|---|
| `POST /api/doctors/apply` | doctor, status pending/active/rejected | self (`user_id := auth.userId`) | 201 create draft · 200 update `draft`/`rejected` · 409 `Conflict` if `submitted`/`approved` · `Idempotency-Key` optional |
| `GET /api/doctors/me` | same | self | 404 `NotFound` until applied |
| `PATCH /api/doctors/me` | same, **not locally suspended** | self | `minProperties: 1`; arrays replace the set |
| `GET /api/doctors/me/application` | same | self | 404 until applied |

Flows:
1. First visit: `apply` with the full required body → 201 draft.
2. Edit: `PATCH /me`, or `apply` again (idempotent upsert of a draft/rejected profile).
3. Read back: `GET /me` (always the own full view, including `verificationStatus`, `identitySyncStatus`, `isBookable`).

## Business rules & state transitions
- **`submit` is contract-exact and dormant (user decision).** `submit=true` requires ≥ 1 live `license` and ≥ 1 live `id` document, else `400 ValidationFailed` with `details[].field = "documents"`. No upload route exists in this slice, so `submit=true` always returns that 400; it starts working when `verification` lands. `submit=false` is the draft path. No contract change.
- `apply` on a profile that is `submitted` or `approved` → `409 Conflict`. A `rejected` profile can be updated through `apply` and stays `rejected` (re-submission needs `verification`).
- Specialty rules: 1–5 ids, unique, `primarySpecialtyId ∈ specialtyIds`, every **newly linked** specialty must exist and be `is_active` (else `400 ValidationFailed`, `details[].field = "specialtyIds"`).
- Languages: 1–10 unique 2-letter lowercase codes. Timezone: valid IANA zone (`luxon`). Fee: `amount ≥ 0`, currency in the env allowlist (**user decision**, stricter than the contract's `^[A-Z]{3}$`). `defaultSlotMinutes` 5–240, `yearsExperience` 0–70, `headline` 5–160, `bio` ≤ 4000.
- Text fields count code points and reject control characters, using the existing `CodePointLength` / `NoControlCharacters` decorators from `lib/validation` (lessons of the specialties review).
- `isBookable` in the response is Domain rule 6 evaluated now (always `false` here: nothing is `approved`).
- No cache exists yet, so the contract's "changing timezone / `isAcceptingPatients` invalidates slot and next-available caches" is a no-op in this slice; the `availability` module wires the invalidation.
- No `DELETE`; soft delete only (`deleted_at`), never exposed.
- A concurrent first `apply` by the same user loses on `uq_doctor_profiles_user_id` (SQLSTATE 23505) and is resolved as a read of the winner (idempotent upsert), not a 500.

## Cross-service touchpoints (case, direction, failure policy)
None in this slice. Identity is not called. Case 1 (resubmission, Identity `pending`) is explicitly deferred to `verification`; Case 2 hydration and Cases 3/4 are deferred with their modules.

## Privacy & audit
- Professional data, not clinical, but still PII-adjacent: `headline`, `bio` never go to logs (add to the redaction key list if absent).
- Audit in the **same transaction** (**user decision**): `doctor.profile_created` on the 201 and `doctor.profile_updated` on a real change via `apply` (200) or `PATCH /me`. Metadata = profile id and **changed field names only**, never values. A no-op `PATCH` writes no row (as in specialties).
- Responses are the own view only; there is no viewer-aware variant yet because no other role reads profiles in this slice.
- All seed and test data synthetic.

## Constraints & guideline notes
- Layering, module skeleton and DB rules per CLAUDE.md; every route carries `authorize(policy)`; ownership comes from the token, never the body.
- Raw-SQL migrations with explicit `vcare_app` grants (`SELECT, INSERT, UPDATE`; no `DELETE`), real `down`, FKs named and indexed.
- Indexes only for a query that exists in code: `uq_doctor_profiles_user_id`, the `doctor_specialties` unique constraint + `idx_doctor_specialties_specialty_id_doctor_profile_id` (covers the `specialty_id` FK), the `doctor_languages` unique constraint. The search / verification-queue partial indexes in `data-model.md` are **deferred** to the modules whose queries need them.
- Transactions in Knex handler form, service-owned; unique violations mapped by constraint name outside the transaction (as in specialties).
- Rate limits: not decided here; the spec proposes a per-user write limiter (see Open questions).
- Codex implements `src/` + migrations + tests per the standing model split; Opus plans, specs, reviews, writes docs.

## Contract changes expected
1. `/api/doctors/apply` `x-audit-actions`: add `doctor.profile_created`, `doctor.profile_updated`.
2. Document the currency allowlist (a `400` for a currency outside the configured set) in `Money` / `DoctorApplyRequest` / `DoctorProfileUpdate` descriptions.
3. Possibly a `GET /api/doctors/me/application` shape check against `DoctorApplication` (the spec step verifies it; no change is assumed).
4. Hub sync of the care contract and card after the build (same session).

## Open questions
1. **`PATCH /me` on a `submitted` profile** — contract allows it (only suspension blocks). Allow and keep status, or lock editing while under review? Default: follow the contract (allow); revisit in `verification`.
2. **Inactive specialties already linked** — keep existing links when a specialty is later deactivated; only new links require `is_active`. Confirm in the spec.
3. **Rate limits** — default proposal: 20 writes/min per user on `apply` + `PATCH /me`, 120/min per user on reads. Numbers to settle in the spec.
4. **Currency env var** — name and whether it has a documented default (CLAUDE.md allows no defaults only for secrets). Proposal: `ALLOWED_CURRENCIES=EGP` documented default.
5. **`GET /me/application` body** — confirm it is a projection of the same row (status, reviewNote, submittedAt, decidedAt, identitySyncStatus) with no documents yet.
6. **Platform deltas to list for `/system-design`** — none expected (no new cross-service call, owner, or component).

## Success criteria
- A doctor with a pending/active/rejected token can create a draft, edit it, and read it back; every other role gets 403, a suspended token 401/403 per the guard, a non-owner never sees another doctor's row.
- `submit=true` returns the contract's 400 on `documents`; `submitted`/`approved` profiles return 409 on `apply`.
- Invalid specialty / currency / timezone / language / control characters return 400, never 500; concurrent first `apply` yields one row and no 500.
- Audit rows exist for create and each real update, with field names only; none for no-ops.
- Typecheck, lint, unit and integration (Docker test stack) green; contract, hub card/contract and docs in sync in the same session.
