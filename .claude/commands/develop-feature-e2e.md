---
description: Run the full feature workflow end-to-end (brainstorm → spec → develop → tests → manual-qa → review/fix loop → docs), asking for a run mode first. Builds genuinely independent units concurrently in isolated git worktrees; cross-service work builds the provider contract before the consumer; serial on real dependencies.
argument-hint: <module-or-feature>
allowed-tools: Agent, Task, Read, Write, Edit, Grep, Glob, Bash, AskUserQuestion
disable-model-invocation: true
model: inherit
---

## Feature workflow — End to end

Target: **$ARGUMENTS**

You are the **orchestrator**. You run each phase by doing what the corresponding command does — dispatching the same subagents — and you own all fan-out (subagents cannot spawn subagents).

### Step 0 — Run mode (always ask first)
`AskUserQuestion`:
- **Checkpoint (recommended)** — pause after the spec(s) and after each review round before fixing.
- **Autonomous** — no pauses except hard blockers and scope-changing Open questions.
- **Per-phase** — pause after every phase.

### Step 1 — Brainstorm (inline)
If the feature is new or unclear, run the `/brainstorm` interaction and write `docs/<module>/brainstorm.md`. If it needs an unrecorded architecture decision, stop and recommend `/system-design <topic>` first.

### Step 2 — Decompose into units and a dependency graph
From the brief, list **units** (one module, or one independent slice of a module with its own tables/routes/tests). For each unit record: files/tables it owns, contract operations it adds, and **dependencies** (uses another unit's table, service, or endpoint; needs another service's endpoint).
Write the graph into `docs/<module>/tasks.md` under `## Units` (or one `tasks.md` per module).
- **Cross-service dependency** (this unit needs a new or changed endpoint in the other vcare service): the **provider** goes first — its contract change, implementation, tests, and hub sync must land (in the provider repo, via its own workflow) before the consumer unit is developed here. Mark the consumer unit `blocked-by: <provider repo>#<operation>`.
- **Parallel gate:** run units concurrently only if there are **≥ 2 units with no dependency path between them and no shared files** (shared migration ordering, shared `lib/` changes, the same route file, or the same contract operations count as shared). Otherwise run **serially** in topological order.

### Step 3 — Construct spec(s)
Dispatch `flow-spec-author` per module (parallel recon per `/construct-spec` when ≥ 2 large sources; independent modules' authors may be dispatched in one message). Ask any scope-affecting Open questions regardless of mode, one at a time. Specs must reach `status: ready`. **[Checkpoint pause]**

### Step 4 — Contract first
Apply every contract change required by the specs to `contracts/openapi.yaml` in the main working tree **before** branching units (contract edits are shared and must not race). Lint it: `npx -y @redocly/cli lint contracts/openapi.yaml`.

### Step 5 — Develop
- **Parallel path (gate passed):** in a **single message**, dispatch one `flow-developer` per independent unit with `isolation: "worktree"`, each told its unit boundary, owned files, and to commit on its worktree branch. Migrations get distinct timestamps assigned by you up front.
- **Serial path:** dispatch `flow-developer` for each unit in dependency order in the main tree.
- **Merge:** integrate worktree branches **one at a time**; after each merge run `npm run typecheck` and `npm test`. A conflict or red build stops the merge — fix via `flow-developer` on the main tree before merging the next.
Verify `tasks.md` and typecheck yourself before moving on.

### Step 6 — Write tests
Dispatch `flow-test-author` per unit (parallel only for units that were built in parallel, each in its own worktree before merge, or serially after merge). Run `npm test` yourself until green.

### Step 7 — Manual QA
Dispatch `flow-qa-runner` (serial — one server). If the server (or the other vcare service needed for a cross-service flow) is not running, pause and tell the user how to start it.

### Step 8 — Review + fix loop (per module)
a. Run the `/review-code` procedure (size gate → parallel dimension reviewers + adversarial verification, or a single reviewer). **[Checkpoint pause: show findings before fixing]**
b. Findings remain → `flow-developer` in `--fix-review` mode → back to (a).
c. No file / file deleted → clean.
**Loop guard:** if the same finding survives **3** fix rounds, stop and escalate to the user.

### Step 9 — Update docs
Dispatch `flow-docs-updater` per module. If the service card or contract changed, tell the user to run the hub sync; if ownership or integrations changed, recommend `/system-design` for the hub.

### Gates between phases (blockers, like a failing test)
- Evidence before moving on: files exist, `npm run typecheck` and `npm test` observed green.
- Doc hygiene: touched docs have valid frontmatter + fresh `last_verified`; `docs/INDEX.md` has a row per doc; `docs/service-card.md` matches built endpoints/data/dependencies; `spec.md` and code agree with `contracts/openapi.yaml`.
- Never relax the testing policy, security rules, RBAC, or privacy rules to make a phase pass.

### Finish
Summarize: units and how they ran (parallel/serial and why), what was built, test counts, review outcome (clean/escalated), docs and contract changes, hub sync needed, decisions still owed by the user.
