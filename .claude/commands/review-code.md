---
description: Review a module against its spec, the contract, and CLAUDE.md. Non-trivial modules get five parallel dimension reviewers (correctness · security/RBAC+clinical · domain rules · perf/indexing · contract-drift) followed by adversarial verification into one review file; small modules and re-reviews use a single reviewer. Self-closing: deletes the review file once every finding is verified resolved.
argument-hint: <module>
allowed-tools: Agent, Task, Read, Grep, Glob, Bash
disable-model-invocation: true
model: inherit
---

## Phase 6 of the feature workflow — Code review

Target: **$ARGUMENTS**

This command creates findings the first time and, on later runs, verifies fixes and **deletes the review file once the module is clean**. All fan-out is orchestrated **here** — subagents cannot spawn subagents.

### 1. Determine the mode
- List `docs/<module>/reviews/`. A file containing `- [ ] OPEN`, `- [x] RESOLVED`, or `- [ ] DISPUTED` → **re-review** → go to step 4.
- Otherwise → **first review** → step 2.

### 2. Size gate (first review only)
Compute the module's scope:
```bash
FILES=$(git ls-files "src/app/<module>" "src/migrations" | xargs grep -l "<module>" 2>/dev/null | sort -u)
git diff --stat "$(git merge-base HEAD main 2>/dev/null || git rev-list --max-parents=0 HEAD)" -- src/app/<module> src/migrations tests | tail -1
```
Count the module's source files and changed lines (tests included).
- **< 3 files and < 150 changed lines → trivial** → step 4 (single reviewer, `mode: full`).
- **≥ 3 files or ≥ 150 changed lines → non-trivial** → step 3.

### 3. Parallel dimension review → adversarial verification (non-trivial first review)
a. In a **single message**, dispatch five `flow-code-reviewer` subagents with `mode: candidates`, one per `dimension`: `correctness`, `security-rbac-clinical`, `domain-rules`, `perf-indexing`, `contract-drift`. Give each the module slug and the file list. They write nothing.
b. Merge their candidate lists; drop exact duplicates (same file:line + same defect).
c. If there are **zero** candidates → report the module clean; no file. Skip to Finish.
d. Dispatch **one** `flow-code-reviewer` with `mode: verify-findings` and all merged candidates. It tries to refute each one against the actual code, keeps only confirmed findings, re-rates severity, and writes the single `docs/<module>/reviews/review-<YYYYMMDD-HHMM>.md` (or no file if nothing survives).

### 4. Single reviewer (trivial first review, or any re-review)
Dispatch one `flow-code-reviewer` (`subagent_type: flow-code-reviewer`) with `mode: full` and the slug. Remind it of the lifecycle:
- **first review** → review all five dimensions, verify each finding adversarially, write the review file or report clean with no file;
- **re-review** → verify every `RESOLVED` item in code (re-open if the failure scenario still exists), re-check `OPEN`, rule on `DISPUTED`, scan fixes for new issues, and **delete the file if and only if** everything is verified and nothing new was found.

### 5. Guardrails
- Do not review or edit code yourself; reviewers never touch application code.
- Critical by definition: route without authorization, wrong cross-service failure policy, clinical data to an admin or a log, overlap guarantee missing, secrets at rest in plaintext, user token accepted on `/internal/*`.

### Finish
Report the mode (and whether the parallel path ran), findings by severity (plus how many candidates were refuted), and the outcome:
- **Findings remain** → next: `/develop <module> --fix-review`, then `/review-code <module>` again.
- **No file / file deleted** → module clean; next: `/update-docs <module>`.
