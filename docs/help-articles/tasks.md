---
title: help-articles — Tasks
owner: care-team
service: care-service
module: help-articles
status: in-progress
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
- [ ] (migration) `<ts>_create_help_articles` (table, named checks, two partial indexes + unique index, comments, explicit grants, real down)
- [ ] (enums-errors-types) `constants.ts`, `enums.ts`, `errors.ts`, `types.ts`
- [ ] (entity) `HelpArticle`, `HelpArticleSummary`
- [ ] (request-dto) `ListHelpArticlesQueryDto`, `CreateHelpArticleDto`, `UpdateHelpArticleDto`
- [ ] (response-dto) `HelpArticleResponseDto`, `HelpArticleSummaryResponseDto`
- [ ] (repository) `help-articles.repo.ts` (list, find visible, find for update, insert, update, soft delete)
- [ ] (service) `HelpArticlesService` + DI tokens + `bootstrap.ts` registration
- [ ] (policies) `policies.ts`
- [ ] (controller) `HelpArticlesController` + DI registration
- [ ] (routes) `routes.ts` — guard → authorize → rate limit → idempotency (POST) → handler
- [ ] (mount) `src/routes.ts` (`buildHelpArticlesRouter`, `PRIVATE_NO_CACHE_PREFIXES`) and `src/app.ts` prefix middleware before the JSON parser
- [ ] (tests) ← /write-tests (spec section 9)
- [ ] (manual-qa) ← /manual-qa (spec section 9.5)
- [ ] (docs) ← /update-docs (spec section 13: data-model, api, rbac, help-articles shard, overview, system-design, INDEX, service-card; hub sync)
