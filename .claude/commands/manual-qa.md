---
description: Manually QA a module's endpoints with CURL against a running server by dispatching flow-qa-runner — bearer tokens per role, service tokens for /internal, Idempotency-Key and X-Request-Id — recording docs/<module>/manual-qa.md and a repeatable script.
argument-hint: <module>
allowed-tools: Agent, Task, Read, Grep, Glob, Bash
disable-model-invocation: true
model: inherit
---

## Phase 5 of the feature workflow — Manual QA (CURL)

Target: **$ARGUMENTS**

1. **Preconditions.** `docs/<module>/spec.md` exists (QA is checked against it and `contracts/openapi.yaml`).
2. **Server check.** `curl -s -o /dev/null -w "%{http_code}" http://localhost:${PORT:-3000}/api/health`. If the module has `/internal/*` routes, also check `http://localhost:${INTERNAL_PORT:-3100}/internal/health`. If a check fails, tell the user how to start the service (see `docs/quickstart.md`: env, migrate, dev) — and, for flows that call the other vcare service, that it (or its documented fake) must be running — then ask whether to proceed. Do not start long-running processes unprompted.
3. **Dispatch `flow-qa-runner`** (`subagent_type: flow-qa-runner`) with:
   - the slug and base URLs (public + internal);
   - exercise every endpoint: happy path, validation failure, unauthenticated, wrong role / non-owner, not-found/conflict/state errors, idempotent replay + conflicting replay where applicable; internal routes with a service token **and** proof a user token is rejected;
   - compare status, `error.code`, envelope, and echoed `X-Request-Id` against the **spec + contract** (not against 200);
   - record `docs/<module>/manual-qa.md` (frontmatter, results table), save `scripts/curl-test-<module>.sh`, redact tokens/secrets/PII/clinical text, update the `(manual-qa)` task.
4. Do not run the QA yourself — the subagent owns it.

### Finish
Report pass/fail counts, the `manual-qa.md` path, each real failure with a one-line diagnosis, and the next step: `/review-code <module>`.
