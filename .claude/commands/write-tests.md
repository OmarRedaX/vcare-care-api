---
description: Write unit + integration tests for a module by dispatching flow-test-author. Unit tests mock collaborators; integration tests use the REAL Postgres/Redis/services/repositories and mock only system-external dependencies; RBAC and contract conformance are mandatory.
argument-hint: <module>
allowed-tools: Agent, Task, Read, Grep, Glob, Bash
disable-model-invocation: true
model: inherit
---

## Phase 4 of the feature workflow — Write tests

Target: **$ARGUMENTS**

1. **Preconditions.** The module code exists under `src/app/<module>/` and `docs/<module>/tasks.md` shows the build tasks done. Otherwise tell the user to run `/develop <module>`.
2. **Dispatch `flow-test-author`** (`subagent_type: flow-test-author`) with:
   - the slug;
   - the binding policy from `CLAUDE.md` → "Testing policy": unit tests mock collaborators (the only place mocks live; infra-failure cases are unit tests); integration tests go through the real wiring with **real Postgres and Redis**, never mock services or repositories, and mock only system-external dependencies (providers; the other vcare service via a contract-based fake HTTP server); no infra mocks in `tests/setup.ts`;
   - cover every numbered business rule, **RBAC per route** (wrong role, non-owner, owner, unauthenticated), **contract conformance** against `contracts/openapi.yaml`, idempotency replay/conflict, pagination page 2 on the default sort, transactional no-partial-writes, no secrets/PII/clinical data in responses or logs, and every service-specific mandatory scenario listed under "Testing policy";
   - run `npm test` and iterate until green; flip `(tests)` in `tasks.md` only when green.
3. Do not write tests yourself — the subagent owns them.
4. **Verify** by running `npm test` yourself and reading the counts before reporting.

### Finish
Report files added, observed `npm test` counts, product bugs uncovered (with the failing scenario), and the next step: `/manual-qa <module>`.
