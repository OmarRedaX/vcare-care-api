---
title: help-articles — Tasks
owner: care-team
service: care-service
module: help-articles
status: built-pending-tests
last_verified: 2026-10-29
tags: [tasks, help-articles, help-center]
related: [help-articles-spec, help-articles-brainstorm, adr-0027-help-articles-shape-and-access, adr-0028-help-corpus-read-path-for-phase-2, specialties-tasks]
---

# help-articles — Tasks

Source: [spec.md](./spec.md) (v0.1.0, ready). Branch `feature/help-articles`. Task order follows spec section 14. Tests of spec
section 9 (steps 12 and 13) belong to `/write-tests` and `/manual-qa`; only the two lib unit tests the spec assigns to step 0a
land here. The hub sync of the contract (`../vcare-hub/scripts/sync-from-spoke.sh`) is a hub-side action and is not run by this
phase (listed in the hand-off).

## Legend
- [ ] todo · [~] in progress · [x] done

## Tasks
- [x] (contract) C1-C5 in `contracts/openapi.yaml` (`HelpArticleSummary`, body/title descriptions, `x-account-state`, list sort and cursor kind wording, `CacheControlPrivateNoCache`, tag description)
- [x] (generic) `lib/http/private-no-cache.ts` `privateNoCache()` + unit test
- [x] (generic) `lib/http/pagination/cursor.ts` `decodeKindedTimestampCursor` + unit tests
- [x] (migration) `<ts>_create_help_articles` (table, named checks, two partial indexes + unique index, comments, explicit grants, real down)
- [x] (enums-errors-types) `constants.ts`, `enums.ts`, `errors.ts`, `types.ts`
- [x] (entity) `HelpArticle`, `HelpArticleSummary`
- [x] (request-dto) `ListHelpArticlesQueryDto`, `CreateHelpArticleDto`, `UpdateHelpArticleDto`
- [x] (response-dto) `HelpArticleResponseDto`, `HelpArticleSummaryResponseDto`
- [x] (repository) `help-articles.repo.ts` (list, find visible, find for update, insert, update, soft delete)
- [x] (service) `HelpArticlesService` + DI tokens + `bootstrap.ts` registration
- [x] (policies) `policies.ts`
- [x] (controller) `HelpArticlesController` + DI registration
- [x] (routes) `routes.ts` — guard → authorize → rate limit → idempotency (POST) → handler
- [x] (mount) `src/routes.ts` (`buildHelpArticlesRouter`, `PRIVATE_NO_CACHE_PREFIXES`) and `src/app.ts` prefix middleware before the JSON parser
- [ ] (tests) ← /write-tests (spec section 9)
- [ ] (manual-qa) ← /manual-qa (spec section 9.5)
- [ ] (docs) ← /update-docs (spec section 13: data-model, api, rbac, help-articles shard, overview, system-design, INDEX, service-card; hub sync)

## As-built notes (decisions made while implementing)
- **Migration timestamp** `20261029120000_create_help_articles`; verified on the test database (grants: SELECT/INSERT/UPDATE and sequence USAGE true, DELETE/TRUNCATE false; `uq_help_articles_audience_title` reports as `error.constraint` on 23505; rollback then latest round trip). Two extra column comments (`body`, `published_at`, `created_by`, `updated_by`) beyond the spec DDL.
- **`decodeKindedTimestampCursor` returns the bare timestamp** (`{ sortValue: <µs timestamp>, id }`), so the service passes it to the repository unchanged; the kind prefix is re-added only when the next cursor is built (`${kind}:${sort_cursor}`). The shared timestamp rule was extracted from `decodeTimestampCursor` (no behaviour change).
- **`listHelpArticles` returns `HelpArticleListEntry[]`** (`{ summary: HelpArticleSummary, sortCursor }`, in `types.ts`) instead of raw `HelpArticleSummaryRow[]`, so the private `toSummary` mapper stays in the repository and the `HelpArticleSummary` entity carries no DB-shaped field.
- **`audienceOf(role)` throws `Forbidden`** for any role other than patient or doctor (unreachable: `authorize` admits only the three roles and admins take the admin branch).
- Only the two step-0a lib unit tests were written here; spec section 9 is `/write-tests`. Verification at hand-off: typecheck clean, lint clean, full unit suite 202 suites / 3641 tests passing, `tests/integration/boot.test.ts` 13 passing, a throwaway repository smoke against the test database (insert, publish via COALESCE, reader/admin list, keyset page 2, soft delete, EXPLAIN-free SQL shape) rolled back.
- Hub contract sync (`../vcare-hub/scripts/sync-from-spoke.sh`) not run here.
