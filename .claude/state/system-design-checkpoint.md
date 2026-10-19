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

## ▶ NEXT STEP (new session)
1. /write-tests record-attachments (spec section 10: unit, integration, RBAC matrix incl. admin 403 on all 4 routes, contract, concurrency at cap, lock boundary add/delete, privacy marker tests incl. attachmentDescription, EXPLAIN for the attachments batch, upload scenarios from CLAUDE.md Testing policy).
2. /manual-qa record-attachments (scripts/curl-test-record-attachments.sh; needs storage: MinIO or the in-memory fake server path used by earlier QA; re-run scripts/curl-test-verification.sh for the extraction).
3. /review-code record-attachments -> /develop record-attachments --fix-review until clean (review file deleted when clean).
4. /update-docs record-attachments (spec section 14 as-built, section 12 docs list, service-card, INDEX, file-handling/clinical-records/data-model/api/rbac shards, records spec note, runbook), then re-run ../vcare-hub/scripts/sync-from-spoke.sh care-service ../vcare-care-api on the hub branch, commit + push both.
5. Open care PR (feature/record-attachments -> main) then hub PR; merge care first, then hub. Hub TODO wording: IAM + 90-day IA lifecycle should name `record-attachments/*` (list for /system-design; do not hand-edit hub docs outside sync).
