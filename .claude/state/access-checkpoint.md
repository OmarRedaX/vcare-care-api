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

## ▶ NEXT STEP
/write-tests access → /manual-qa access (real Identity on 3020/3120) → /review-code access → /update-docs access → PR "Closes #19 #5 #6 #10 #11". Ask before commits. Hub docs/care-access-deltas committed+pushed b8cf0f4 (own remote branch; open a hub PR when care PR opens).
