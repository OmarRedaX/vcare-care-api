---
title: ADR 0016 — Foundation runtime dependencies
owner: care-team
service: care-service
status: accepted
last_verified: 2026-09-16
tags: [adr, foundation, dependencies, tooling]
related: [foundation-spec, adr-0006-health-split-redis-tier-2, adr-0007-log-derived-metrics, adr-0008-care-worker-component]
---

# ADR 0016 — Foundation runtime dependencies

- **Status:** accepted
- **Date:** 2026-09-16
- **Context owner:** care-team
- **Supersedes / superseded by:** —

## Context

CLAUDE.md → "Tech stack (locked)" fixes the library set and requires an ADR before **any** new runtime dependency
is added. The `foundation` module (see [spec](../foundation/spec.md)) is the first code in this repo, so it is the
point where the locked stack turns into an actual `package.json`. Three questions need a recorded answer:

1. `tsyringe` does not work without `reflect-metadata`, which is not named in the locked table.
2. Dev-only CORS is needed for the local SPA (`CORS_ORIGINS`), and the usual answer is the `cors` package.
3. Several conveniences (`uuid`, `dotenv`) are habitual in Express services but duplicate Node 24 built-ins.

## Decision

**Runtime dependencies are the locked-stack subset the foundation actually uses, plus `reflect-metadata` — nothing else.**

| Package | Version | Why now |
|---|---|---|
| `express` | 5 | both listeners |
| `helmet` | 8 | security headers |
| `class-validator` / `class-transformer` | 0.14 / 0.5 | DTO validation (`lib/validation`, pagination DTO) |
| `zod` | 4 | env validation only (`lib/config/env.ts`) |
| `tsyringe` | 4 | DI container |
| **`reflect-metadata`** | **0.2** | **new** — required peer of `tsyringe`; imported once per entrypoint |
| `knex` / `pg` | 3 / 8 | Postgres access + raw-SQL migrations |
| `ioredis` | 5 | idempotency, rate limiting, readiness probe |

`jose`, `luxon`, and `undici` are locked-stack members that the foundation does not use; they are **deferred** and land
with the module that needs them (`lib/auth`, `pkg/slots`, `lib/identity-client` respectively). Adding them then needs no
new ADR — they are already in the locked table.

**Rejected additions, with the built-in used instead:**

| Rejected | Instead |
|---|---|
| `cors` | in-house `src/lib/http/cors.ts` — ~40 lines, allowlist-only, mounted **only** when `NODE_ENV=development`; production is a single origin with CORS disabled (hub ADR 0005), so a dependency whose main value is configurability we must not use is not worth the supply-chain surface |
| `uuid` | `crypto.randomUUID()` (Node built-in) for request ids; `UUID_PATTERN` for validation |
| `dotenv` | `node --env-file-if-exists` / `tsx --env-file-if-exists` for processes, `process.loadEnvFile()` in `tests/setup-env.ts`; production containers get real environment variables, never a file |

**Dev dependencies:** `typescript@5`, `@types/node@24`, `@types/express@5`, `@types/pg@8`, `tsx@4`, `jest@30`,
`ts-jest@29`, `@types/jest@30`, `supertest@7`, `@types/supertest@6`, `eslint@9`, `@eslint/js@9`,
`typescript-eslint@8`. (`@types/pg` is not in the spec's list; it is a types-only package for the already-locked
`pg` runtime dependency, and `strict` typecheck fails without it because `pg` ships no bundled declarations.)

**`tsx` is safe with `tsyringe`.** `tsx` uses esbuild, which honours `experimentalDecorators` but emits **no**
`design:paramtypes` metadata, so container resolution that relies on reflected constructor parameter types would break
under `npm run dev` and `npm run migrate` while working under `tsc`. The foundation removes that failure mode by rule:
**every constructor parameter carries an explicit `@inject(TOKENS.X)`** (spec §1.2). Resolution is then identical under
`tsc`, `tsx`, and `ts-jest` with `isolatedModules`. A constructor parameter without `@inject` is a review finding.

**Version pinning:** `.npmrc` sets `save-exact=true` and `engine-strict=true`; `package.json` pins exact versions and
`engines.node` is `>=24 <25`; `package-lock.json` is committed and CI installs with `npm ci`.

## Consequences

- **Positive:** a minimal, auditable dependency tree for the first module; no package whose only job is a Node built-in;
  the `tsx`/`tsc` divergence is eliminated by an invariant that is easy to review; deferring `jose`/`luxon`/`undici`
  keeps unused crypto and HTTP code out of the image until a module owns it.
- **Negative:** the in-house CORS middleware is our code to maintain and test (covered by unit + integration tests,
  spec §9); the explicit-`@inject` rule is a convention a reviewer must enforce, not a compiler guarantee.
- **Follow-up:** any later module adding a runtime dependency outside the locked table needs its own ADR; adding a
  locked-table member does not.
