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
- [!] STILL BLOCKED 2026-09-16: care `.env.example` / `.env.test` absent; deny rule `Read(./.env.*)` in care `.claude/settings.json:20` unchanged.
      The orchestrator's own Edit of that file was REFUSED by the auto-mode classifier as [Self-Modification] — Claude cannot narrow its own
      permission settings even when the user asks. Do NOT sed/work around it. User must either replace line 20 with `Read(./.env.local)` +
      `Read(./.env.*.local)` (keeps `.env` denied), or create the two files by hand (contents in care spec §3.8).
      Note `./` in these rules resolves against the SESSION's project root (care), which is why identity's identical rule never bit.
- [x] identity Step 7 manual QA DONE: 35 cases / 0 real failures; wrote docs/foundation/manual-qa.md + scripts/curl-test-foundation.sh
      (self-verified 57 assertions pass; RUN_INFRA_CASES=1 also cycles Redis/Postgres and restarts them via an EXIT trap).
      Verified degraded (Redis down → 200 degraded) and 503 (Postgres down → status "down") plus recovery on BOTH listeners; listener isolation; request-id echo/lower-case/regenerate.
      One product nit NOT fixed: while Postgres is down, Knex's own default logger prints an unstructured ANSI line + stack to stdout, breaking one-JSON-object-per-line parsing
      (fix = `log:` override in src/lib/knex/knexfile.ts routing Knex warnings through Logger). Decide: /develop follow-up or a review finding.
- [~] identity Step 7 manual QA: flow-qa-runner dispatched (health ×4, listener isolation, request-id, 404 envelope, Redis-down degraded /
      Postgres-down 503 + recovery; server on 3020/3120 because host 3000 is taken). Idempotency/rate-limit are test-router-only → integration suite covers them.
- [ ] identity Step 8 review: first flow-code-reviewer was KILLED BY THE USER before writing anything (no reviews/ dir exists). Do not relaunch without asking.
- [x] 2026-09-25 env blocker CLEARED: user committed `.env.example`, `.env.test`, `.env.test.example` in 74f3ce6 (deny rule unchanged — agents
      still cannot read them; tests load them at runtime). tasks.md tooling row flipped to [x].
- [x] 2026-09-25 user decision: HOLD identity review until Step 8 (review both spokes together). Do not relaunch before then.
- [x] 2026-09-25 care Step 6 tests DONE, verified by the orchestrator: typecheck 0 · lint 0 · unit 27 suites / 347 passed ·
      integration 9 suites / 72 passed + 2 skipped (SIGTERM on win32). Includes 5 `test.failing` pinning 3 PRODUCT BUGS → route to Step 8 review:
      (1) PRIVACY: serializeError keeps pg error `message` → request values (e.g. clinical text) reach logs via unhandled_error
          (src/lib/logger/logger.ts:25-37, errorHandler.ts:49) — fix changes the spec (spec lets message through); identity likely has the same;
      (2) Knex default logger prints raw ANSI lines during a Postgres outage (src/lib/knex/knex.ts:23-46, no `log` option) — SAME nit identity QA found;
      (3) INTERNAL_HOST .refine accepts non-IPs (src/lib/config/env.ts:29; spec §3.4.1 says ip()).
      tasks.md (tests) row left [~] until the bugs are fixed. Test-side fix: global-setup imported knex before loading .env.test.
      Correction: care in-flight duplicate = immediate 409 + Retry-After 1 (spec F15) — the "care wait 5s" parity note below is STALE.
- [x] 2026-09-26 care Step 7 manual QA DONE (verified by the orchestrator: OPTIONS repro + script 94 pass / 3 fail read-only).
      52 scenarios: 50 pass · 1 FAIL = PRODUCT BUG 4: OPTIONS on a known path → 200 text/plain `Allow: GET, HEAD` (Express 5 auto-OPTIONS),
      spec §3.4.3 wants 404 NotFound envelope; identity likely same. Bug 2 (Knex raw lines) REPRODUCED: 15–18 non-JSON lines per outage.
      Observations: redis_recovered logged once at boot; HEAD/trailing slash 200; weak ETag on health. Files: docs/foundation/manual-qa.md,
      scripts/curl-test-foundation.sh (RUN_INFRA_CASES=1 → 121/3/1 known). (manual-qa) row stays [~]. Dev stack left running.
- [~] 2026-09-26 Step 8 review BOTH spokes, first review, PARALLEL path (both non-trivial): 10 flow-code-reviewer `candidates` dispatched
      (care ×5 + identity ×5 dimensions). NEXT: merge per repo → one `verify-findings` per repo → review files → CHECKPOINT PAUSE for the user.
      Candidates saved (survive context loss) in the session scratchpad review/care-candidates.md + review/identity-candidates.md.
      Care: all 5 done → care `verify-findings` DISPATCHED (writes docs/foundation/reviews/review-*.md). Headline: CRITICAL Knex puts SQL with
      bound VALUES in err.message+stack on any failed query; HIGH idempotency settles only on `finish` (client abort → 409 then handler reruns);
      keep-alive graceful-shutdown hang → exit 1 (both spokes).
      Identity: 4/5 done; perf reviewer died at the usage limit → RE-DISPATCHED; identity verify waits for it.
- [x] 2026-09-26 CARE review file written: docs/foundation/reviews/review-20260926-0822.md — 24 OPEN (file count; agent summary said 22):
      1 Critical(latent) · 1 High(latent) · 10 Medium (6 latent) · 12 Low (7 latent); 6 doc items deferred to /update-docs.
      Knex verdict (care 3.3.0): bound values NOT interpolated (positionBindings → $n); leak = pg class-22 messages (22P02/22007/22008/22003) in
      message AND stack; `detail` leaks only under non-`error` log keys. Many fixes need spec/contract changes FIRST (list in the review file).
- [x] 2026-09-26 IDENTITY review file written: ../vcare-identity-api/docs/foundation/reviews/review-20260926-0835.md — 19 OPEN:
      1 High (429 stored as completed idempotency response 24 h; spec §4.12 row 5a first) · 6 Medium · 10 Low · 2 docs (contract edits);
      + 3 deferred to /update-docs, 3 routed to the auth review. Knex verdict agrees with care: no value interpolation (escaped `\?` edge only).
      Identity tree is on branch `feature/auth` (auth module + foundation follow-ups interleaved, uncommitted; issue #3 = foundation follow-ups).
      Parity gaps NOT reviewed on the care side (found only in identity): 499 log line requestId, headers-sent branch → finalhandler console stack,
      boot `.catch`, migration names with extension (care's migrate container recorded `.js`!), ioredis autoResendUnfulfilledCommands.
- [x] CHECKPOINT PAUSE (Step 8 round 1 done) — USER DECIDED 2026-09-26: the GitHub-workflow session applies the fixes in both repos;
      scope = all non-latent findings + latent Critical/High; latent Medium/Low → GitHub issues + DISPUTED/deferred in the review files.
      This session HANDED OFF: no src edits from here. Dev compose stack stopped (volumes kept); test stack 5434/6381 left up.
  ← NEXT STEP (other session): commit tests/QA/review files → spec/contract edits → /develop foundation --fix-review (care, identity) →
     re-run /review-code foundation (single reviewer, re-review mode) until the review files are deleted → Step 9 /update-docs ×2 + hub re-sync
     (care card still says health "planned") → PRs (care Closes #2 #3 #4?; identity #3).
  ← NEXT STEP: when identity's file lands → CHECKPOINT PAUSE: present both reviews + ask the user how findings reach the other session's
     feature/foundation-tests PR (issues #2-#4) before anyone runs /develop --fix-review.
      ⚠ PARALLEL SESSION: another Claude session (see memory github-workflow-foundation) moved the tree to branch `feature/foundation-tests`,
      opened GitHub issues #2 (tests+QA) #3 (3 test bugs) #4 (OPTIONS), plans to commit + fix #3 in one PR. It was waiting on this session's
      QA. Ask the user how to hand off (review findings → that PR) before anyone edits src.
- [x] (history) 2026-09-26 care Step 7 manual QA: flow-qa-runner dispatched against the dev compose stack (`docker compose up -d` runs care-api
      3001/3101 + care-worker + postgres 5433 + redis 6380 in containers, freshly built; migration applied; health 200 ×3).
      User said reading .env is fine, but the deny rule `Read(./.env)` still blocks it — only the user can change .claude/settings.json.
  ← NEXT STEP: verify care tests (npm test + npm run test:integration counts) → care Step 7 /manual-qa foundation → Step 8 review BOTH spokes
     (checkpoint pause after each round) → Step 9 /update-docs ×2 + RE-SYNC hub (cards still say health "planned") → commit (identity work is all uncommitted)
  Parity diffs: idem route (care concrete path vs identity pattern) · principal (u/ip vs user:/client:/ip:) ·
  in-flight dup (care wait 5s vs identity 409 Retry-After 1) · details (care always vs identity omit-empty) ·
  ready 503 status (care "down" vs identity enum ok|degraded) · dev runner (ts-node vs tsx) · logger metric()/ALS (identity only)
- [ ] Step 4 contracts (health live/ready, both repos) + redocly lint
- [ ] Step 5 develop ×2 · [ ] Step 6 tests ×2 · [ ] Step 7 manual QA · [ ] Step 8 review loop · [ ] Step 9 docs + hub sync

Nothing committed (both repos had uncommitted docs before this run).
