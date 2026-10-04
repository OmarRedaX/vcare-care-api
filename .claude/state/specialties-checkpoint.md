# specialties module — checkpoint (care)

Started 2026-10-03. Issue #20. Branch `feature/specialties` from main @ 17a3edf (PR #23 access + hub PR #5 merged, verified via GitHub MCP).
No `gh` CLI on this machine: use the GitHub MCP tools (owner OmarRedaX; repos `vcare-care-api`, hub = `Vcare`).

## Operating rules (user, 2026-10-03)
- Model split: **Codex does implementation code only** (src/ + migrations + tests code via codex:codex-rescue); **Opus** for planning, spec, review, QA, docs (subagents with model: opus). Orchestrator verifies every claim (typecheck, lint, unit, integration, re-read review/tasks).
- Integration tests ONLY on Docker test stack 5434/6381. Never dev DB 5432 / Redis 6379.
- Ask before every commit / push / PR. Never commit untracked .codex/ and AGENTS.md.
- Keep care/hub/identity docs in sync in the same session; no parked deltas.
- Flake rule: jwks-fetcher.test.ts, graceful-shutdown.test.ts — rerun once if alone.
- Windows: kill the PID holding the port (netstat -ano), not TaskStop.
- Push fallback: git -c http.curloptResolve=github.com:443:140.82.121.4 push.

## Progress
- 2026-10-03 preconditions OK; branch created; Docker test stack up (5434/6381). Uncommitted carry-over: access-checkpoint.md edit (fold into first commit).

- 2026-10-03 /brainstorm DONE (inline): docs/specialties/brainstorm.md (status draft) + INDEX row. User decisions: D1 #7 full-precision cursor (not TIMESTAMPTZ(3)); D2 starter catalog via SEPARATE data migration; D3 keep data-model as is (case-sensitive UNIQUE(name), default collation sort). Defaults taken by me: no cache, no DELETE, no contract change expected. Spec-author open items: no-op PATCH, rate-limit numbers for GET, starter list.
- Read: #7/#8/#9 issue bodies (pagination cursor.ts + knex.ts + test-routers.ts; validate.ts; rate-limit.ts:116), access spec §15, rbac.md (specialties rows already present).
- spec: 2026-10-03 docs/specialties/spec.md v1.0.0 status ready + INDEX row. Decisions S1 no-op PATCH = 200 current row, no write/audit; S2 GET 60/min IP + 120/min user, no write limiter; S3 20 synthetic rows, ON CONFLICT DO NOTHING (no target); S4 GET /specialties admits doctor pending/active/rejected. Contract C1 (listSpecialties description only) to apply at /develop step 0 + hub sync. Lib first: #8 transforms/validate/eslint, #7 timestamp-cursor + decodeText/TimestampCursor, #9 randomUUID member, pg-errors, require-auth.

- 2026-10-04 /develop session: Docker test stack started (docker start vcare-care-test-*). Step 0 DONE: C1 applied in contracts/openapi.yaml; hub branch docs/care-specialties-deltas (from main bd3d276) synced (uncommitted in hub); docs/specialties/tasks.md written. Next: Codex task 0a (#8).

- 2026-10-04 Task 0a (#8) DONE + verified by me (typecheck, lint, unit 808/808, integration 192 pass/2 skipped). Codex sandbox cannot run docker or spawn child node (EPERM): I run integration + restricted-imports myself.

- 2026-10-04 Task 0b (#7) DONE + verified (unit 824, integration 195 pass/2 skip). write-migration skill rule DONE.

- 2026-10-04 Tasks 0c (#9) + 0d DONE + verified (unit 834, integration 196 pass/2 skip). All lib fixes complete.

- 2026-10-04 Migrations 1+2 written by Codex; I verified: tsx migrate rollback/latest on test DB OK, 20 rows, vcare_app SELECT/INSERT/UPDATE only. Side effect: tests/integration/migrations.test.ts step-down test assumed the access migration is the latest -> 1 failure (lock_timeout 2s vs 200ms). Fix dispatched to Codex (test-only). Migration tasks NOT yet ticked.

- 2026-10-04 migrations.test fix verified by me (unit 834, integration 196 pass/2 skip). Both migration tasks ticked. Note: integration suites TRUNCATE tables, so seeded rows are absent in tests (seed tested via importing migration, spec §9.3).

- 2026-10-04 Task A DONE: I read all 8 files vs spec (conform), typecheck+lint exit 0; ticked enums/entity/DTOs/repo tasks. Task B dispatched to Codex.

- 2026-10-04 Task B DONE: I read service/policies/controller/routes/DI diffs vs spec (conform); typecheck 0, lint 0, unit 834, integration 196 pass/2 skip. All /develop tasks ticked except tests (belongs to /write-tests), qa, docs.

## ▶ NEXT STEP (2026-10-04)
/develop specialties COMPLETE; final report given to user. STOP: do NOT run /write-tests, /manual-qa, /review-code, /update-docs unless the user asks. Nothing committed (care: many modified files + docs/specialties + new src/app/specialties + 2 migrations; hub branch docs/care-specialties-deltas has uncommitted card+contract sync). Ask user before any commit/push/PR. Never commit .codex/ or AGENTS.md. Next phase when asked: /write-tests specialties (spec §9; boot.test.ts header + 401 test, migrations seed tests, etc).

- 2026-10-04 later: /write-tests DONE (unit 916, integration 335 pass/2 skip) + /manual-qa DONE (199/0 on real Identity; docs/specialties/manual-qa.md, scripts/curl-test-specialties.sh). Care committed + pushed on feature/specialties (a9041b5 + test commit). Hub re-synced identity card/contract, committed + pushed on docs/care-specialties-deltas. Local stack still UP: care :3001, identity :3020/:3120 + worker, native PG :5432, Redis :6379, test stack 5434/6381.

## ▶ NEXT STEP (supersedes the earlier one)
/review-code specialties -> (/develop specialties --fix-review if findings) -> /update-docs specialties -> open PRs (care: feature/specialties -> main, Closes #20 and #7 #8 #9; hub: docs/care-specialties-deltas -> main). Ask before any commit/push/PR. Never commit .codex/ or AGENTS.md. No PRs open yet.

- 2026-10-04 /review-code (5 dimension reviewers + verifier) -> 3 Medium/2 Low/3 docs; fix-review done (code-point length + control-char validators, cursor 1024, contract x-account-state, tests); /update-docs done; hub re-synced (card, contract, service-catalog row); re-review clean, review file deleted. Unit 937, integration 347 pass/2 skip. UNCOMMITTED: care working tree (src/lib/validation, cursor, DTOs, tests, contract, docs, checkpoint) + hub (card, contract, service-catalog).

## ▶ NEXT STEP (supersedes earlier)
Ask user, then commit care (feature/specialties) + hub (docs/care-specialties-deltas), push, open PRs: care -> main (Closes #20, #7, #8, #9) and hub -> main. Never commit .codex/ or AGENTS.md. Manual QA predates fix-review (optionally re-run scripts/curl-test-specialties.sh). Hub identity row in service-catalog still says "design — no code yet" (unchecked).
