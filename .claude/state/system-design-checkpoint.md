# Resume checkpoint — record-attachments (updated 2026-10-19)

Branch `feature/record-attachments` (care). Hub sync branch `chore/sync-care-record-attachments` (hub, pushed, contract synced for C1-C6).
care PR #44 (records) and hub PR #24 are merged. No PR is open yet for this branch.

## Done
- Brainstorm (approved), spec v0.1.0 ready: docs/record-attachments/{brainstorm,spec,tasks}.md. Decisions RA-D1..RA-D10, SD1..SD11.
- Slice 1 (commit 389de6f): `upload-intents` extraction, ADR 0022, golden statement test; verification behaviour unchanged.
- Slice 2 (steps 0-7, committed after 389de6f): contract C1-C6 + CLAUDE.md lines (AttachmentLimitReached row, Clinical cap sentence), migrations
  20261018120000_create_record_attachments + 20261018120100_comment_upload_intents_description, module src/app/record-attachments/, records plug-ins.
- Hub: contract + card re-synced (hub commit c376728 on chore/sync-care-record-attachments).

## Gates observed by the orchestrator (slice 2)
typecheck clean; eslint clean (agent); unit 158 suites / 3069 tests pass; integration full run: 46/49 suites, 1563 pass / 8 fail / 2 skipped.
Failures: 7 known env (db-roles 4 password cases, storage-adapter 3 MinIO) + 1 migrations.test.ts timeout under full load (passes alone, 41/41; same load-flake family as before; sessions.test.ts also flaked once in the agent's run).
NOT run: scripts/curl-test-verification.sh (needs MinIO + Identity shim) -> must run before merge.

## Env for integration (Docker unavailable)
MIGRATION_DATABASE_URL=postgres://care:care@127.0.0.1:5499/care_test DATABASE_URL=postgres://care_app:care_app@127.0.0.1:5499/care_test REDIS_URL=redis://127.0.0.1:6379/14
PG 18 data dir: C:/Users/power tech/AppData/Local/Temp/care-pg/data (trust auth; restart with pg_ctl if down). `npm test`, `npm run test:integration` (never bare npx jest; never :5432).
Gotcha: tests/integration/records-schema.test.ts and migrations.test.ts drop/recreate tables; if the shared test DB is left broken re-run the missing migrations' `up`.
New integration suites that rebind STORAGE must also re-register RecordAttachmentsService (as verification/admin-doctors tests do for UploadIntentsService).
Never use git worktree with a node_modules junction (it deleted real node_modules once; fixed with npm ci).

## Progress (2026-10-19, session 2)
- Phase 1 /write-tests DONE: commit 8199aa8 (unit 167 suites/3296; integration 53/55 suites, 1736 pass, only the known 7 env failures).
- Phase 2 /manual-qa DONE: commit 2c0f339 (record-attachments 331/0, verification script re-run 274/0 against scripts/storage-qa-fake-s3.mjs stand-in, NOT real MinIO/S3).
  Real MinIO/S3 + tests/integration/storage-adapter.test.ts still unrun -> must be reported before merge.
- Env restart: pg_ctl -D "C:/Users/power tech/AppData/Local/Temp/care-pg/data" -o "-p 5499" start (run in background; it holds stdout).

## Progress (2026-10-20, session 3)
- /review-code ran (review-20261019-1104.md, no Critical/High) and /develop --fix-review fixed K3, K8, K9, K10 (all RESOLVED, UNCOMMITTED in working tree; gates in tasks.md "Verification record (review fixes)": typecheck/eslint clean, unit 3304 pass, integration only known failures + 1 clock-flaky consultations.test.ts).
- Hub contract + card re-synced on chore/sync-care-record-attachments (uncommitted); re-sync again after /update-docs.

## ▶ NEXT STEP
3. Commit the review fixes, then re-run /review-code record-attachments to verify each fix (review file deleted when clean; /develop --fix-review again only if it finds more).
4. /update-docs record-attachments (spec 14 as-built, 12 docs list, service-card, INDEX, shards, runbook; note findLive plans on idx_record_attachments_medical_record_id not PK), then hub: cd ../vcare-hub && git checkout chore/sync-care-record-attachments && scripts/sync-from-spoke.sh care-service ../vcare-care-api, commit+push both.
5. STOP and report. Do not open/merge PRs without asking (care first, then hub).
