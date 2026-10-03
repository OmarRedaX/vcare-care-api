# /brainstorm access (then specialties) — checkpoint (care)

Started 2026-10-02. Branch `feature/access` (renamed from feature/specialties) (from main @ 99efa12, PR #18 merged). No GitHub issue yet — create one
once the brief fixes scope (user workflow: issue → branch → PR).

## Context found
- Contract already defines listSpecialties (GET, all roles, `includeInactive` admin-only, cursor, sorted by name),
  createSpecialty (POST, admin, optional Idempotency-Key, audit `specialty.created`, 409 Conflict),
  updateSpecialty (PATCH /{id}, admin, audit `specialty.updated`, 404/409). Schemas Specialty/SpecialtyCreate/SpecialtyUpdate.
- data-model.md: `specialties` table (no soft delete — deactivate via is_active; uq slug, uq name, chk slug format).
- FIRST business module → nothing of lib/auth, lib/rbac, lib/audit exists. `jose` needs no new ADR (ADR 0016).
  audit_logs is month-partitioned from the first migration (ADR 0009) + worker pre-creates partitions.
- Foundation latent issues due with the first module: #5 (:param URIError), #6 (route prefix), #7 (cursor µs),
  #8 (implicit bool conversion — includeInactive!), #9 (rate-limit member), #10 (Redis breaker), #11 (idem record crash),
  #15 (router-level limiter label) if applicable.
- Identity has lib/auth (jwks.ts, user-guard.ts) and lib/rbac (authorize.ts, assert-routes-authorized.ts) to mirror for parity.

## Decisions
- Q1 2026-10-02: SEPARATE `access` unit first (lib/auth, lib/rbac, lib/audit + audit_logs + worker partition loop, foundation #5 #6 #10 #11), no business routes. specialties follows as a thin module (+ #7 #8 #9).
- Q2: Owner + app role — migrations as owner `care`; migration creates NOLOGIN `vcare_app` + grants; API/worker log in as `care_app` (MIGRATION_DATABASE_URL vs DATABASE_URL). Hub deployment secrets list = platform delta (open question).

- Q3: worker `audit-partitions` loop NOW (worker gets Postgres wiring).
- Q4: user guard only; service guard lands with doctors.
- Q5: readiness gets informational `checks.identityJwks: up|down` (contract change, never fails readiness).
- Q6: manual QA uses REAL local Identity (feature/auth), not a fake script; edge tokens via integration fake JWKS.
- WROTE docs/access/brainstorm.md + INDEX row (2026-10-02).
- Open questions resolved by user 2026-10-02: hub deployment one-liner (owner cred = migrations, app cred = API/worker) → queued for /system-design;
  explicit grants per table migration; suspended_at check inside authorize policy + booking checks target doctor; JWKS max age 1 h / clockTolerance 30 s / fetch timeout 2 s;
  dev DB migrated in place, test DBs reset. Brief updated.
- JWKS: 5-min refresh cadence (Identity max-age=300, emergency rotation ≤5 min) + 1 h stale-if-error cap — recorded in brief.
- GitHub issues: #19 access, #20 specialties (2026-10-02).
- Hub branch `docs/care-access-deltas` (from origin/main, UNCOMMITTED): deployment.md release step 3 owner vs app credential;
  landscape.md JWKS 5-min refresh + 1 h stale cap. check-freshness OK.
- Identity feature/auth (UNCOMMITTED, alongside the old CLAUDE.md edit): docs/architecture/deployment.md JWKS row (> 1 h, not > 5 min).
- /construct-spec access: 2 Explore recon agents running (foundation spec digest; identity auth parity digest). Then dispatch flow-spec-author.
- Recon DONE (both digests; notes in session scratchpad access-recon/). flow-spec-author DISPATCHED for docs/access/spec.md
  with both digests + 5 conflicts (readiness parity, role split/login provisioning, explicit grants + write-migration skill, worker PG + partition loop, boot-assert exemptions).
- Identity (UNCOMMITTED on feature/auth): docs/auth/spec.md §5 keys.ts drift fixed (createPrivateKey/createPublicKey + toCryptoKey, not importJWK).
- Spec v0.1.0 draft written. User answers: Q1 defer audit_logs read indexes to `audit` module; P1 care-migrate runs latest + ensure-app-login (owner needs CREATEROLE);
  CLAUDE.md updated NOW (Authentication JWKS wording + "Two database roles" bullet) — care CLAUDE.md UNCOMMITTED on feature/access.
  Hub (docs/care-access-deltas, uncommitted): + deployment ensure-app-login/CREATEROLE, + data-ownership JWKS row. check-freshness OK.
  NOTE: care AGENTS.md (untracked, belongs to PR #1 chore/codex-setup) still has the old JWKS wording — mirror when PR #1 is updated.
- Spec author RESUMED to fold answers → status ready v1.0.0. Contract C1 (identityJwks) + C2 (bearerUser JWKS wording) applied in /develop step 0.
- SPEC READY: docs/access/spec.md v1.0.0 (1129 lines; §11 none, §12 foundation fixes, §13 follow-ups, §14 decisions/C1/C2/applied platform changes).

## /develop access (started 2026-10-02, new session)
- Preconditions OK: spec ready v1.0.0; contract changes C1/C2 are care-only. Docker Desktop was NOT running at start.
- flow-developer DISPATCHED (default mode): step 0 contract C1/C2 + hub sync, then tasks.md, then code; it appends progress here.
- DONE (orchestrator): hub deployment.md §6 'Cross-service alerts' table with IdentityJwksStale (uncommitted on docs/care-access-deltas; check-freshness OK).
- Orchestrator (me) owns: hub deployment.md → Observability `IdentityJwksStale` alert (branch docs/care-access-deltas), final verification.
- dev: step 0 DONE (contract C1/C2 applied; hub sync ran — catalog card + contract copy refreshed). docs/access/tasks.md written.
- dev: DONE tooling (jose 6.2.12, undici 7.30.0, eslint), env, errors/redact/id, 3 migrations (NOT run: Docker down), app-login + migrate.ts, fixes #5 #6 #10 #11. Unit tests green.
- dev: DONE lib/auth (jwks cache/fetcher/dto/verifier/guard), lib/rbac, lib/audit (+partition loop), worker (--once, own pool), DI, health identityJwks, boot route assertion. npm test now runs jest via node --experimental-vm-modules (jose is ESM; identity parity). typecheck/lint/unit green (34 suites/448).
- dev: DONE QA server + test routers, integration infra (global-setup owner+ensureAppLogin, db.ts ownerDb), ADR 0018, skills (write-migration, rbac-ownership-guard; identity copies now differ - report). Smoke-checked guard/authorize/JWKS/#5/#6 with tsx (no DB).
- dev: /develop access DONE (all build + docs tasks [x]; tests/manual-qa left). typecheck/lint/build clean, unit 34 suites/448 pass. Docs: rbac, overview, infrastructure, resilience, data-model, deployment, api, integration, runbook, quickstart, foundation spec, service card (+hub re-sync OK), INDEX. Docker down: migrations + integration NOT run.

- /develop access VERIFIED by orchestrator 2026-10-02: typecheck clean, lint clean, unit 34 suites / 448 tests pass; tasks.md 27 [x], open = (tests), (manual-qa). Integration + migrations NOT run (Docker down). Dev .env needs the new vars (see .env.example) before any local run. Hub IdentityJwksStale alert DONE.
- Pending user decision: mirror write-migration + rbac-ownership-guard SKILL.md changes into ../vcare-identity-api (feature/auth)?

- 2026-10-02 LOCAL DEV SWITCHED to native Postgres 18 on 5432 (user postgres) + native Redis 6379 DB 1 (Identity uses DB 0); new DB `vcare_care` created; .env rewritten (old backed up in session scratchpad); IDENTITY_JWKS_URL → localhost:3020. `npm run migrate` + `ensure-app-login` OK (4 migrations, care_app created); app booted: ready {database up, redis up, identityJwks down (Identity not running)}; care_app on audit_logs INSERT yes / UPDATE,DELETE no; partitions default + 2026m10..m12. Docker test stack (5434/6381) still not run.

- 2026-10-02 Docker up. Test stack reset; integration: 11 suites, 85 pass, 2 skipped (POSIX-signal tests, win32 only), 0 fail — after fixing one fixture in tests/integration/process.test.ts (invalid DATABASE_URL used role `care`, same as the owner URL → role-collision check also fired; fixture now `care_app`).

- 2026-10-02 COMMITTED+PUSHED care feature/access 6f77cb9 (develop + docs; AGENTS.md/.codex excluded). Identity feature/auth 27a1ea0: the 2 skills synced from care (only those files; CLAUDE.md, deployment.md, auth/spec.md edits still uncommitted there). Hub docs/care-access-deltas still UNCOMMITTED (deployment/landscape/data-ownership + IdentityJwksStale + synced card/contract).

## /write-tests access (started 2026-10-02)
- Baseline before: unit 34 suites / 448; integration 11 suites / 85 pass / 2 skipped. Test stack Docker 5434/6381 (never touch native dev 5432 / Redis 6379).
- flow-test-author DISPATCHED (spec §9 + §12 regressions + lint cases + JWKS cache + audit grants + partitions + ensure-app-login + log hygiene). It appends "- test: ..." progress lines below.

- test: helpers tests/helpers/{tokens,fake-jwks,fake-logger}.ts (+ types, fake-http-server rawBody/contentType); unit lib/auth/jwks-cache.test.ts (22) + jwks-fetcher.test.ts (13) green. PRODUCT BUG FIXED src/lib/auth/jwks-fetcher.ts discard(): body.destroy() without error listener → uncaughtException on any non-200/non-JSON JWKS response (process crash); added a no-op error listener.

- test: unit user-token-verifier (39), user-guard (14), rbac authorize/assert-routes-authorized/roles (54), audit audit/partition-loop (45), knex/app-login + pkg/utils/id + redis/breaker regression #10 (44) — all green.

- test: UNIT PHASE DONE — extended env (access vars), health.service (identityJwks A7), errorHandler (regression #5), route-pattern (regression #6), idempotency + rate-limit (regression #11), restricted-imports (jose/undici/fetch). typecheck + lint clean; npm test 46 suites / 724 pass.

- test: integration auth.test.ts (14) + rbac.test.ts (22) green (fake JWKS + injected cache clock).

- test: integration boot.test.ts (7, jest.mock of src/routes + src/internal-routes), audit.test.ts (18, grants 42501, DB checks, txn visibility), db-roles.test.ts (11, SECURITY DEFINER fn, ensureAppLogin + CLI + role collision) green. test-routers buildAuditTestRouter gained {invalid:true}.

- test: integration worker-partitions.test.ts (9, incl. --once child process, runs on win32) + redis-stall.test.ts (1, regression #10 via black-hole proxy) green.

- 2026-10-03 RESUMED (new session): working tree already has the 5 remaining integration extensions (migrations, health, logs, envelope, idempotency) — not yet run. Unit flake fixed: jwks-fetcher.test.ts cold first request exceeded the 150 ms test budget under parallel load → budget 400 ms + warm-up fetch in beforeAll. typecheck + lint clean; unit 46 suites / 724 pass. Docker Desktop NOT running → integration not yet run.

- 2026-10-03 Docker started; test stack up. INTEGRATION GREEN: 18 suites, 180 pass, 2 skipped (win32 SIGTERM). The 5 extended suites cover migrations (partitions, rollback round-trip, guarded DROP ROLE), health C1/A7, logs #6 + token hygiene, envelope #5, idempotency #11. README counts updated; tasks.md (tests) flipped [x]. /write-tests access DONE (uncommitted).

- 2026-10-03 COMMITTED 1b5d546 fix(auth) jwks-fetcher discard crash + efc1d83 test(access); PUSHED by the user (github.com edge 20.233.83.145 unreachable from this network — use git -c http.curloptResolve=github.com:443:140.82.121.4 if push times out again).

## /manual-qa access (started 2026-10-03)
- Identity started by orchestrator: `PORT=3020 INTERNAL_PORT=3120 npx tsx --env-file-if-exists=.env src/server.ts` in ../vcare-identity-api (its .env still says 3000/3100).
- HARNESS FIX (uncommitted): scripts/access-qa-server.ts never called redis.connect() (client is lazyConnect) → ready showed redis down forever; now connects in the background like server.ts. typecheck + lint clean.
- Care QA server on :3001 → ready {database up, redis up, identityJwks up}. NOTE: on Windows TaskStop leaves the tsx node child alive — kill the PID holding the port (netstat -ano | grep :3001).
- flow-qa-runner DISPATCHED.
- qa: harness scripts/access-qa-server.ts now also mounts audit/params/nested/idempotency/rate-limit test routers (dev-only; typecheck+lint clean). New scripts/access-qa-fake-identity.ts (fake JWKS + edge-token mint on 127.0.0.1:3021) and scripts/curl-test-access.sh.
- qa: QA server 3001 restarted by qa-runner with log capture (scratchpad); edge harness 3011 → fake 3021. Identity QA accounts created through the real register flow (worker run temporarily, then stopped): patient id 1, doctor id 2, admin id 3 (promoted in Identity DB); variants via Identity DB UPDATE before login.
- qa: run 1 → 139 pass / 4 fail; all 4 were script expectation errors (#11 store-on-2nd-request per spec §12.4; rate-limit 1 s window stretched by node spawns) — script fixed, re-run pending.
- qa: #10 stall verified by hand (scratchpad black-hole proxy → third harness :3012 on Redis DB 1): breaker opens after 2 slow requests (2 failed cmds each), then ~1 ms server-side, rate limiter degraded, readiness degraded; replay resumes + redis_breaker_closed after a fresh connection. Observation: byte-dropping stall desyncs ioredis until reconnect (integration test also forces disconnect).
- qa: JWKS outage O1–O12 all per spec (identityJwks down but readiness 200 ok; cached keys verify; care restart while Identity down → 401 until the 60 s gate, then no_keys fetch → 200 + up). Identity restarted by qa-runner (PORT=3020 INTERNAL_PORT=3120, log in session scratchpad); care :3001 restarted by qa-runner (log in session scratchpad).
- qa: final scripted run 143/143; total 167 pass / 0 fail. docs/access/manual-qa.md written, tasks.md (manual-qa) [x], INDEX row added. Not committed.
- /manual-qa access VERIFIED by orchestrator 2026-10-03: 167 pass / 0 fail; typecheck + lint + bash -n clean; no secrets in outputs. UNCOMMITTED: scripts/access-qa-server.ts, scripts/access-qa-fake-identity.ts, scripts/curl-test-access.sh, docs/access/manual-qa.md, docs/access/tasks.md, docs/INDEX.md. Left running: Identity 3020/3120, care QA server 3001.
- Observations for /review-code: (1) ioredis does not reconnect after a byte-dropping stall (likely proxy artefact); (2) malformed :param without token → 400 not 401 (Express decodes before userGuard); (3) unhandled_error log line lacks `route`.

- 2026-10-03 COMMITTED fc4da16 test(access) QA harness + curl script, 5af702c docs(access) manual QA results; PUSHED origin/feature/access (created the remote branch).

## /review-code access (started 2026-10-03)
- First review (no docs/access/reviews/), non-trivial (129 files, ~10k lines) → parallel path. Dimensions per user: correctness · security-auth · conventions-layering (+contract drift C1/C2) · database-migrations (+perf/indexing) · tests. Domain-rules N/A (no business routes; suspended/ev gates folded into security).
- Scope file list: session scratchpad access-review-files.txt (git diff --name-only main...feature/access -- src scripts tests).
- 5 flow-code-reviewer (mode candidates) DISPATCHED. QA observations routed: (1) redis reconnect → correctness, (2) :param 400 vs 401 → security-auth, (3) unhandled_error no route → conventions.
- CANDIDATES DONE (all 5): correctness M3 L1 · security H1 M2 L1 · conventions L5 docs2 · database H1 M2 L2 · tests M3 L3 = 26 raw. Saved in session scratchpad access-review/candidates-*.md. Merges: boot-assertion holes (security H + correctness route() method merge) → one; ensure-app-login takeover (security L + database M) → one. QA obs: (1) correctness says REAL (no socketTimeout); (2) security DISMISSED (Express decodes in Layer.match, spec §12.1/A17); (3) conventions CONFIRMED Low.
- Then: merge candidates → 1 verify-findings reviewer writes docs/access/reviews/review-<YYYYMMDD-HHMM>.md. No code changes. Ask user before committing.

- VERIFIED (verify-findings reviewer): docs/access/reviews/review-20261003-1600.md — 14 OPEN: Critical 0 · High 1 · Medium 2 · Low 9 · Docs 2; 11 refuted.
  High: boot route assertion 4 holes (handler before authorize, terminal router.use(fn), mounted sub-app, router.route() method merge) — src/lib/rbac/assert-routes-authorized.ts.
  Medium: ensure-app-login password in migration_failed log on mid-DDL connection drop; Redis no socketTimeout (QA obs 1 confirmed).
  QA obs: (1) confirmed Medium, (2) dismissed, (3) confirmed Low.
- CARRY TO doctors review (refuted here only because spec defers them): boot assertion is guard-kind blind (user-guard route on internal listener would boot → must fail once serviceGuard lands); doctor suspended_at check is opt-in per policy (make it fail closed for doctor-role policies).
- 2026-10-03 COMMITTED 6e80c4e docs(access): code review findings; PUSHED origin/feature/access.

## /develop access --fix-review (started 2026-10-03)
- Docker test stack up (5434/6381). flow-developer DISPATCHED (fix-review mode, all 14 findings, severity order). It appends "- fix: ..." progress lines below.
- fix: started; Fix-review section (14 tasks) added to docs/access/tasks.md. Order: H1 → M1 → M2 → L1..L9 → D1 D2.
- fix: H1 RESOLVED — boot assertion: per-method chains, handler_before_authorize, middleware_without_policy (markPreAuth marker on global/pre-auth middleware), sub-app walk; unit + boot tests green. Docs (spec/rbac/skill) pending in D-pass.
- fix: M1 RESOLVED (app_login_ddl_failed, SQLSTATE only; unit tests via real Logger) + L1 RESOLVED (refuse privileged/owning existing role: app_login_role_privileged; db-roles integration CREATEDB test). unit knex 46 pass, db-roles 12 pass.
- fix: M2 RESOLVED — REDIS_SOCKET_TIMEOUT_MS 2000 in createRedis (no disconnect on breaker open, justified); stall test self-recovers (fails without the fix); unit redis option test.
- fix: L2+L3 RESOLVED — migrations 20261003120000_audit_logs_column_insert_grants + 20261003120100_audit_logs_partitions_attach (both with downs); db-roles/worker-partitions/migrations tests updated+added (L3 test fails at 2058 ms on old fn). NOTE dev DB 5432 needs npm run migrate by the user.
- fix: L4 RESOLVED — TickOutcome done|incomplete; --once exits 1 + worker_once_incomplete (default-row + lock-held child-process tests); runbook updated (also ensure-app-login failures, redis socket timeout, new boot errors).
- fix: L5 RESOLVED — validateBody unknownMembers:"strip" option; JWKS strips extras, rejects d; tests added (spec line pending in docs pass).
- fix: L6+L7 RESOLVED — lib/http/once-next.ts used by idempotency+rate-limit; isRedactedKey in redact used by audit; route+status on unhandled_error/error_after_headers_sent; tests unit+logs integration green.
- fix: L8 RESOLVED — interval tick alone, trickle body timeout, boot refresh (process.test cross-platform + SIGTERM ordering); each verified to fail without the product behaviour; fixed latent seenHeaders race in jwks-fetcher X-Request-Id test.
- fix: L9 RESOLVED — tests/helpers/test-database.ts guard in global-setup + ownerDb/truncateAll; unit test. All code findings done; next: D1 contract bearerUser + hub sync, D2 INDEX/tasks notes, docs (spec, rbac shard, skill, ADR 0018 addendum), full verification.
- fix: D1+D2 RESOLVED — contract bearerUser claims + hub sync (freshness OK, hook OK); INDEX/tasks notes; docs updated: spec, rbac, data-model, infrastructure, resilience, runbook, ADR 0018 addendum, service card, skills rbac-ownership-guard + write-migration. Next: full verification.
- fix: VERIFIED (fix-review done, uncommitted): typecheck clean, lint clean, build clean; unit 48 suites / 760 pass; integration 18 suites / 189 pass / 2 skipped (two consecutive runs). Review file: 14 RESOLVED, 0 OPEN, 0 DISPUTED. Hub: catalog card + contract copy re-synced (uncommitted, branch docs/care-access-deltas), freshness OK. Dev DB 5432 needs npm run migrate (2 new migrations). Identity skill copies (rbac-ownership-guard, write-migration) now differ from care's — mirror decision for the user.

- VERIFIED by orchestrator 2026-10-03: typecheck + lint clean; unit 48 / 760 pass; integration 18 / 189 pass / 2 skipped (test stack 5434/6381); review 14 RESOLVED / 0 OPEN. Spot-checked boot assertion + attach migration. UNCOMMITTED (63 files + 6 new). Pending user: commit OK?; migrate dev DB 5432 + curl QA re-run?; mirror 2 skills into identity?

## ▶ NEXT STEP
Ask user: commit fix-review; dev DB migrate + curl-test-access.sh re-run (needs Identity 3020 + QA servers); identity skill mirror. Then /review-code access (re-review) → /update-docs access → PR "Closes #19 #5 #6 #10 #11".
