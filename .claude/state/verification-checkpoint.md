# verification checkpoint (resume here)
Issue care#27, branch feature/verification (from feature/doctors; care PR #26 and hub PR #9 still OPEN on 2026-10-07).
Rules: docs sync in care+hub+identity same session; hub changes on own branch off origin/main; delegate heavy phases to codex:codex-rescue, verify myself (typecheck, npm test, npm run test:integration; Docker Desktop + `npm run test:infra:up`). Never commit .codex/ or AGENTS.md.
## Decisions (2026-10-07, user)
D1 real identity_sync worker loop now · D2 MinIO for adapter+QA, in-memory fake storage for API tests · D3 cache invalidation deferred, hook points documented · D4 identity-client includes getUsersBatch + Redis cache (Case 2 admin queue).
Defaults: lock profile edits while submitted; add DELETE own document; no Identity contract gap.
## Progress
- brainstorm written: docs/verification/brainstorm.md (+INDEX row)
- brainstorm a25b779; spec committed (Codex wrote, I reviewed + fixed pins to 3.1147.0, hub-direct-edit wording, advisory-lock pool note)
- phase A (contract C1-C6, env, compose, 4 migrations) verified by me: typecheck, unit 1071, migrations up/down/up, grants, integration 434 (fixed doctors EXPLAIN test). BLOCKER: minio/minio + minio/mc images no longer pullable (Docker Hub denied, quay 401); SeaweedFS POST-policy spike inconclusive (403). Needs user decision.
- phase A committed; local S3 resolved: bitnamilegacy/minio digest-pinned (ADR 0020), spike passed.
- hub contract synced on branch docs/sync-care-verification-contract (worktree in scratchpad/hub-verification, hub PR #10 open). ../vcare-hub checkout is on identity branch docs/sync-identity-auth-race-fixes with someone else's uncommitted changes: DO NOT touch it. Re-sync again after /update-docs.
- phase B dispatched to 2 Codex agents (lib/storage, lib/identity-client) in parallel.
## ▶ NEXT STEP
/develop verification via Codex: spec §15 tasks 0-7. Docker Desktop + npm run test:infra:up needed first.

## STATE AT HANDOFF (2026-10-07, late)
Commits on feature/verification: a25b779 brainstorm · 08c86fc spec · 97020ff phase A (contract C1-C6, env, MinIO compose, 4 migrations, ADR 0020) · 9233ac6 libs (storage, identity-client) · 0763438 lib tests.
UNCOMMITTED (Codex module task, NOT yet verified by me): src/app/verification/**, src/lib/knex/session-advisory-lock.ts, edits to doctors module, bootstrap.ts, routes.ts, server.ts, errorHandler, logger redact, tokens, docs/service-card.md, tasks.md, doctors tests. Typecheck passed at last check. Codex background job may still be running or finished; check `git status` and whether files are still changing before verifying.
TODO in order: verify module (review diff vs spec, lint, unit, integration; vet every changed doctors test) -> commit -> worker phase (identity-sync + upload-intent-purge loops, worker.ts/worker-loops.ts wiring, close clients) -> /write-tests -> /manual-qa (real Identity + MinIO) -> /review-code -> /update-docs (care + hub + identity; re-sync hub card+contract; rename spec §14 wording done) -> push + care PR (Closes #27).
OPEN: ../vcare-hub checkout sits on identity branch docs/sync-identity-auth-race-fixes with someone else's uncommitted changes; stop hook reads it and keeps complaining. Hub PR #10 (branch docs/sync-care-verification-contract, worktree in scratchpad/hub-verification) holds the contract sync. Await user choice (merge #10 / sync into checkout / move other work). Pre-existing lint errors in scripts/doctors-qa-fake-identity.mjs (separate tiny fix).
Env gotchas: Git Bash needs MSYS_NO_PATHCONV=1 for docker -v/-dir paths; docker test stack: `npm run test:infra:up` (pg 5434, redis 6381, MinIO 9003); jest integration needs closeRedis()/client.close() in afterAll or it will not exit; Codex sandbox cannot run docker/child node, lead runs integration + lint-runner unit suite.

## UPDATE 2026-10-07 (night)
Module verified (typecheck, unit 1099, integration 22 suites green) and committed: 24fb03d (code, incl. S3Adapter presign test seam), c5ef1c7 (tests). Worker phase done: identity-sync + upload-intent-purge loops in src/app/verification/worker/, wired in worker-loops.ts/worker.ts (pool 4, closes identity+db), --once covered in worker-partitions test. NEXT: /write-tests (verification unit+integration+RBAC+contract+concurrency+worker behaviour) -> /manual-qa -> /review-code -> /update-docs -> hub sync -> ask user before push/PR. Orphaned final objects rely on bucket lifecycle (spec allows).
Flaky: integration globalSetup occasionally 'Timeout acquiring a connection' - just rerun.
