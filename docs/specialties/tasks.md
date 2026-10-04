---
title: specialties — Tasks
owner: care-team
service: care-service
module: specialties
status: done
last_verified: 2026-10-04
tags: [tasks, specialties, catalog, pagination, keyset, validation, rate-limit, audit, migration]
related: [specialties-spec, specialties-brainstorm, specialties-manual-qa, access-tasks, adr-0017-generic-helpers-and-transaction-scoping, adr-0018-db-role-split-explicit-grants-partition-function]
---

# specialties — Tasks

Source of truth: [spec.md](./spec.md) (v1.1.0, status `implemented`; built from v1.0.0 — §16 lists the as-built divergences). Tags follow CLAUDE.md → "Build order for a new module"
and spec §15. **Who:** `Codex-code` = implemented by Codex (src, migrations, test code); `Opus-docs` = Opus /
orchestrator. A task is `[x]` only after typecheck, lint, unit, and integration (Docker test stack 5434/6381) are green.

## Legend
- [ ] todo · [~] in progress · [x] done

## Tasks

### Step 0 — contract and hub
- [x] (contract) `Opus-docs` C1: `listSpecialties` description only (spec §13.2)
- [x] (contract) `Opus-docs` hub sync `scripts/sync-from-spoke.sh care-service ../vcare-care-api` on hub branch `docs/care-specialties-deltas`

### Step 0a–0d — foundation fixes (lib first, spec §12, §3.9)
- [x] (service) `Codex-code` #8: `lib/validation/transforms.ts` (`ToInt`, `ToBoolean`), `validate.ts` conversion off, `PaginationQueryDto.limit` → `@ToInt()`, ESLint selectors + unit tests (spec §12.2)
- [x] (service) `Codex-code` #7: `lib/http/pagination/timestamp-cursor.ts`, `decodeTextCursor`, `decodeTimestampCursor`, `StringCursorPosition`, test router modes + unit/integration pagination tests (spec §12.1)
- [x] (service) `Codex-code` #9: rate-limit `ZADD` member `${now}-${randomUUID()}`, `buildRateLimitRouter` `now` param, unit + concurrent integration tests (spec §12.3)
- [x] (service) `Codex-code` `lib/knex/pg-errors.ts`, `lib/auth/require-auth.ts` + unit tests (spec §3.9)
- [x] (docs) `Opus-docs` `.claude/skills/write-migration/SKILL.md` timestamp-cursor rule (spec §12.1, §14)

### Build
- [x] (migration) `Codex-code` migration 1 `create_specialties` — table, checks, grants, `idx_specialties_name_id` (spec §2.2)
- [x] (migration) `Codex-code` migration 2 `seed_specialties_starter_catalog` — 20 synthetic rows, `ON CONFLICT DO NOTHING` (spec §2.3–§2.4)
- [x] (enums-errors-types) `Codex-code` `constants.ts`, `enums.ts`, `errors.ts`, `types.ts` (spec §3.3)
- [x] (entity) `Codex-code` `entity/specialties.entity.ts` (spec §3.4)
- [x] (request-dto) `Codex-code` `dto/specialties.request.dto.ts` (spec §3.5)
- [x] (response-dto) `Codex-code` `dto/specialties.response.dto.ts` (spec §3.6)
- [x] (repository) `Codex-code` `repository/specialties.repo.ts` (spec §3.7)
- [x] (service) `Codex-code` `service/specialties.service.ts` + DI token/registration (spec §3.9, §3.11)
- [x] (policies) `Codex-code` `policies.ts` (spec §3.10)
- [x] (controller) `Codex-code` `controller/specialties.controller.ts` + DI registration (spec §3.8, §3.11)
- [x] (routes) `Codex-code` `routes.ts` (spec §3.2)
- [x] (mount) `Codex-code` mount in `src/routes.ts`
- [x] (tests) `/write-tests` tests of spec §9 — unit (5 suites, 82 tests), integration `specialties.test.ts` (133), seed-migration cases in `migrations.test.ts`, `boot.test.ts` 401 test; RBAC, contract, idempotency, concurrency, rate limit, EXPLAIN, grants, logs. Green on the Docker test stack (unit 916, integration 335 pass / 2 pre-existing skips)

### After `/develop` (not started here)
- [x] (qa) `Opus-docs` `/manual-qa specialties`, incl. compiled-build #8 check (spec §9.5) — 199 pass / 0 fail on real Identity tokens; [manual-qa.md](./manual-qa.md), `scripts/curl-test-specialties.sh`
- [x] (docs) `Opus-docs` `/update-docs specialties` (2026-10-04) — spec §14 list and v1.1.0 §16 As-built notes; `architecture/{data-model,api,rbac,overview}.md`, `service-card.md`, `INDEX.md` (tasks row), `foundation/spec.md` §13.3 (#7 #8 #9 fixed), `access/spec.md` §10. Hub card re-sync and hub catalog row are the orchestrator's (outside this repo)

### Fix-review — `reviews/review-20261004-2058.md` (2026-10-04)
- [x] (request-dto) M1 code-point lengths: `lib/validation/string-decorators.ts` `CodePointLength` on `name`/`description` in both DTOs (was `@Length`/`@MaxLength`, which under-counted presentation sequences → DB 500); spec §3.5 corrected
- [x] (service) M2 `decodeTextCursor` counts code points; `PaginationQueryDto.cursor` `MaxLength(1024)` after contract `Cursor.maxLength` 512 → 1024 (a 51-emoji name made paging stick; 100-emoji names emitted > 512-char cursors)
- [x] (request-dto) M3 NUL / control characters: `NoControlCharacters("all")` on `name`, `("nul")` on `description`; `decodeTextCursor` rejects a NUL sort value (was Postgres `22021` → 500)
- [x] (tests) L1 keyset EXPLAIN asserts `Index Cond` holds the `ROW(name, id) > ROW(…)` comparison
- [x] (contract) L2 `listSpecialties` `x-account-state`; `x-account-state` listed in the `info` vendor extensions; policy test parses `x-roles`/`x-account-state` from the contract (`contractOperationBlock`)
- [x] (tests) regression tests for M1–M3: DTO unit tables (200-code-point name, 4 000-code-point description, NUL, `\u0001`; `"a️"` and 100 astral chars accepted), `string-decorators.test.ts`, cursor unit cases (60 emoji, NUL, ≤ 1024 for the worst name), integration 400 + no row + no audit row for each bad body on `POST`/`PATCH`, NUL cursor 400, paging across a 51-emoji name returns every row once. Green on the Docker test stack: unit 937 passed; integration 347 passed / 2 skipped (verified by the orchestrator, 2026-10-04)
- [x] (docs) D1–D3 `docs/INDEX.md` tasks row; `service-card.md` status and endpoint families; `architecture/{rbac,api,data-model}.md` and spec §14 CLAUDE.md note — this `/update-docs` run
- [x] (review) `/review-code specialties` re-review: verify the fixes and the docs findings, then delete the review file (no review file = clean module)

## Notes
- **Manual QA predates the fix-review:** [manual-qa.md](./manual-qa.md) (199 pass) ran with the 512-character cursor cap
  and the old length validators; the fix-review behaviour is covered by unit and integration tests. Re-run
  `scripts/curl-test-specialties.sh` if a QA record of the new limits is wanted.
