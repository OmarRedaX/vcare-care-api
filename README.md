# vcare-care-api — Care Service

Part of the **[Vcare Virtual Care Platform](https://github.com/OmarRedaX/Vcare)** — start there for the
PRD, architecture, service catalog, and cross-service contracts.

Owns **the medical marketplace**: doctor profiles and verification, specialties, schedules and computed
availability, consultations and the video session lifecycle, patient profiles, medical records, the help
center, and the audit log.

> **Status: foundation landed — domain modules next.** The service runs: Express 5 on a public and an
> internal listener, config, DI, errors, logging, request ids, validation, Knex, Redis, idempotency, rate
> limiting, graceful shutdown, worker loop, health probes, the `btree_gist` migration, Docker and CI.
> `npm run lint`, `npm run typecheck`, and `npm run build` are green, and the health probes, migrations,
> and error envelope were verified by hand against the compose test stack (Postgres 17 + Redis 7).
> **One follow-up is open:** the unit and integration suites are scaffolding only (`/write-tests
> foundation`). The env files from [`docs/foundation/spec.md`](./docs/foundation/spec.md) §3.8 are in
> place: `.env.example`, `.env.test`, and `.env.test.example` are committed; `.env` and
> `.env.test.bak.real` are local-only and gitignored. No domain endpoints exist yet;
> [`contracts/openapi.yaml`](./contracts/openapi.yaml) is the design they get built against.

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
npm test                      # unit — scaffolding only until /write-tests foundation runs
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
| [docs/adr/](./docs/adr/) | service-level decisions (0001–0016) |
| [docs/foundation/](./docs/foundation/) | the foundation module: brainstorm, spec, and live task list |

Platform-wide docs (overview, deployment, capacity, integration, data ownership) live only in the hub —
see hub [ADR 0008](https://github.com/OmarRedaX/Vcare/blob/main/adr/0008-doc-placement-by-scope.md).

**Related repos:** [Vcare (docs hub)](https://github.com/OmarRedaX/Vcare) ·
[vcare-identity-api](https://github.com/OmarRedaX/vcare-identity-api)
