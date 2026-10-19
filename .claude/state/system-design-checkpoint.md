# Resume checkpoint — record-attachments (updated 2026-10-18)

Branch `feature/record-attachments` (from updated `main`; care PR #44 and hub PR #24 are merged).
Phase: brainstorm APPROVED; `/construct-spec record-attachments` DONE -> docs/record-attachments/spec.md v0.1.0, status ready (committed + pushed).

## Key decisions (spec section 12 + brainstorm "Decisions")
RA-D1 extract `upload-intents` module first (spec section 2, ADR 0022 written in step E0) · RA-D2 author-or-404, no NotAssignedDoctor ·
RA-D3 post-lock add allowed (audit `afterLock`) · RA-D4 soft delete keeps object · RA-D5 cap 20, `AttachmentLimitReached` 409 ·
RA-D6 delete-lock trigger · RA-D7 attachments batch in record DTOs (get-one 3->4, timeline 4->5 statements) · RA-D8 no Idempotency-Key ·
RA-D9 limits 20/h, 20/min, 120/min · RA-D10 description clinical, scoped redact key `attachmentDescription`.
Spec-level decisions SD1..SD11 (spec section 12): two services (links vs commands), property named `attachmentDescription`, PATCH 200 also carries attachments, etc.

## Pending owner-level items (made at /develop step 0, not before)
- CLAUDE.md: `AttachmentLimitReached` row in "Error codes owned by Care" + one Clinical sentence in "Domain rules" (delegated by owner, with contract C5).
- Hub: after contract C1-C6 lands run `../vcare-hub/scripts/sync-from-spoke.sh care-service ../vcare-care-api` (card + contract). Hub TODO item "care-service file handling ... IaC" should also name `record-attachments/*` prefix (IAM + 90-day IA lifecycle) -> list for /system-design.

## Update 2026-10-19: owner said "go ahead" -> `/develop record-attachments` running in TWO dispatches.
Dispatch 1 (in progress): E0 ADR 0022 + E1 extraction only (agent flow-developer writes docs/record-attachments/tasks.md; does not commit).
After it returns: orchestrator re-runs typecheck + unit + verification integration, commits "refactor(upload-intents): ..." and pushes; then dispatch 2 = steps 0-9 (contract + CLAUDE.md edit, migrations, module, records plug-in). Then /write-tests, /manual-qa, /review-code, /update-docs.

## ▶ NEXT STEP (older note, superseded by the update above)
Owner says `/develop record-attachments` (agent `flow-developer`; spec section 13 task order: E0 ADR 0022 + extraction E1 with verification suites green FIRST, then contract step 0 + CLAUDE.md edit, migrations, module, tests, manual QA, docs).
Env: isolated native PG 18 :5499 (trust auth), Redis/Memurai :6379 db 14; `npm test` / `npm run test:integration`; never the shared :5432 cluster; MinIO or fake-storage for attachment tests.
