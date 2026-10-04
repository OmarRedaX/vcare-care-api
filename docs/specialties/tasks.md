---
title: specialties — Tasks
owner: care-team
service: care-service
module: specialties
status: in-progress
last_verified: 2026-10-04
tags: [tasks, specialties, catalog, pagination, keyset, validation, rate-limit, audit, migration]
related: [specialties-spec, specialties-brainstorm, access-tasks, adr-0017-generic-helpers-and-transaction-scoping, adr-0018-db-role-split-explicit-grants-partition-function]
---

# specialties — Tasks

Source of truth: [spec.md](./spec.md) (v1.0.0, status `ready`). Tags follow CLAUDE.md → "Build order for a new module"
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
- [ ] (tests) `Codex-code` tests of spec §9 — unit, integration, RBAC, contract, concurrency, EXPLAIN, grants (**belongs to `/write-tests`; not run in this `/develop`**)

### After `/develop` (not started here)
- [ ] (qa) `Opus-docs` `/manual-qa specialties`, incl. compiled-build #8 check (spec §9.5)
- [ ] (docs) `Opus-docs` `/update-docs specialties` — spec §14 list, hub roll-up
