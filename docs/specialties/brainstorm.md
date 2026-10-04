---
title: specialties — Brainstorm
owner: care-team
service: care-service
module: specialties
status: draft
diataxis: explanation
last_verified: 2026-10-03
tags: [brainstorm, specialties, catalog, pagination, validation, rate-limit]
related: [access-brainstorm, access-spec, rbac, data-model, api, foundation-spec]
---

# specialties — Brainstorm

## Problem & purpose
Doctors pick their specialties when they apply, and patients filter search by specialty slug. Both need an
admin-managed catalog. `specialties` is the **first business module** and the first real use of `userGuard`,
`authorize(policy)`, `AuditRecorder.record(trx, …)`, the boot route assertion, keyset pagination, and idempotency
on a mounted route. It stays thin (decided 2026-10-02, Q1 of the access brainstorm): three routes, one table, one
service. It also pays three foundation latent gaps that its routes expose first (#7, #8, #9).

## Actors
- **Patient / doctor**: read the active catalog (`GET /specialties`).
- **Admin**: reads including inactive rows (`includeInactive=true`), creates, edits, and deactivates specialties. Every write is audited.
- **doctors / search modules (later)**: consume `specialties.id` and `slug`; they do not call these routes.

## In scope (this iteration)
1. **`GET /api/specialties`** — roles patient, doctor, admin; ownership none. Cursor keyset, sorted by `name`
   (`limit` 1..100, default 20, `meta: { nextCursor, hasMore, count }`). Non-admins always see active rows only;
   `includeInactive` is honoured **only for admins** and ignored for other roles (contract text). Per-user and per-IP
   rate limit (contract documents `429`).
2. **`POST /api/specialties`** — admin; optional `Idempotency-Key`; body `{ name, slug, description? }`
   (unknown properties rejected). One transaction: insert + audit `specialty.created`. `201` with the `Specialty`.
   Duplicate `name` **or** `slug` → `409 Conflict` (SQLSTATE `23505` on `uq_specialties_name` / `uq_specialties_slug`).
3. **`PATCH /api/specialties/:id`** — admin; body any of `name, slug, description (nullable), isActive` (≥ 1 member).
   One transaction: update + audit `specialty.updated` (metadata: id and the **names** of changed fields, never
   values). `404 NotFound` for an unknown id, `409 Conflict` for a duplicate name/slug. Deactivating is `isActive=false`; there is no `DELETE`.
4. **`specialties` migration** per `data-model.md` (`uq_specialties_slug`, `uq_specialties_name`, `chk_specialties_slug_format`,
   no soft delete), explicit grants to `vcare_app` (`SELECT, INSERT, UPDATE`; no `DELETE`), plus the sort/keyset index with its query comment.
5. **Starter catalog in a separate data migration** (decided 2026-10-03): synthetic list of common specialties,
   `INSERT … ON CONFLICT (slug) DO NOTHING`, with a real `down` that removes only those slugs when unreferenced. Seeded rows
   carry no audit row (not an API action) — recorded in the spec.
6. **Foundation fixes** (decided/implied by issue #20):
   - **#7 cursor microseconds** — **full-precision cursor** (decided 2026-10-03): `lib/http/pagination` selects and
     encodes sort timestamps at microsecond precision (6-digit ISO text) and compares with `?::timestamptz`; canonical
     test router updated; `write-migration` skill notes the rule. Specialties itself sorts on `name`, so the fix is
     proven by a pagination integration test with rows sharing a millisecond (ASC and DESC), not by this list.
   - **#8 implicit boolean conversion** — `enableImplicitConversion: false` everywhere in `lib/validation`; strict
     `ToBoolean()` (`"true"`/`"false"` only) and `ToInt()` transforms; every non-string query/param field must carry an
     explicit transform. `includeInactive=false` must mean false under the compiled build, not only under `tsx`.
   - **#9 rate-limit member** — the ZSET member becomes server-generated unique (`crypto.randomUUID()`), never client-influenced;
     integration test with > `limit` concurrent requests sharing one `X-Request-Id`.

## Out of scope
- Doctor↔specialty links, search filter by slug, `SpecialtyRef` — `doctors` module. (What an inactive specialty means for
  existing doctor links and search is **a doctors-module decision**; this module only guarantees the flag and that rows are never deleted.)
- Translations / localized names, specialty hierarchy, icons.
- Hard delete or soft-delete column (data-model: deactivate only).
- A Redis cache of the catalog (small, admin-edited; revisit only if the search budget needs it).
- Foundation gaps #12–#17 (stay at their own triggers).

## Key entities & relationships
`specialties` (id BIGSERIAL, name VARCHAR(100), slug VARCHAR(100), description TEXT null ≤ 2000, is_active, created_at, updated_at).
Referenced later by `doctor_specialties.specialty_id` (`ON DELETE RESTRICT`). No Identity ids, no PII, no clinical data.

## Primary flows / endpoints
| Route | Roles | Ownership | Audit | Notes |
|---|---|---|---|---|
| `GET /specialties` | patient, doctor, admin | none | — | admin-only `includeInactive`; sorted by `name` |
| `POST /specialties` | admin | none | `specialty.created` (admin-action) | optional `Idempotency-Key`; `201`/`409` |
| `PATCH /specialties/:id` | admin | none | `specialty.updated` (admin-action) | `200`/`404`/`409` |

Wrong role → `403 Forbidden`. A route without `authorize(...)` fails boot (assertion from `access`).

## Business rules & state transitions
- Slug format `^[a-z0-9]+(-[a-z0-9]+)*$`, ≤ 100; name 2..100; description ≤ 2000 (contract = DB checks).
- `name` and `slug` uniqueness: **keep `data-model.md` as is** — `UNIQUE(name)` is case-sensitive (decided 2026-10-03). Sort is
  `ORDER BY name, id` in the database default collation; the cursor encodes `(name, id)`. Accepted trade-off: near-duplicates
  differing only by case are possible, and ordering depends on collation.
- Slug may change (contract allows it); it is the search filter key, so a rename breaks stored `?specialty=` links — accepted, admin-only.
- State: `is_active` true ↔ false, freely reversible, no other transitions.
- **No-op PATCH** (values equal current) is a **spec decision**; recommended: still `200` with the current row, but no write and no audit row when nothing changed.

## Cross-service touchpoints
None. No Identity call, no worker, no storage. Admin identity comes from the verified token only.

## Privacy & audit
- Audit rows hold ids, action, and changed field **names**; no names/descriptions of specialties are PII but are still kept out of `metadata` by rule.
- Logs contain `route`, `status`, `userId`, `role` only (existing logger rules); request bodies of these routes are not clinical.
- Audit is in the **same transaction** as the write; a rolled-back write (e.g. 409) leaves no audit row.

## Constraints & guideline notes
- No new runtime dependency (`class-validator`, `class-transformer`, `knex`, existing `lib/*` only).
- Contract is the source of truth; **no contract change expected** beyond verifying the existing operations
  (`listSpecialties`, `createSpecialty`, `updateSpecialty`). If the spec finds drift (e.g. documenting `ToBoolean` 400 for `includeInactive=yes`), the contract changes first.
- `rbac.md` already lists the specialties policy rows; `data-model.md` already holds the table; both are reconciled in `/update-docs`.
- Integration tests run only on the Docker test stack (5434/6381).
- Implementation split for this module (user, 2026-10-03): code is written by Codex; planning, spec, review, QA and docs by Opus; the orchestrator verifies every claim.

## Decisions (2026-10-03)
| # | Decision |
|---|---|
| D1 | #7: full-precision cursor in `lib/http/pagination`, not `TIMESTAMPTZ(3)` |
| D2 | Starter catalog seeded by a **separate data migration** (idempotent, synthetic) |
| D3 | Name uniqueness and sort stay as documented (case-sensitive `UNIQUE(name)`, default collation) |
| D4 | No cache, no `DELETE`, no hierarchy; deactivate via `isActive` |

## Open questions (for the spec author, none blocking)
- No-op PATCH behaviour (see above; recommended: no write and no audit row when nothing changed, still `200` with the current row).
- Rate-limit numbers for `GET /specialties` (recommend the public-read class: 60/min per IP, 120/min per user) and whether admin writes get a limiter (recommend none beyond the contract's `429`).
- Exact starter list (~20 common specialties, synthetic slugs).

## Success criteria
- Patient/doctor see only active rows; admin sees all with `includeInactive=true`; `includeInactive=false` and `=yes` behave (false / 400) in the **compiled** build.
- Page 2 of the default sort is stable and complete; the µs-boundary pagination test passes for ASC and DESC.
- POST/PATCH write the audit row in the same transaction; a 409 leaves none; non-admin → 403; unknown id → 404; idempotent replay returns the same row, a changed body → 422.
- `care_app` cannot `DELETE` from `specialties`.
- #7, #8, #9 fixed with regression tests and closed by the PR; typecheck, lint, unit and integration green on the test stack; manual QA with real admin/doctor/patient tokens.
