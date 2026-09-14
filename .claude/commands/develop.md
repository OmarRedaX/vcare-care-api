---
description: Implement a module from its spec by dispatching flow-developer — spec → tasks.md first, contract before code, then build task by task with live status. Pass --fix-review to address open code-review findings instead.
argument-hint: <module> [--fix-review]
allowed-tools: Agent, Task, Read, Grep, Glob, Bash
disable-model-invocation: true
model: inherit
---

## Phase 3 of the feature workflow — Develop

Target: **$ARGUMENTS**

1. **Parse** the module slug and whether `--fix-review` is present.
2. **Preconditions.**
   - Default mode: `docs/<module>/spec.md` exists and its frontmatter `status` is `ready`. Missing → tell the user to run `/construct-spec <module>`. `draft` → list its Open questions and stop.
   - If the spec lists *Contract changes required* that touch **the other service's** contract, stop: the provider side must land first (run the workflow in that repo, then `../vcare-hub/scripts/sync-from-spoke.sh`).
   - `--fix-review` mode: an open review file exists under `docs/<module>/reviews/` (with `- [ ] OPEN`). None → the module is already clean.
3. **Dispatch `flow-developer`** (`subagent_type: flow-developer`) with:
   - the slug and mode;
   - read `CLAUDE.md` (named sections), `docs/<module>/spec.md`, `contracts/openapi.yaml` first, and use the project skills that apply (`write-migration`, `rbac-ownership-guard`, `cross-service-integration`, and `timezone-slot-computation` where it exists);
   - default mode: write `docs/<module>/tasks.md` (frontmatter, tasks tagged with "Build order for a new module" steps) **before code**; change the contract first when shapes differ; flip `[ ] → [~] → [x]` and persist after each transition; run `npm run typecheck` and never mark `[x]` while it fails; update service card / INDEX / ADRs; bump `last_verified`;
   - `--fix-review` mode: fix each OPEN finding and flip to `RESOLVED` (or `DISPUTED` with a reason), add the missing regression tests, run typecheck; do not delete the review file.
4. Do not implement code yourself — the subagent owns the changes and the task file.
5. **Verify the claim** before reporting: re-read `docs/<module>/tasks.md` and run `npm run typecheck` yourself; report what you observed.

### Finish
Report tasks completed, files changed, contract changes, typecheck result (observed), and blockers. Next: `/write-tests <module>` (or after `--fix-review`, `/review-code <module>` to verify and close the review).
