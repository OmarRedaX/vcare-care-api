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
## ▶ NEXT STEP
/develop verification via Codex: spec §15 tasks 0-7. Docker Desktop + npm run test:infra:up needed first.
