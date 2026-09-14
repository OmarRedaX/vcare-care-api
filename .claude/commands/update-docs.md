---
description: Reconcile a module's docs and the contract with the as-built code by dispatching flow-docs-updater — spec as-built notes, tasks, system-design and architecture shards, INDEX rows, service card for the hub sync, frontmatter freshness, contract drift.
argument-hint: <module>
allowed-tools: Agent, Task, Read, Grep, Glob, Bash
disable-model-invocation: true
model: inherit
---

## Phase 7 of the feature workflow — Update docs

Target: **$ARGUMENTS**

1. **Preconditions.** `docs/<module>/` exists and the module code exists.
2. **Dispatch `flow-docs-updater`** (`subagent_type: flow-docs-updater`) with:
   - the slug;
   - read the code, migrations, and routes as the source of truth; reconcile `spec.md` (As-built notes, version bump), `tasks.md`, `docs/system-design.md` + the relevant `docs/architecture/*.md` shards, `docs/INDEX.md` rows and lenses, `docs/service-card.md`, and frontmatter (`last_verified` = today) per `CLAUDE.md` → "Documentation structure";
   - contract drift: intentional as-built changes update `contracts/openapi.yaml` and are flagged; anything that looks like a bug is reported, not edited away;
   - list any hub-level facts that changed (who-calls-whom, data ownership).
3. Do not edit docs yourself — the subagent owns them.
4. **If the service card or contract changed**, tell the user to run the hub sync from the hub repo:
   `cd ../vcare-hub && scripts/sync-from-spoke.sh <service-id> ../<this-repo>` — and, for changed ownership or integrations, `/system-design` to update `landscape.md` / `data-ownership.md`.

### Finish
Report docs changed and why, contract changes, contradictions for a human, and whether a hub sync or `/system-design` update is needed. This is the last phase — docs, tests, contract, and review status should now agree.
