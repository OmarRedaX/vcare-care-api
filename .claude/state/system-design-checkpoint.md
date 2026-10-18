# Resume checkpoint — record-attachments (updated 2026-10-18)

Branch `feature/record-attachments`, cut from updated `main` (care PR #44 `records` is merged; hub PR #24 state not checked).
Phase: `/brainstorm record-attachments` DONE (brief written, committed, pushed). Waiting for the owner's approval.

## Decisions (docs/record-attachments/brainstorm.md, table "Decisions")
- RA-D1 extract shared `upload-intents` module from verification (behaviour-preserving refactor first, ADR 0022) · RA-D2 author-or-404 on all
  attachment writes, no `NotAssignedDoctor` · RA-D3 post-lock add allowed, audited `afterLock` · RA-D4 soft delete keeps the object ·
  RA-D5 cap 20 live attachments, `409 AttachmentLimitReached` · RA-D6..RA-D10 defaults awaiting owner confirmation.

## ▶ NEXT STEP
Owner reviews/approves docs/record-attachments/brainstorm.md (confirm RA-D6..D10 and open questions 1-6), then run
`/construct-spec record-attachments` (agent `flow-spec-author`). Do NOT start code before the spec. Order after spec:
contract edits C1-C6 -> upload-intents extraction (verification suites green) -> migration -> module -> tests -> manual QA -> docs.
Env notes: integration tests on isolated native PG 18 :5499 + Redis/Memurai :6379 db 14; `npm test` / `npm run test:integration`.
