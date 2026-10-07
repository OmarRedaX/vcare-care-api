---
title: doctors — Spec conformance check
owner: care-team
service: care-service
module: doctors
status: verified
diataxis: reference
last_verified: 2026-10-07
tags: [doctors, conformance, review]
related: [doctors-spec, doctors-tasks]
---

# doctors — Spec conformance check (2026-10-05)

Code in `src/app/doctors/**`, the three migrations, `timezone-decorator.ts`, the specialties `findByIds` edits and the
contract changes C1–C3 read against `spec.md` and CLAUDE.md. Typecheck and lint pass before and after the fixes below.

## Deviations fixed in code

| # | Where | Spec rule | Problem | Fix |
|---|---|---|---|---|
| 1 | `src/app/doctors/dto/doctors.request.dto.ts:20` | §3.5, D-R10, "never 500" | `consultationFee` carried only `@ValidateNested()`, which class-validator skips for `undefined`. `POST /apply` with no `consultationFee` passed validation and reached `input.consultationFee.currency` in the service → TypeError → 500. Reproduced with a probe; `null` and non-object values were already rejected | Added `@IsDefined()` (now 400 `consultationFee`) |
| 2 | `src/app/doctors/dto/doctors.response.dto.ts:50` | D-R12 (`isBookable` is the pure Domain-rule-6 function) | `isBookable` was hard-coded `false`, so the unit-tested function in the service was dead and a later `approved` profile would be mis-reported | `isBookable: isBookable(p, false)` (consultation-type term stays `false` until `schedules`) |
| 3 | `src/app/doctors/types.ts` | CLAUDE.md → Code style (no dead code) | `DoctorSpecialtyResolution` and its `Specialty` import were unused | Removed |

## Checked and conformant

- **Layering / types:** no inline `interface`/`type` outside `types.ts`; no cross-module repository import (specialties via `SpecialtiesService.findByIds`); no `lib/` → `app/` import.
- **DTOs:** `forbidNonWhitelisted`, `forbidUnknownValues`, no implicit conversion (shared `validateBody`); code-point lengths and control-character rules; `bio: null` only on PATCH; `ArrayUnique`; nested `MoneyDto` max 2147483647. No query or path field, so no `ToInt`.
- **Repositories:** functions with `conn = db`, explicit column list, `whereNull('deleted_at')` on both profile reads, update and suspension check; no `SELECT *`; set-based child statements.
- **Service:** Knex handler-form transaction; audit written inside it; no-op returns the current view with no write and no audit; sorted wire-name `changedFields`; one `ON CONFLICT` replace order (delete → clear primary → insert → mark primary).
- **Concurrent first apply:** `23505` on `uq_doctor_profiles_user_id` caught outside the transaction and `applyOnce` re-run once; a second `23505` or any other error propagates (no 500 for the loser).
- **Policies / routes:** `authorize()` on all four routes; statuses `pending|active|rejected`; `doctor_not_suspended` on `PATCH /me` only; order guard → authorize → limiter → idempotency (apply only).
- **O1/O2/O3:** timezone stored via `canonicalIanaTimezone`; insert states `is_accepting_patients = true`; `GET /me/application` returns the degraded `doctor` block with `profileHydrated:false`.
- **Migrations:** raw SQL, one change per file, real `down` without `CASCADE`, constraint and index names per the naming rules, FK columns covered by leading-column indexes, `GRANT SELECT, INSERT, UPDATE` only on `doctor_profiles` (no `DELETE`), explicit sequence grants.
- **Config / logging:** `ALLOWED_CURRENCIES` in `env.ts` (zod) and `.env.example`, empty string rejected; `headline`, `bio`, `reviewNote` in `REDACTED_KEYS`.
- **Contract:** C1 (`x-audit-actions`), C2 (currency description) and C3 (`maximum: 2147483647`) are applied.

## Notes (no code change)

- `DOCTOR_PROFILE_COLUMNS` also selects `suspended_by` and `suspension_reason` (the spec's list omits them). The entity carries them; they never reach a DTO. Harmless; spec §3.7 should list them at `/update-docs`.
- `canonicalIanaTimezone` lives in `lib/validation/timezone-decorator.ts`. Spec O1 allowed `lib/validation` or `pkg/utils/time.ts`; a non-decorator helper in the decorator file is a small mismatch of purpose, not a rule violation.
- ADR 0019 exists although the spec says no ADR is needed for `luxon`; it is consistent with CLAUDE.md (new runtime dependency ⇒ ADR) and can stay. `docs/INDEX.md` should list it at `/update-docs`.

## Needs your decision (spec O1 follow-up)

`Intl`-based canonicalization depends on the runtime's ICU data. Observed on this machine (Node 24):

| Input | Stored as |
|---|---|
| `africa/cairo`, `AFRICA/CAIRO` | `Africa/Cairo` (intended) |
| `utc`, `Etc/UTC` | `UTC` |
| `EST` | `America/Panama` (an abbreviation silently becomes a different named zone) |
| `Asia/Calcutta` | `Asia/Calcutta` (not `Asia/Kolkata`; ICU keeps the alias) |

Options: (a) accept as is (recommended for this slice: the stored value is a valid IANA zone and the case-variant goal of O1 is met);
(b) reject legacy abbreviations such as `EST` and require an `Area/Location` shape or `UTC`; (c) canonicalize through a fixed alias table.
Tests will pin only the case-variant behaviour (`africa/cairo` → `Africa/Cairo`) until you choose.
