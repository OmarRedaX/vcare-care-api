# /develop-feature-e2e foundation — checkpoint (both spokes)

Mode: **Checkpoint** (pause after specs, after each review round). Worker: empty skeleton included.
Units: `care:foundation` and `identity:foundation` — separate repos, no shared files → **parallel** (main trees, no worktrees).
Briefs: `vcare-care-api/docs/foundation/brainstorm.md`, `vcare-identity-api/docs/foundation/brainstorm.md`.

## Progress
- [x] Step 0 run mode · [x] Step 1 briefs · [x] Step 2 units
- [x] Step 3 specs (both status: ready)
- [x] checkpoint: user approved all parity proposals (row table: concrete path, user:/client:/ip:, immediate 409+Retry-After 1,
  details always, ready ok|degraded|down, tsx, metric()+ALS) and CLAUDE.md tree edit (DONE in both: bootstrap.ts, migrate.ts, lib/lifecycle, lib/worker, http helpers)
- [x] both specs carry the parity decisions (spec agents died to the session limit afterwards; work verified by the orchestrator)
- [x] identity contract health live/ready applied + redocly lint valid
- [x] care contract health live/ready applied by the orchestrator (4 ops, HealthLive + HealthStatus{ok|degraded|down, checks.database/redis}, HealthLiveOk/HealthReadyOk/HealthReadyDown); redocly valid, no dangling refs
- [x] hub synced (both contracts+cards) + check-freshness OK — MUST re-sync after /update-docs (cards still say health "planned")
- [x] identity:foundation BUILT (73 ts files, lint/typecheck clean, migration up+down+up, all 4 health endpoints verified; test stack left up on 5435/6382).
      Deviations noted in its report; ADR 0015 written; INDEX row for ADR 0015 still owed to /update-docs.
      Env notes: host port 3000 taken by an unrelated app (used 3020/3120); SIGTERM undeliverable in Git Bash on Windows → signal handlers unverified.
- [x] care:foundation BUILT — lint 0 / typecheck 0 verified by the orchestrator; migration up+down+up on Postgres 17; all 4 health
      endpoints + 404 envelope + request-id + CORS verified; ADR 0016 written; test compose left up on 5434/6381.
      Care deviations to watch in review: @types/pg dev dep · envSchema not annotated z.ZodType<Env> (zod 4 variance) · URL/IP via .refine ·
      withContainerOverrides overrides the ROOT container (spec's child-container seam could not work) · serializeError moved to logger.ts.
- [!] BLOCKED (user decision pending): care `.env.example` + `.env.test` refused by a Read deny rule in permission settings.
      Care integration tests cannot run until they exist. Contents are in care spec §3.8 (also quoted to the user).
      Do NOT work around the denial. Also care `dist/` left on disk (rm denied; gitignored, harmless).
- [x] identity:foundation TESTS done and verified by the orchestrator: unit 23 suites / 161 tests, integration 9 suites / 55 passed + 2 skipped
      (SIGTERM shutdown skipped on win32, runs on CI ubuntu), lint 0 / typecheck 0. New helper tests/helpers/contract.ts asserts responses
      against contracts/openapi.yaml (drift fails a test). Root cause of the earlier 4 crashed suites: tests/setup.ts used
      process.loadEnvFile, which mutates the worker's real process while jest hands each file a pre-setup copy of process.env → env exit(1) → worker death. Fixed test-side.
      ⚠ FLAKE: one run failed (1 suite / 1 test) immediately after the agent's own run; 4 consecutive re-runs then passed 161/161 clean.
      Not reproducible → treated as a cold-start timing flake (suspect the idempotency suite, which needs jest.setTimeout(20_000) while all
      workers transpile in parallel). NOT pinned to a named test. Hand to /review-code as a watch item; if CI ever shows it, get the test name from CI output first.
      Two observations routed to review, not bugs: errorHandler logs unknown-error stacks (intended per CLAUDE.md, but a secret inside a message would reach stdout);
      1 s knex acquire timeout is tight enough that event-loop blocking (TS transpile at boot) surfaces as KnexTimeoutError on cold starts.
- [~] Step 6 tests: identity flow-test-author RESUMED (died at the session limit after 17 unit files; 13 suites pass,
      4 suites fail with jest worker child-process exceptions + 1 test failure — told it to find the real cause, no --runInBand papering over).
      care flow-test-author NOT started (waiting on the env-file decision).
  ← NEXT: user answers env question → start care tests; then Step 7 manual QA, Step 8 review ×2, Step 9 docs + RE-SYNC hub (cards still say health "planned")
  Parity diffs: idem route (care concrete path vs identity pattern) · principal (u/ip vs user:/client:/ip:) ·
  in-flight dup (care wait 5s vs identity 409 Retry-After 1) · details (care always vs identity omit-empty) ·
  ready 503 status (care "down" vs identity enum ok|degraded) · dev runner (ts-node vs tsx) · logger metric()/ALS (identity only)
- [ ] Step 4 contracts (health live/ready, both repos) + redocly lint
- [ ] Step 5 develop ×2 · [ ] Step 6 tests ×2 · [ ] Step 7 manual QA · [ ] Step 8 review loop · [ ] Step 9 docs + hub sync

Nothing committed (both repos had uncommitted docs before this run).
