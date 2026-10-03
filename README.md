# vcare-care-api — Care Service

Part of the **[Vcare Virtual Care Platform](https://github.com/OmarRedaX/Vcare)** — start there for the
PRD, architecture, service catalog, and cross-service contracts.

Owns **the medical marketplace**: doctor profiles and verification, specialties, schedules and computed
availability, consultations and the video session lifecycle, patient profiles, medical records, the help
center, and the audit log.

> **Status: foundation landed — domain modules next.** The service runs: Express 5 on a public and an
> internal listener, config, DI, errors, logging, request ids, validation, Knex, Redis, idempotency, rate
> limiting, graceful shutdown, worker loop, health probes, the `btree_gist` migration, Docker and CI.
> The shared access base (JWKS user guard, `authorize`, audit log, worker partition loop — [`docs/access/`](./docs/access/))
> is built and tested: `npm test` 46 suites / 724 tests pass; `npm run test:integration` 18 suites, 180 passed,
> 2 SIGTERM cases skipped on Windows (green on Linux CI) (2026-10-03). Manual QA ([`docs/foundation/manual-qa.md`](./docs/foundation/manual-qa.md),
> `scripts/curl-test-foundation.sh`) passed 50 of 52 scenarios. No domain endpoints exist yet;
> [`contracts/openapi.yaml`](./contracts/openapi.yaml) is the design they get built against.
>
> **Open:** 4 product bugs found by tests and QA, 3 of them pinned as `test.failing` (pg error messages leak
> request values into logs, raw Knex console output during a Postgres outage, `INTERNAL_HOST` accepts
> non-IPs, `OPTIONS` on a known path answers 200) — see
> [`docs/foundation/tasks.md`](./docs/foundation/tasks.md). The foundation review
> ([`docs/foundation/reviews/`](./docs/foundation/reviews/)) has 24 open findings (9 current: 4 Medium, 5
> Low; 15 latent, surfacing once domain modules land). `/update-docs foundation` has not run yet.

## Stack

Node.js 24 · TypeScript 5.9 · Express 5 · tsyringe (DI) · Knex + PostgreSQL 17 (`btree_gist`) ·
ioredis + Redis 7 · zod (env schema) · class-validator / class-transformer (DTOs) · Jest + supertest ·
ESLint 9.

One image, two processes: **care-api** (`src/server.ts` — public `:3001` under `/api`, internal `:3101`
under `/internal`) and **care-worker** (`src/worker.ts` — [ADR 0008](./docs/adr/0008-care-worker-component.md)).
Ports sit one above identity-service so both stacks run side by side.

## Run it locally

```bash
npm install
cp .env.example .env                      # synthetic local values; .env is gitignored
docker compose up -d postgres redis       # Postgres 17 on 5433, Redis 7 on 6380
npm run migrate                           # apply migrations (rollback / status also available)
npm run dev                               # public :3001, internal :3101
```

Check both listeners:

```bash
curl -s http://localhost:3001/api/health/ready
curl -s http://localhost:3101/internal/health/ready
```

`docker compose up -d` instead brings up the whole stack (postgres, redis, migrate, care-api, care-worker) from
the image. See [`docs/quickstart.md`](./docs/quickstart.md) for the full walkthrough.

## Test and check

```bash
npm run lint
npm run typecheck
npm test                      # unit
npm run test:infra:up         # Postgres 5434 + Redis 6381 (tmpfs, hermetic)
npm run test:integration      # reads .env.test (cp .env.test.example .env.test to reset it)
npm run test:infra:down
```

## Docs

| Read | For |
|---|---|
| [CLAUDE.md](./CLAUDE.md) | binding rules: stack, layering, security, clinical rules, workflow |
| [docs/INDEX.md](./docs/INDEX.md) | service docs router (architecture, runbook, quickstart, ADRs) |
| [contracts/openapi.yaml](./contracts/openapi.yaml) | the HTTP API — source of truth |
| [docs/architecture/](./docs/architecture/) | overview, api, data-model, rbac, scheduling-slots, clinical-records, file-handling, integration, resilience, infrastructure, deployment, capacity |
| [docs/adr/](./docs/adr/) | service-level decisions (0001–0017) |
| [docs/foundation/](./docs/foundation/) | the foundation module: brainstorm, spec, task list, manual QA, open review |

Platform-wide docs (overview, deployment, capacity, integration, data ownership) live only in the hub —
see hub [ADR 0008](https://github.com/OmarRedaX/Vcare/blob/main/adr/0008-doc-placement-by-scope.md).

**Related repos:** [Vcare (docs hub)](https://github.com/OmarRedaX/Vcare) ·
[vcare-identity-api](https://github.com/OmarRedaX/vcare-identity-api)
