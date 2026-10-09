# admin-doctors - checkpoint (2026-10-09)

Worktree E:\Full Stack Projects\Vcare\VCare\vcare-care-api-admin-doctors, branch feature/admin-doctors from origin/main 654a390
(PR #30 schedules and #29 are already merged there; the brief said #30 was unmerged). node_modules is a junction to ../vcare-care-api.
Why a worktree: another process moved the shared vcare-care-api checkout to fix/ci-integration-minio and committed 7a034a9 mid-session. Not mine; left alone.
Nothing committed yet.

## Done
- Context read: Care CLAUDE.md, contract suspend/reinstate/audit-logs, ADR 0012, verification service + identity-sync loop, identity-client.
- /brainstorm: docs/admin-doctors/brainstorm.md. Owner decisions: suspend stays 503 (brief said 202; contract + CLAUDE.md win), retry reuses existing env, contract bodies and audit names, flag-only bookings.

## Findings
- identity-sync loop and VerificationService.processDueSyncJob only handle kind='verification'; attemptSync is private, so extraction is needed.
- No audit module exists (no GET /audit-logs, no read indexes); consultations table does not exist.

## NEXT STEP
/construct-spec admin-doctors (flow-spec-author), then audit (own brainstorm).
