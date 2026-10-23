---
title: availability — Tasks
owner: care-team
service: care-service
module: availability
status: active
diataxis: reference
last_verified: 2026-10-23
tags: [availability, slots, search, tasks, slice-1, slice-2, slice-3]
related: [availability-spec, availability-brainstorm, availability-architecture, availability-manual-qa, scheduling-slots]
---

# Availability — tasks

Build order tags refer to CLAUDE.md → Build order for a new module. Slice 1 first, slice 2 (search, profile, loops) below the slice 1 gate status. Slice 3 (name index and name filter) has its own section at the end (branch feature/availability-slice3).

- [x] S1-01 [0] Apply contract edits C1 to C3 (spec §3.0) and write `availability-contract.test.ts` (S1 part).
- [x] S1-02 [2] `env.ts` + `Env` type: `SLOT_CACHE_TTL_SECONDS`; availability constants, enums, types; `DoctorChangeKind` + port types in doctors.
- [x] S1-03 [pkg] `pkg/slots` additions (spec §12.1.2) with the unit tests of §9.1 including the property test.
- [x] S1-04 [lib] `lib/redis/try-redis.ts` + tests.
- [x] S1-05 [6] Readers and repos: `SlotInputsReader`, `BusyIntervalsReader`, `DoctorDiscoveryReader.findForSlots`; register tokens; EXPLAIN test for the busy statement.
- [x] S1-06 [7] `NextAvailableIndex` (slots part), `SlotInputsLoader`, `AvailabilityService`, `AvailabilityChangeListener`; `DoctorsService.notifyDoctorChanged` and the call sites in doctors / admin-doctors; `bootstrap.ts` rebinding.
- [x] S1-07 [4,5] `DoctorSlotsQueryDto`, slot response DTOs (`SlotResponseDto`, `SlotWindowMetaDto`).
- [x] S1-08 [8] `policies.ts` (`slots`).
- [x] S1-09 [9,10,11] Controller, `routes.ts` (limiters named in §7.3), mount in `src/routes.ts`.
- [x] S1-10 [12] Integration, RBAC, contract, invalidation, cache, book-every-listed-slot, budget tests (§9.1).
- [x] S1-11 [13] `/manual-qa availability` slots section (`scripts/curl-test-availability.sh`).
- [x] S1-12 [14] Docs: `docs/availability/tasks.md`, INDEX, as-built notes in the spec.

## Gate status (2026-10-23)

Slice 1 gate met; all tasks above are `[x]`.

- Full `npm run test:integration`, run in batches of about 10 files (real Postgres on 5499, real Redis on 6380): 58 files, 56 suites pass, 2 fail. The 2 failures are the known environment-only ones: `db-roles` (4 password cases) and `storage-adapter` (3 MinIO cases; Docker unavailable). `migrations.test.ts` passed alone (41 tests).
- Three more files failed once under batch load (`consultations-rules` 1 test, `record-attachments-rules` 2, `sessions-rbac` 1) and pass when run alone (39, 45 and 63 tests). They are load flakes, not regressions.

- `npm run typecheck` and `npm run lint` (eslint) are clean.
- `npm test`: 180 suites / 3,367 tests pass.
- Availability integration: 3 suites / 28 tests pass with real Postgres and real Redis (slots, Redis cache and invalidation, busy-interval `EXPLAIN`). The privacy suites (`records-privacy`, `record-attachments-privacy`, which allow the derived `slots-ver:`, `slots:`, `next-available:`, `free-map:` Redis prefixes) pass.
- Opt-in benchmark (`npm run test:bench`, now with the integration global setup and real Postgres/Redis) passes: HTTP 14-day window with 150 busy consultations, cache miss p95 about 19 ms, cache hit p95 about 11 ms, pure `computeSlots` p95 about 4 ms, all against the 300 ms budget.
- Manual QA is recorded in [manual-qa.md](./manual-qa.md); the repeatable script is `scripts/curl-test-availability.sh`.

## Docs reconciled by /update-docs (2026-10-21, slice 1 only)

- `docs/availability/spec.md` (v0.1.1, section 14 as-built notes), `docs/INDEX.md`, `docs/service-card.md`, `docs/architecture/{availability,scheduling-slots,overview,api,infrastructure,resilience,consultation-lifecycle}.md`, `docs/runbook.md`, `docs/quickstart.md`, `.env.example`, and the `CLAUDE.md` Status block (plus the `slots:` key text in Performance rules, which gained `<ver>`).
- Contract: `getDoctorSlots` (C1 to C3) matches the as-built controller, DTOs and policy; no drift. S2 edits C4 to C8 are not applied yet (slice 2).
- Slice 2 and 3 docs (search, profile, rank index, free-map, loops, name index) stay as designed; the architecture shard and spec describe them as planned.

## Pending outside this repo

- Sync `contracts/openapi.yaml` and `docs/service-card.md` to the hub with `cd ../vcare-hub && scripts/sync-from-spoke.sh care-service ../vcare-care-api` (the hub copies predate C1-C3 and the slice 1 card text; slice 2 adds C4-C8 and the search/profile/worker card text, so the sync is due again after this branch is merged). Hub edits other than the sync belong to `/system-design`.

## Slice 2 — Search, profile, loops, degradation (branch feature/availability-slice2)

Legend: [ ] todo, [~] in progress, [x] done (typecheck and the task's tests green). The curl script, review and docs are separate passes.

- [x] S2-01 [0] Contract edits C4 to C8; contract test S2 part.
- [x] S2-02 [1] Migration `20261021120000_add_doctor_discovery_indexes` (+ migration test extension); EXPLAIN fixtures are a later integration pass.
- [x] S2-03 [2] Env vars `AVAILABILITY_*`; constants; `DegradedPart`; types.
- [x] S2-04 [pkg/lib] Free-map functions (already built in slice 1); `lib/async/single-flight.ts` (+ `yield-to-event-loop.ts`); tests.
- [x] S2-05 [6] `doctor-discovery.repo.ts` (candidates, page, bookable list, view loads), `SchedulesService.listActiveTypesFor`, `SlotInputsReader.loadSlotInputs` (batch, built in slice 1), `DoctorsService.findPublicViews`.
- [x] S2-06 [7] `NextAvailableIndex` (index part), `NextAvailableComputer`, `rules.ts` + `discovery-cursor.ts`, `DiscoveryService`, `AvailabilityRefreshService`, `AvailabilitySweepService`.
- [x] S2-07 [4,5] `SearchDoctorsQueryDto`, `GetDoctorQueryDto`, `DiscoveryDoctorResponseDto` (viewer-aware), `PaginationMeta` + `degraded`.
- [x] S2-08 [8,9,10,11] Policies (`search`, `getDoctor`), controller methods, routes with limiters.
- [x] S2-09 [worker] `WorkerLoopDeps.redis`, `worker.ts` Redis lifecycle, `worker-loops.ts` registration, `--once` for both loops.
- [x] S2-10 [12] Unit + integration + RBAC + contract + degradation + pagination + freshness + worker + EXPLAIN + budget tests.
  - Unit part done (2026-10-23): rules, discovery-cursor, index (rank), computer, discovery service, refresh and sweep services, loops and worker wiring, loader, repo SQL shape, DTOs, controller, routes, policies, env, contract, single-flight.
  - Integration part done (2026-10-23), real Postgres 5499 and Redis 6380, fake Identity and JWKS, each file green alone: `availability-search` (34), `availability-search-pagination` (33), `availability-freshness` (31), `availability-degradation` (23), `availability-worker` (5 pass, 1 skipped on win32), `availability-search-explain` (14). Helpers: `tests/helpers/availability-harness.ts` (consultations harness plus a rebuilt discovery stack on the test clock and Identity client, `withRedisDown`, sweep and refresh ticks, suite-wide log capture that fails on any display name or avatar URL), `tests/helpers/availability-seed.ts` (single and `generate_series` bulk doctors).
  - Budget part done: `tests/bench/availability-search-http.bench.test.ts` (`npm run test:bench`), 2,500 bookable doctors, 100 requests per run after 10 warm-up. Search p95: warm 12 to 48 ms, cold index with the inline cap 68 to 97 ms, Redis down about 64 ms (one run), all against 400 ms. Slots at the same scale: miss 14 ms, hit 7 ms (300 ms budget). One full sweep of 2,500 doctors takes 6.4 to 6.7 s on the dev machine. Figures and the EXPLAIN findings are in spec section 14.
  - Caveats: (1) the graceful SIGTERM case of `availability-worker` is skipped on win32 like `process.test.ts`, it runs on CI (its client-observation logic was run here with SIGKILL); (2) EXPLAIN evidence differs from spec 8 in two places that are planner choices, not defects: the unfiltered path B candidate scan hashes the active-type set (Seq Scan on `consultation_types`, 13 ms for 2,500 candidates of 20,000 profiles) instead of probing `idx_consultation_types_doctor_profile_id_active`, which every keyset page and every selective filter does use; the `specialties` slug lookup reads the 10-row table directly; the sweep list sorts by id over a bitmap scan of the bookable partial index; (3) the AV-R16 span rule (more than 14 days) is unreachable through HTTP because both supplied bounds must lie in `[now, now + 14 d]`, the boundary (exactly 14 days) is tested.
- [x] S2-11 [13] `/manual-qa availability` search/profile sections (2026-10-23). `scripts/curl-test-availability.sh` (slice 1 kept, slice 2 added) plus `scripts/availability-qa-fake-identity.mjs`; clean final runs: Redis up 193 pass / 0 fail / 1 skipped, Redis down 163 pass / 0 fail / 1 skipped; no real failure. Record: [manual-qa.md](./manual-qa.md).
- [x] S2-FR [fix-review] Review 20261023-1130 fixed (2026-10-23): completed stays busy (AV-R4), sweep re-checks stale ids, daemon awaits the bounded Redis connect before the first tick, path B candidates ordered `(fee, id)`, contract MinFee/MaxFee maximum and SpecialtyFilter minLength. The review is closed (re-review found nothing; the review file is deleted, so no review file = clean module).
- [x] S2-12 [14] Docs, runbook alerts, as-built notes (`/update-docs`, 2026-10-23). Reconciled: spec v0.2.0 (slice table, sections 4, 8, 11, 12, 13, new slice 2 as-built notes in section 14), `docs/architecture/{availability,overview,deployment,api,infrastructure,resilience,capacity,data-model,consultation-lifecycle,scheduling-slots}.md`, `docs/{runbook,service-card,INDEX,system-design,quickstart}.md`, `docs/availability/manual-qa.md`, `CLAUDE.md` Status block, `.claude/skills/timezone-slot-computation/SKILL.md`, `.claude/state/system-design-checkpoint.md`. Contract: no drift (C4 to C8 and the review-time bounds match the code).

### Gate status (slice 2, 2026-10-23)

Slice 2 gate met; all S2 tasks above are `[x]`. Every number below was re-run by the orchestrator, not copied from an agent report.

- `npm run typecheck` and `npm run lint` clean.
- `npm test`: 197 suites / 3,578 tests pass (slice 1 baseline 180 / 3,367).
- Full `npm run test:integration` in 7 batches of up to 10 files (real Postgres 5499, real Redis 6380): 64 files, 62 pass, 2 fail. 1,917 tests: 1,907 passed, 7 failed, 3 skipped. The 7 failures are the known environment-only ones: `db-roles` (4 password cases) and `storage-adapter` (3 MinIO cases; no Docker). The privacy suites (`records-privacy`, `record-attachments-privacy`) pass inside these batches.
- The six new availability integration files (`availability-search`, `-search-pagination`, `-freshness`, `-degradation`, `-worker`, `-search-explain`) run alone: 6 suites, 140 passed, 1 skipped (graceful SIGTERM, skipped on win32 by convention).
- `npm run test:bench`: 4 suites pass. Search at 2,500 bookable doctors (p95, 100 requests after warm-up, budget 400 ms): warm earliest 38.8 ms, price 12.8 ms, experience 11.9 ms, earliest page 2 34.4 ms, earliest with window 53.1 ms; cold index earliest 128.1 ms, price 106.4 ms, experience 102.5 ms, earliest with window 116.5 ms; Redis down 69.8 ms. Slots 14 days with 150 busy consultations (budget 300 ms): cache miss 15.7 ms, hit 8.9 ms. A full sweep of 2,500 doctors took about 7.0 s.
- Manual QA, re-run from scratch by the orchestrator (Redis up, Care on 3031): `Availability CURL QA (Redis up): 191 passed, 0 failed, 2 skipped` (the skips: the degraded-cursor case needs a Redis-down run's cursor, and the unreachable more-than-14-days span). The QA agent's own runs: 193/0/1 Redis up, 163/0/1 Redis down.
- `/review-code`: five parallel dimension reviewers, 24 candidates, 5 verified findings (1 Medium, 3 Low, 1 Docs), all fixed (S2-FR); the re-review verified each fix, found nothing new and deleted the review file.
- Follow-up: `scripts/curl-test-consultations.sh` did hit `trg_notification_outbox_delete_sent_only` (its `reset` and a mid-run delete removed pending outbox rows). Fixed by marking the fixture rows `sent` first; the trigger is unchanged. Re-run: 382 pass / 2 fail. The 2 failures are stale expectations unrelated to the trigger: case 96 (`followUpOfRecordId-not-supported` now returns 404 because follow-up bookings exist) and case 361 (expects `vcare_app` to lack DELETE on `notification_outbox`; migration `20261012120000` grants it).

## Slice 3 — Name index and name filter (branch feature/availability-slice3)

Legend: [ ] todo, [~] in progress, [x] done (typecheck and the task's tests green). Slice 3 is built in passes: code and unit tests first (S3-01, S3-02), then integration tests (S3-03), then manual QA and docs (S3-04).

- [x] S3-01 [pkg/lib] `pkg/utils/name.ts` `normalizeName` (NFC, trim, whitespace collapse, lower-case) and `lib/redis/lex.ts` `prefixRange`; slice 2's local `resolveNamePrefix` is gone (`rules.ts` keeps only the `>= 2` code-point check as `assertNamePrefix`, same `400` with `details[].field = "name"`). Unit tests: `tests/unit/pkg/utils/name.test.ts`, `tests/unit/lib/redis/lex.test.ts`, `rules.test.ts` updated.
- [x] S3-02 [7] Name index code (2026-10-23):
  - `NextAvailableIndex.readNameMatches(prefix)` (one `MULTI` of `EXISTS` + `ZRANGEBYLEX ... LIMIT 0 5000`; absent key, Redis unusable or a command error -> `undefined`), `replaceNameIndex(members, builtAtMs)` (side key `name-index:building`, chunks of 500, `EXPIRE 600`, then one `MULTI` of `RENAME` + `EXPIRE 900` + `SET name-index:built-at EX 900`; an empty list deletes the index and still stamps), `readNameBuiltAt()`. Keys and limits in `keys.ts` / `constants.ts`.
  - `NameIndexBuilder` (`service/name-index.builder.ts`): hydrates the bookable doctors through `IdentityClient.getUsersBatch` in calls of 100 ids (cache-first inside the client), stops at the first degraded chunk and keeps the previous build (`availability_name_index_stale`), indexes only Identity-`active` users with a non-blank name, swaps in, logs `availability_name_index_built {members}`.
  - `AvailabilitySweepService` takes the builder and `AVAILABILITY_NAME_REFRESH_SECONDS`; after stamping `swept-at` it rebuilds when `name-index:built-at` is absent or at least that old; any error is caught and logged `availability_name_index_failed {reason}` (error class only) and never fails the sweep. `worker-loops.ts` builds the `NameIndexBuilder` from the worker's `IdentityClient` (which already uses the worker Redis for the `identity:user:*` cache).
  - `DiscoveryService`: with `name`, `normalizeName` -> `assertNamePrefix` -> `index.readNameMatches`; the matched user ids go to the candidate SQL as `nameMatchedUserIds` (`starts_with(lower(headline), $p) OR user_id = ANY($ids)`, intersected with the bookable candidates); `meta.degraded` gets `nameFilter` only when the index was missing, expired or Redis unusable (the slice 2 always-on flag is removed).
  - Unit tests: `next-available.index.name.test.ts`, `name-index.builder.test.ts`, `availability-sweep.service.test.ts` (name step), `discovery.service.test.ts` (name paths), `doctor-discovery.repo.test.ts` (SQL shape). Test helpers: `name-index` added to `DERIVED_AVAILABILITY_PREFIXES` (`tests/helpers/redis.ts`) and to the harness flush list; the harness sweep builds a `NameIndexBuilder`.
  - Integration suites touched: `availability-search` (renamed name describe, plus one index-backed case: display-name prefix after a sweep, no `meta.degraded`). `availability-search-pagination`, `-degradation`, `-freshness`, `-worker`, `records-privacy` and `record-attachments-privacy` are unchanged and green.
- [x] S3-03 [12] Integration tests of spec 9.3 (2026-10-23): `tests/integration/availability-name.test.ts` (26 tests, real Postgres and Redis, fake Identity): index-backed prefix on display name and headline (union, intersection with candidates and other filters, Latin and Arabic NFC, case, whitespace), rename visible only after the next due rebuild, no repeat rebuild inside the refresh interval, Identity call count and `identity:user:*` reuse per rebuild (chunks of 100), Identity down keeps the previous build without extending its TTL and falls back to headline-only with `meta.degraded:["nameFilter"]` once it expires, Redis down fallback, who is indexed, empty bookable set deletes the index, a failing rebuild never fails the sweep, pagination page 2/3 on both sorts, `400` below two code points, no names or avatar URLs in logs, full-database and Redis scan for fixture names.
- [~] S3-04 [13/14] **QA part `[x]` done 2026-10-23, no real failures:** manual QA of the name filter in `docs/availability/manual-qa.md` (slice 3 section) and `scripts/curl-test-availability.sh` + `scripts/availability-qa-fake-identity.mjs` (rows 66, 69, 70, 79 re-based on the index-absent / Redis-down fallback; 61 new Redis-up and 3 new Redis-down assertions; final runs 254 pass / 0 fail / 1 skipped with Redis up and 167 pass / 0 fail / 1 skipped with Redis down). **Docs part `[ ]` still open:** spec section 14 (slice 3 as-built, retire deviation 1), slice table status, `docs/architecture/availability.md`, `data-model.md` Redis key list, runbook, service card, INDEX, CLAUDE.md Status block, the checkpoint.
