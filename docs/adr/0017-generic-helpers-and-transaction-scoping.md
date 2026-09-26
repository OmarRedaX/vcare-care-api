---
title: ADR 0017 — Generic helpers live in lib/pkg; transactions use Knex's handler form
owner: care-team
service: care-service
status: accepted
last_verified: 2026-09-26
tags: [adr, layering, transactions, code-style]
related: [adr-0001-no-orm-knex-raw-sql, adr-0016-foundation-runtime-dependencies]
---

# ADR 0017 — Generic helpers live in lib/pkg; transactions use Knex's handler form

- **Status:** accepted
- **Date:** 2026-09-26
- **Context owner:** care-team
- **Supersedes / superseded by:** —

## Context

A scan of the foundation code for domain-free helpers living in the wrong place found no misplaced service
helpers (the only service is `health`), but found generic behaviour copied between `lib/` modules:

| Helper | Copies | Now |
|---|---|---|
| bounded wait (`Promise.race` against an unref'd timer, cleared on settle) | `lib/knex/probe.ts`, `lib/redis/redis.ts` | `lib/async/settle-within.ts` |
| route label from `req.baseUrl + req.route.path` | `lib/logger/request-logger.ts`, `lib/rate-limit/rate-limit.ts`, `lib/idempotency/idempotency.ts` (three different fallbacks) | `lib/http/route-pattern.ts` |
| Redis client resolution (override → container → root client) | `lib/rate-limit/rate-limit.ts`, `lib/idempotency/idempotency.ts` | `lib/redis/redis.ts` → `resolveRedis` |
| graceful `QUIT` with `disconnect()` fallback | `src/server.ts`, `tests/helpers/redis.ts` | `lib/redis/redis.ts` → `closeRedis` |
| UUID shape check | exported from `lib/request-id` and imported by `lib/idempotency` | `pkg/utils/uuid.ts` → `isUuid` |

The route-label merge also removes a latent leak: the rate limiter fell back to the concrete `req.path`
(ids in a log label) outside a matched route. All three callers now fall back to `unmatched`.

Identity's services repeat the same seven-line open/commit/rollback block around every transaction, and the
natural next step is a private `inTransaction` wrapper per service. CLAUDE.md said "explicit commit/rollback",
which is what invited that. Knex's handler form already is that wrapper: it commits when the callback
resolves, and rolls back and rethrows when it throws.

## Decision

1. **Generic helpers have one home.** Domain-free behaviour (transaction scoping, retry/backoff, timeouts,
   Redis client resolution, route labels, id parsing, pagination, serialization, error mapping) lives in
   `lib/<concern>/` or `pkg/utils`, never as a private method of a service, controller, or repository, and is
   never copied between `lib/` modules. A helper with a single caller is not extracted just to have one.
2. **Transactions use `await this.db.transaction(async (trx) => …)`.** No hand-rolled `trx.commit()` /
   `trx.rollback()`, no wrapper helper. Repositories take `trx` as `conn`. Calls to Identity, storage, and video
   happen after the `await`, outside the transaction (the Case 1/3/4 "commit locally, then call Identity" order).

## Consequences

- No transaction helper exists in `lib/`; there is nothing to test or keep in parity with Identity.
- Unit tests that mock `db.transaction` must invoke the callback with a fake `trx`
  (`transaction: jest.fn((work) => work(fakeTrx))`).
- If a future need appears (isolation level, retry on `40001` serialization failure), it goes into one
  `lib/knex/` helper then, and this ADR is superseded.
- Identity has the same duplication; aligning it is an Identity change, not a Care one.
