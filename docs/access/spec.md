---
title: access — Spec
owner: care-team
service: care-service
module: access
status: ready
version: 1.0.0
diataxis: reference
last_verified: 2026-10-03
tags: [spec, access, auth, jwks, jose, rbac, authorize, audit, audit-logs, partitions, postgres-roles, worker, redis-breaker]
related: [access-brainstorm, foundation-spec, rbac, data-model, infrastructure, resilience, integration, deployment, runbook, quickstart, adr-0006-health-split-redis-tier-2, adr-0007-log-derived-metrics, adr-0008-care-worker-component, adr-0009-audit-logs-monthly-partitions, adr-0016-foundation-runtime-dependencies, adr-0017-generic-helpers-and-transaction-scoping]
contracts: [contracts/openapi.yaml]
---

# access — Spec

The shared access base every business module plugs into: local verification of Identity user tokens, deny-by-default
`authorize(policy)`, the append-only audit log with its database roles and partition maintenance, and the four latent
foundation gaps the first mounted business route would expose. **No business route is added.** Scope follows
[brainstorm.md](./brainstorm.md) exactly, including its "Decisions on the former open questions (2026-10-02)", which
this spec does not reopen.

Binding rules: CLAUDE.md → "Authentication and service-to-service auth", "Authorization — RBAC and ownership",
"Database rules", "API conventions", "Security rules", "Privacy and logging", "Cross-service integration",
"Testing policy". The foundation's as-built text is [foundation/spec.md](../foundation/spec.md) (§13 wins over its
earlier sections). Where this spec changes a foundation file, the change is listed in §3 and §12.

---

## 1. Overview

### 1.1 What `access` owns
| Area | Delivers |
|---|---|
| `lib/auth` | `JwksCache` (in-memory Identity JWKS, refresh policy, readiness state), `UserTokenVerifier` (jose `jwtVerify` + claim checks), `userGuard()` |
| `lib/rbac` | `Policy` types, `authorize(policy)`, `assertRoutesAuthorized(router)`, route markers (`authorize`, guard, probe-exempt), role/status guards |
| `lib/audit` | `AuditRecorder.record(trx, entry)` (one row in the caller's transaction), entry validation, `actorFromAuth`, the `audit-partitions` worker loop |
| Database | app group role `vcare_app`; `audit_logs` (monthly range partitions + `DEFAULT`); `audit_logs_ensure_partitions(int)` (`SECURITY DEFINER`); explicit grants |
| Database login | `care_app` login (member of `vcare_app`), provisioned by `node dist/migrate.js ensure-app-login` from `DATABASE_URL` |
| `care-worker` | its own Postgres pool (`care-worker`), the first real loop, `--once <loop>` mode, pool closed on shutdown |
| Health | informational `checks.identityJwks` on both readiness probes (contract change C1, decided — §14.2) |
| Foundation fixes | [#5](https://github.com/OmarRedaX/vcare-care-api/issues/5), [#6](https://github.com/OmarRedaX/vcare-care-api/issues/6), [#10](https://github.com/OmarRedaX/vcare-care-api/issues/10), [#11](https://github.com/OmarRedaX/vcare-care-api/issues/11) (§12) |
| Errors | `TokenExpired` (401) and `EmailNotVerified` (403) constants in `lib/error/errors.ts` |

### 1.2 Principles
- **The only principal is the verified token.** `X-User-Id`, `X-Role`, `X-Forwarded-User`, body ids, and path params
  never grant anything (CLAUDE.md → Authentication and service-to-service auth).
- **No network call per request.** The guard verifies against the in-memory key set; the JWKS is fetched in the
  background every 5 minutes, and on an unknown `kid` at most once per minute.
- **Fail closed everywhere.** No key → 401; no policy → boot error; unknown policy outcome → 403; audit failure → the
  write (or clinical read) fails and rolls back.
- **Append-only is a grant, not a habit.** `vcare_app` holds `INSERT`/`SELECT` on `audit_logs` and nothing else there.
- **Identity parity where it fits** (identity `src/lib/auth`, `src/lib/rbac`): same Bearer parsing, `jwtVerify`
  options, `TokenExpired`/`Unauthorized` mapping, `AUTHORIZE_MARKER`/`PROBE_EXEMPT_MARKER` symbols, boot-time route
  walk, `captureRoute`/`sealRouter`. Care differs where Care's rules differ (§1.4).

### 1.3 Dependencies
- **Other modules:** foundation only. Every later module depends on `access`.
- **Other service:** identity-service `GET /.well-known/jwks.json` on its public listener (read only; §5). No service
  token, no `lib/identity-client` (out of scope).
- **New runtime dependencies:** `jose` 6 (same major as identity, exact version pinned) and `undici` 7. Both are in
  CLAUDE.md → Tech stack (locked); ADR 0016 records that adding a locked-table member needs no new ADR.

### 1.4 Parity with identity-service — differences, stated
| Item | Identity | Care (`access`) | Why |
|---|---|---|---|
| Readiness body | `checks: { database, redis }` | adds optional `checks.identityJwks: up \| down` | **Exception to foundation §1.4 "Ready body — change only in both repos".** Identity signs tokens and has no remote JWKS to report, so no equivalent field exists there. The addition is optional and informational, so the shared `{ status, checks.database, checks.redis }` part stays byte-identical. Decided by the user 2026-10-02 |
| Suspended account in a token | `403 AccountSuspended` | `403 Forbidden` | Care's `ErrorCode` enum has no `AccountSuspended`; the contract's `Forbidden` response already says "account state not allowed, or the doctor is locally suspended". No contract change |
| Ownership | not evaluated in `authorize` | DB-backed resolver in the policy (`404` vs `403`) | CLAUDE.md → Authorization — RBAC and ownership |
| Extra DB checks | none | `checks` hook (the doctors module plugs in `suspended_at`) | brainstorm decision 2026-10-02 |
| Guard before `authorize` | not asserted | asserted at boot | a policy without a principal can only answer 401 |
| JWKS | built in memory (it is the issuer) | remote, cached (§3.3) | Care is a consumer |
| Route label helper file | `lib/http/route-capture.ts` | `lib/http/route-pattern.ts` (existing, ADR 0017) | one home for the helper; exported names match identity (`captureRoute`, `sealRouter`) |

---

## 2. Database schema

### 2.1 Roles (cluster objects, not tables)
| Role | Kind | Created by | Holds |
|---|---|---|---|
| `care` | owner, `LOGIN` (compose/CI superuser locally; production: the owner credential of hub `deployment.md` → Release pipeline step 3) | infrastructure | owns every table, sequence, and function; runs migrations |
| `vcare_app` | group, `NOLOGIN` | migration `create_app_role` (idempotent `DO` block) | `CONNECT` on the database, `USAGE` on schema `public`, and the per-table grants each migration adds |
| `care_app` | login, `INHERIT`, member of `vcare_app`, `NOSUPERUSER NOCREATEDB NOCREATEROLE` | `node dist/migrate.js ensure-app-login` (§3.8) — **never** a migration, so no password is ever committed in a migration | nothing directly; everything through `vcare_app` |

`care-api` and `care-worker` connect with `DATABASE_URL` (user `care_app`); `care-migrate` and the integration-test
global setup connect with `MIGRATION_DATABASE_URL` (user `care`). Grants are **explicit per table** in the migration
that creates the table — no `ALTER DEFAULT PRIVILEGES` (decided 2026-10-02).

### 2.2 Migrations (in this order; timestamps assigned by `npm run migrate:make`)
| # | File (`src/migrations/<ts>_<name>.ts`) | Change |
|---|---|---|
| 1 | `<ts>_create_app_role` | `vcare_app`, `CONNECT`, `USAGE ON SCHEMA public` |
| 2 | `<ts>_create_audit_logs` | partitioned `audit_logs`, `audit_logs_default`, grants, sequence grant |
| 3 | `<ts>_create_audit_logs_ensure_partitions` | `SECURITY DEFINER` function, `EXECUTE` grant, initial monthly partitions (current + 2) |

`btree_gist` (foundation migration) stays an owner action; nothing changes there.

#### Migration 1 — `create_app_role`
```sql
-- up
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vcare_app') THEN
        CREATE ROLE vcare_app NOLOGIN;   -- roles are cluster-wide: idempotent so a second database (dev + test in one
    END IF;                              -- cluster) or a re-run never fails
END
$$;
DO $$
BEGIN
    EXECUTE format('GRANT CONNECT ON DATABASE %I TO vcare_app', current_database());
END
$$;
GRANT USAGE ON SCHEMA public TO vcare_app;

-- down
REVOKE USAGE ON SCHEMA public FROM vcare_app;
DO $$
BEGIN
    EXECUTE format('REVOKE CONNECT ON DATABASE %I FROM vcare_app', current_database());
END
$$;
DO $$
BEGIN
    DROP ROLE IF EXISTS vcare_app;
EXCEPTION WHEN dependent_objects_still_exist THEN
    RAISE NOTICE 'vcare_app kept: it still holds privileges in another database of this cluster';
END
$$;
```
- Requires `CREATEROLE` on the owner: locally `care` is the container superuser; in production the owner role holds
  `CREATEROLE` (decided 2026-10-02, hub `deployment.md` → Release pipeline step 3; §14.3).
- `vcare_app` never gets `CREATE` on `public` (PostgreSQL 17 grants `PUBLIC` only `USAGE` there), so the app role
  cannot create or alter tables.

#### Migration 2 — `create_audit_logs` ([ADR 0009](../adr/0009-audit-logs-monthly-partitions.md))
```sql
-- up
CREATE TABLE audit_logs (
    id              BIGSERIAL,
    actor_user_id   BIGINT,                 -- Identity user id (no FK); NULL for service and system actors
    actor_role      VARCHAR(16) NOT NULL,
    action          VARCHAR(64) NOT NULL,   -- <entity>.<verb>, e.g. specialty.created, record.read
    entity_type     VARCHAR(64) NOT NULL,   -- snake_case, e.g. medical_record
    entity_id       BIGINT NOT NULL,        -- polymorphic by entity_type: no FK
    request_id      UUID,                   -- the request's X-Request-Id; NULL for worker actors without one
    metadata        JSONB NOT NULL,         -- ids, statuses, reasons only; never clinical text or PII
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT pk_audit_logs PRIMARY KEY (id, created_at),
    CONSTRAINT chk_audit_logs_actor_role CHECK (actor_role IN ('patient', 'doctor', 'admin', 'service', 'system')),
    CONSTRAINT chk_audit_logs_actor_user_id CHECK ((actor_role IN ('patient', 'doctor', 'admin')) = (actor_user_id IS NOT NULL)),
    CONSTRAINT chk_audit_logs_entity_id_positive CHECK (entity_id > 0),
    CONSTRAINT chk_audit_logs_metadata_object CHECK (jsonb_typeof(metadata) = 'object'),
    CONSTRAINT chk_audit_logs_metadata_size CHECK (octet_length(metadata::text) <= 4096)
) PARTITION BY RANGE (created_at);

COMMENT ON TABLE audit_logs IS 'Append-only (INSERT/SELECT for vcare_app). Monthly partitions audit_logs_yYYYYmMM; retention >= 6 years by detach + archive, never DELETE (ADR 0009).';
COMMENT ON COLUMN audit_logs.actor_user_id IS 'Identity user id (no cross-database FK); NULL for service and system actors.';

-- Catches rows outside every monthly partition; must stay empty (AuditPartitionMissing alerts otherwise).
CREATE TABLE audit_logs_default PARTITION OF audit_logs DEFAULT;

GRANT INSERT, SELECT ON audit_logs TO vcare_app;
GRANT INSERT, SELECT ON audit_logs_default TO vcare_app;   -- SELECT: the worker's non-empty check reads it directly
GRANT USAGE ON SEQUENCE audit_logs_id_seq TO vcare_app;    -- nextval() for BIGSERIAL

-- down (dev/test only; production never rolls back a table with audit history — expand/migrate/contract)
DROP TABLE IF EXISTS audit_logs;   -- drops every partition and their grants with it
```
- **No `UPDATE`, `DELETE`, or `TRUNCATE` grant** on the parent or any partition. The `REVOKE UPDATE, DELETE` line in
  `data-model.md` becomes unnecessary under explicit grants (docs follow-up, §13.2).
- `chk_audit_logs_actor_user_id`, `chk_audit_logs_entity_id_positive`, and `chk_audit_logs_metadata_size` are
  additions to the `data-model.md` design: they turn `lib/audit` validation rules (§3.5) into database guarantees
  (docs follow-up, §13.2).
- **Indexes:** only the primary key in this unit. The three read indexes of `data-model.md` (for `GET /audit-logs`)
  are **not** created here: they ship with the `audit` module's migration (decision D1, §14.1). No FKs exist, so no FK indexes are needed.
- `created_at DEFAULT NOW()` is the transaction start time, so every row of one transaction shares a timestamp; the
  `(id, created_at)` key stays unique through `id`.

> **Superseded in part (review 2026-10-03, L2/L3):** migration 4 `20261003120000_audit_logs_column_insert_grants`
> replaces the table-level `INSERT` on `audit_logs`, `audit_logs_default`, and every partition with
> `INSERT (actor_user_id, actor_role, action, entity_type, entity_id, request_id, metadata)` (+ `SELECT`), so the app
> role can never set `id` or `created_at`; migration 5 `20261003120100_audit_logs_partitions_attach` replaces the
> function body: `CREATE TABLE … (LIKE public.audit_logs INCLUDING DEFAULTS INCLUDING CONSTRAINTS)` then
> `ALTER TABLE public.audit_logs ATTACH PARTITION …` (SHARE UPDATE EXCLUSIVE on the parent — never blocks inserts),
> the same column-level grant, `lock_timeout = '200ms'`. The SQL below is migration 3 as it ran; the grants and the
> function body shown are no longer current.

#### Migration 3 — `create_audit_logs_ensure_partitions`
The worker connects as `care_app`, and PostgreSQL requires the **owner of the parent** to create a partition
(`CREATE TABLE <name> PARTITION OF audit_logs` checks parent ownership; `vcare_app` also has no `CREATE` on `public`). Giving the
worker the owner credential would defeat the role split, so partition creation goes through one narrow,
owner-defined `SECURITY DEFINER` function that takes only a bounded integer.
```sql
-- up
CREATE FUNCTION audit_logs_ensure_partitions(p_months_ahead integer)
RETURNS TABLE (partition_name text, created boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp          -- no caller-controlled schema can shadow anything; objects are schema-qualified
SET lock_timeout = '2s'                         -- never queue behind a long lock and stall audit inserts behind us
AS $fn$
DECLARE
    v_first_month timestamp := date_trunc('month', now() AT TIME ZONE 'UTC');
    v_from        timestamp;
BEGIN
    IF p_months_ahead IS NULL OR p_months_ahead < 0 OR p_months_ahead > 12 THEN
        RAISE EXCEPTION 'p_months_ahead must be between 0 and 12' USING ERRCODE = '22023';
    END IF;
    FOR i IN 0..p_months_ahead LOOP
        v_from := v_first_month + make_interval(months => i);
        partition_name := 'audit_logs_y' || to_char(v_from, 'YYYY') || 'm' || to_char(v_from, 'MM');
        created := to_regclass('public.' || partition_name) IS NULL;
        IF created THEN
            EXECUTE format(
                'CREATE TABLE IF NOT EXISTS public.%I PARTITION OF public.audit_logs FOR VALUES FROM (%L) TO (%L)',
                partition_name,
                v_from AT TIME ZONE 'UTC',
                (v_from + interval '1 month') AT TIME ZONE 'UTC');
            EXECUTE format('GRANT INSERT, SELECT ON public.%I TO vcare_app', partition_name);
        END IF;
        RETURN NEXT;
    END LOOP;
END
$fn$;

REVOKE ALL ON FUNCTION audit_logs_ensure_partitions(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION audit_logs_ensure_partitions(integer) TO vcare_app;

-- Current UTC month + the next 2 (= the AUDIT_PARTITION_MONTHS_AHEAD default; migrations cannot read env —
-- the worker extends to the configured value on its first tick).
SELECT partition_name, created FROM audit_logs_ensure_partitions(2);

-- down
DROP FUNCTION IF EXISTS audit_logs_ensure_partitions(integer);   -- partitions stay; they go with the table (migration 2 down)
```
- Bounds are rendered as `timestamptz` literals with an offset, so the range never depends on the session time zone.
- ADR 0009 says "the first migration creates the current and next month"; creating current + 2 is a superset and
  matches the worker's default horizon.
- Creating a partition while `audit_logs_default` holds a row inside the new range fails (PostgreSQL validates the
  default partition). The function raises, the worker reports `audit_partition_missing` (§3.6), and the runbook
  moves the rows (§13.2).

### 2.3 Test-database reset and the dev database
- **Test databases (disposable):** `npm run test:infra:down && npm run test:infra:up` (tmpfs; the global setup
  migrates and provisions `care_app`). CI starts fresh containers every run.
- **Dev database (migrated in place, decided 2026-10-02):** update `.env` from `.env.example` (§3.10), then
  `npm run migrate` and `npm run migrate:ensure-app-login`. Existing data is kept; there are no business tables to
  re-grant yet. The compose `migrate` service does both steps on `docker compose up`.

---

## 3. API contract and file-level design

### 3.1 Endpoints
No new public or internal operation. Two existing operations change their response body (additive):

| Method | Path | Listener | Guard | Roles | Ownership | Idempotency | Rate limit | Change |
|---|---|---|---|---|---|---|---|---|
| GET | `/api/health/ready` | public `PORT` | none (documented health exception, foundation §3.1) | `public` (`x-roles: [public]`) | none (`x-ownership: none`) | n/a | none | body gains `checks.identityJwks` |
| GET | `/internal/health/ready` | internal `INTERNAL_PORT` | none (documented health exception) | `public` | none | n/a | none | body gains `checks.identityJwks` |
| GET | `/api/health/live`, `/internal/health/live` | each | none | `public` | none | n/a | none | unchanged |

**Readiness body after the change** (statuses and HTTP codes exactly as foundation §3.1; `identityJwks` never changes
either):

| Condition | Status | Body |
|---|---|---|
| shutdown in progress | 503 | `{ "status": "down", "checks": { "database": <probe>, "redis": <probe>, "identityJwks": <cache> } }` |
| Postgres probe failed | 503 | `{ "status": "down", "checks": { "database": "down", "redis": <probe>, "identityJwks": <cache> } }` |
| Postgres up, Redis down | 200 | `{ "status": "degraded", "checks": { "database": "up", "redis": "down", "identityJwks": <cache> } }` |
| both up | 200 | `{ "status": "ok", "checks": { "database": "up", "redis": "up", "identityJwks": <cache> } }` |

`<cache>` = `JwksCache.status()` (§3.3): `up` when the cache holds a key set younger than 1 h **and** the latest fetch
attempt succeeded; otherwise `down`. **No network call** is made by the probe. `identityJwks: "down"` with Postgres up
is still `200` and `ok`/`degraded` by Redis alone (ADR 0006: only Postgres fails readiness). Headers unchanged
(`X-Request-Id`, `Cache-Control: no-store`); not enveloped; not rate-limited. The contract edit is C1 (decided;
§14.2).

**Test-only routes.** Every behaviour below is exercised through routers mounted by the integration tests via
`buildTestApps({ publicRouters })` (`extraRouters`), never via `src/routes.ts`, and never present in the contract.
Their policies are listed in §9.3 with roles and ownership like any other route.

### 3.2 Route composition (binding for every later module)
```
router.<verb>(path,
    rateLimit({ name, limit, windowMs, subject: byIp })?,    // optional: sheds floods before signature verification
    userGuard(),                            // authentication only: sets req.auth
    authorize(policy),                      // roles → account state → email → checks → ownership
    rateLimit({ name, limit, windowMs, subject: byUser })?,  // optional: needs req.auth
    idempotency({ required })?,             // after guard + authorize (principal = user:<id>)
    controller.method)
```
- Same order as identity's per-route chain. `noStore()` is applied at router level by clinical and consultation
  routers (foundation §3.4.6).
- Every module `routes.ts` returns `sealRouter(router)` (§12.2).
- `createPublicApp` / `createInternalApp` call `assertRoutesAuthorized(app.router)` **after** mounting health and the
  module routers and **before** mounting `extraRouters` (§3.4.3). A violation throws, `runMain` logs `boot_failed`,
  and the process exits 1.
- Service-token routes (`serviceGuard`, `ServiceTokenRequired`, `InsufficientScope`) are out of scope; they land with
  the doctors module and extend `Policy` with a `service` kind.

### 3.3 `lib/auth` — user-token verification
Files: `constants.ts`, `jwks-cache.ts`, `jwks-fetcher.ts`, `jwks.dto.ts`, `user-token-verifier.ts`, `user-guard.ts`,
`types.ts`.

#### 3.3.1 `constants.ts` (not env — the contract fixes them; identity parity)
| Constant | Value | Rule |
|---|---|---|
| `JWT_ISSUER` | `"vcare-identity"` | `iss` must equal |
| `JWT_AUDIENCE` | `"vcare-care"` | `aud` must contain |
| `JWT_ALGORITHMS` | `["EdDSA"]` | pinned; no `none`, no algorithm confusion |
| `CLOCK_TOLERANCE_SECONDS` | `30` | `exp`/`nbf` tolerance (decided 2026-10-02) |
| `JWKS_REFRESH_INTERVAL_MS` | `300_000` | background refresh = Identity's `Cache-Control: max-age=300` |
| `JWKS_MIN_FETCH_INTERVAL_MS` | `60_000` | at most one demand fetch (unknown `kid`, no keys, stale) per minute |
| `JWKS_MAX_STALE_MS` | `3_600_000` | cached keys trusted at most 1 h after the last **successful** fetch |
| `JWKS_FETCH_TIMEOUT_MS` | `2_000` | whole fetch (connect + headers + body) |
| `JWKS_MAX_BYTES` | `65_536` | larger body → failure |
| `JWKS_MAX_KEYS` | `16` | more keys → invalid document |
| `MAX_BEARER_TOKEN_LENGTH` | `4_096` | longer → `401` without parsing |

`JWT_ISSUER`/`JWT_AUDIENCE` replace the planned env vars `JWT_ISSUER`/`JWT_AUDIENCE` in `infrastructure.md` (docs
follow-up): a configurable value could only break contract conformance.

#### 3.3.2 `jwks-fetcher.ts` (the only `undici` import in `src/` until `lib/identity-client`)
```ts
export function fetchJwksDocument(url: string, signal: AbortSignal): Promise<unknown>;   // throws JwksFetchError
export class JwksFetchError extends Error { readonly reason: JwksFailureReason; readonly status?: number }
// JwksFailureReason (types.ts) = "timeout" | "network" | "http_status" | "content_type" | "too_large" | "invalid_json"
```
- `undici.request(url, { method: "GET", headers: { accept: "application/json", "x-request-id": <id> },
  headersTimeout: 2000, bodyTimeout: 2000, signal })`; `signal` combines the caller's (stop) signal with
  `AbortSignal.timeout(JWKS_FETCH_TIMEOUT_MS)`. `<id>` = `currentRequestId()` when the fetch was triggered inside a
  request, else `crypto.randomUUID()` (CLAUDE.md → API conventions: a request id on every call to Identity).
- Redirects are not followed: any status other than `200` → `http_status`.
- `content-type` must start with `application/json` or `application/jwk-set+json`, else `content_type`.
- The body is read chunk by chunk and aborted beyond `JWKS_MAX_BYTES` (`too_large`); then `JSON.parse`
  (`invalid_json`). Global `fetch` is not used (CLAUDE.md → Tech stack: `undici`; ESLint, §3.11).
- **Why not jose `createRemoteJWKSet`:** it cannot express the decided policy — after its `cacheMaxAge` a failed
  re-fetch makes verification fail (no 1 h stale-if-error window), its fetch is not `undici`'s explicit client, and its
  state (age, last attempt) is not observable for readiness. jose is used only for `importJWK` and `jwtVerify`.

#### 3.3.3 `jwks.dto.ts` (Identity's response is validated, never trusted — CLAUDE.md → Cross-service integration)
Mirrors the hub copy of Identity's contract (`Jwks`, `Jwk`), validated with `lib/validation`:
```ts
class JwkDto { @Equals("OKP") kty; @Equals("Ed25519") crv; @IsString() @Matches(/^[A-Za-z0-9_-]{43}$/) x;
               @IsString() @Length(1, 128) kid; @Equals("EdDSA") alg; @Equals("sig") use; }
class JwksDocumentDto { @IsArray() @ArrayMinSize(1) @ArrayMaxSize(16) @ValidateNested({ each: true }) @Type(() => JwkDto) keys; }
```
Unknown **public** members (`key_ops`, `x5t`, …; the contract's `Jwk` allows extras) are **stripped**, not rejected —
`validateBody(JwksDocumentDto, body, { unknownMembers: "strip" })`, never imported (review 2026-10-03, L5; the contract
wins over the earlier `forbidNonWhitelisted` choice). A private `d` member is declared (`@Equals(undefined)`) and fails
the whole document. Duplicate `kid`s make the document invalid. Any failure →
`invalid_document`: the **whole** response is rejected and the previous key set is kept (a malformed response is a
failure, not data). Each key is imported with jose `importJWK(jwk, "EdDSA")`; an import failure is also
`invalid_document`.

#### 3.3.4 `jwks-cache.ts`
```ts
export class JwksCache implements JwksStatusSource {
  constructor(options: JwksCacheOptions);
      // { url: string; logger: Logger; fetcher?: (url, signal) => Promise<unknown> /* fetchJwksDocument */;
      //   now?: () => number /* Date.now */; timers?: { setInterval; clearInterval } }
  start(): void;                                   // boot: one fetch (not awaited) + unref'd 5-min interval
  stop(): void;                                    // clears the interval, aborts an in-flight fetch; idempotent
  getKey(kid: string): Promise<CryptoKey | undefined>;
  refresh(trigger: JwksRefreshTrigger): Promise<boolean>;   // "boot" | "interval" | "stale" | "unknown_kid" | "no_keys"
  status(): "up" | "down";
}
```
State: `keys: Map<kid, CryptoKey> | null`, `fetchedAt` (last successful fetch), `lastAttemptAt`, `lastAttemptOk`,
`inFlight: Promise<boolean> | null`.

| Situation | Behaviour |
|---|---|
| `refresh()` while a fetch is in flight | returns the in-flight promise (single-flight; one HTTP request) |
| `refresh("stale" \| "unknown_kid" \| "no_keys")` within `JWKS_MIN_FETCH_INTERVAL_MS` of the last attempt start | returns `false` without fetching (the per-minute gate; counts **every** attempt, successful or not) |
| `refresh("boot" \| "interval")` | always attempts (single-flight still applies) |
| fetch + validation succeed | the map is **replaced wholesale** (a `kid` removed by Identity stops verifying at once — emergency rotation), `fetchedAt = lastAttemptAt`, `lastAttemptOk = true`; log `info jwks_refreshed` `{ trigger, keys: <count> }` |
| fetch or validation fails | previous map kept; `lastAttemptOk = false`; log `warn jwks_refresh_failed` `{ trigger, host, reason, status? }`; `metric("jwks_refresh_failed", 1, { reason })` |
| `getKey(kid)`, set age ≤ 5 min | lookup; found → key |
| `getKey(kid)`, 5 min < age ≤ 1 h | start `refresh("stale")` **without awaiting it**, then lookup in the current set (the 5-min timer normally keeps the set fresh; this path only covers a missed or failed tick) |
| `getKey(kid)`, `kid` absent from a usable set | `await refresh("unknown_kid")` (gated, single-flight), then lookup once more; still absent → `undefined` |
| `getKey(kid)`, no usable set (never fetched, or age > 1 h) | `await refresh("no_keys")` (gated), then lookup; nothing usable → `undefined` (**never** a stale key older than 1 h) |
| set age crosses 1 h without a success | log `error jwks_keys_expired` once per crossing (reset by the next success) |
| every interval tick | after the tick, `metric("jwks_cache_age_s", <seconds since fetchedAt>)` when a set was ever loaded |
| `status()` | `up` iff `fetchedAt !== null` and age ≤ 1 h and `lastAttemptOk`; else `down` |

`host` = `new URL(url).host`; the path, query, and response body are never logged.

This table makes CLAUDE.md → Authentication and service-to-service auth concrete: the key set is "re-fetched once
older than Identity's 5-minute `max-age` and on an unknown `kid` at most once per minute; while refreshes fail the
cached keys stay trusted for at most 1 hour after the last successful fetch, then none are". The 5-minute interval
performs the "older than `max-age`" re-fetch proactively; the `stale` trigger covers a missed or failed tick.

#### 3.3.5 `user-token-verifier.ts`
```ts
export class UserTokenVerifier {
  constructor(options: { jwks: KeySource; now?: () => Date });   // KeySource = Pick<JwksCache, "getKey">
  verify(token: string): Promise<AuthContext>;                     // throws Unauthorized | TokenExpired (AppError)
}
```
1. `jwtVerify(token, keyResolver, { algorithms: ["EdDSA"], issuer: JWT_ISSUER, audience: JWT_AUDIENCE,
   clockTolerance: 30, currentDate: now(), requiredClaims: ["sub", "exp", "iat", "jti"] })`. `keyResolver` reads the
   protected header's `kid`; a missing `kid` → `Unauthorized` without any fetch; `await jwks.getKey(kid)` →
   `undefined` → `Unauthorized`.
2. `errors.JWTExpired` → `TokenExpired` (jose raises it only after the signature verified). Every other jose error →
   `Unauthorized`.
3. Claim shape (identity parity): `typ === "user"`; `sub` parsed by `parsePositiveId` (`pkg/utils/id.ts`:
   `^[1-9][0-9]{0,15}$` and `Number.isSafeInteger`); `role` passes `isRole`; `status` passes `isAccountStatus`;
   `ev` is a boolean; `jti` is a non-empty string ≤ 64 chars. Any failure → `Unauthorized`.
4. Returns `{ userId, role, status, emailVerified: ev }` (`AuthContext`, already declared in `lib/types/types.ts`).
5. Anything thrown that is neither a jose error nor an `AppError` (a bug) → log `error token_verification_error`
   (serialized error, never the token) and `Unauthorized` — fail closed.

#### 3.3.6 `user-guard.ts`
```ts
export function userGuard(options?: { verifier?: UserTokenVerifier }): RequestHandler;
      // default verifier resolved from TOKENS.UserTokenVerifier at request time (test overrides work, like resolveRedis)
```
1. `captureRoute(req, res)` (§12.2).
2. `Authorization` must match `/^Bearer (\S+)$/i` and the token must be ≤ `MAX_BEARER_TOKEN_LENGTH`; else
   `next(Unauthorized)`.
3. `verifier.verify(token)` → `req.auth = auth`; the request-context store gets `userId` and `role`
   (`requestContext.getStore()`), so every later log line, including `request_completed`, carries them →
   `next()`. Rejection → `next(err)` (`Unauthorized`/`TokenExpired`).
4. Never reads the database, Redis, or any identity header. Marked with `GUARD_MARKER` (§3.4.2).

| Guard outcome | Status | Code |
|---|---|---|
| header missing, not `Bearer`, empty, two tokens, over 4 096 chars | 401 | `Unauthorized` |
| bad signature, unknown `kid` after the gated refresh, wrong `alg`/`iss`/`aud`/`typ`, missing `exp`/`iat`/`sub`/`jti`, malformed claims, `nbf` in the future beyond 30 s | 401 | `Unauthorized` |
| JWKS unreachable and no cached key matches | 401 | `Unauthorized` |
| signature valid, `exp` + 30 s ≤ now | 401 | `TokenExpired` |

### 3.4 `lib/rbac` — deny-by-default authorization
Files: `types.ts`, `roles.ts`, `markers.ts`, `authorize.ts`, `assert-routes-authorized.ts`.

#### 3.4.1 `types.ts` (aligned with the `rbac-ownership-guard` skill's policy contract)
```ts
export type OwnershipDecision = "allow" | "deny-not-found" | "deny-forbidden";
export interface AccessContext { auth: AuthContext; params: Readonly<Record<string, string>> }
export type OwnershipResolver = (ctx: AccessContext) => Promise<OwnershipDecision>;
export type OwnershipRule =
  | { kind: "none" }                                              // role check is sufficient (x-ownership: none)
  | { kind: "self" }                                              // /me routes: the service acts only on auth.userId
  | { kind: "resolver"; name: string; resolve: OwnershipResolver };  // DB-backed predicate (x-ownership: <name>)
export interface AccessCheck {                                    // extra DB-backed condition (doctors: suspended_at)
  name: string;                                                   // snake_case, logged as access_denied reason check:<name>
  appliesTo: readonly Role[];
  run: (ctx: AccessContext) => Promise<"allow" | "deny-forbidden">;
}
export interface AccountStateRule {
  statuses?: Partial<Record<Role, readonly AccountStatus[]>>;    // default ["active"] for every listed role
  emailVerified?: boolean;                                       // true → ev=false gets 403 EmailNotVerified
}
export type AuditClass = "clinical-read" | "clinical-write" | "admin-action";
export interface UserPolicy {
  kind: "user";
  roles: readonly Role[];          // explicit; no wildcard (a new role gets nothing until named)
  owner: OwnershipRule;            // mandatory, even when { kind: "none" }
  accountState?: AccountStateRule;
  checks?: readonly AccessCheck[];
  audit?: AuditClass;              // declarative (mirrors x-audit); the service writes the rows
}
export type Policy = UserPolicy;   // the doctors module adds ServicePolicy ({ kind: "service"; scope })
export interface RouteLayer { /* minimal Express 5 layer view used only by assertRoutesAuthorized */ }
```
Resolvers and checks receive only the verified `auth` and the path `params`; they **never** see `req.body`, so a
body id cannot influence an ownership decision. They query the database themselves (the module's service or
repository, closed over when the policy is built in the module's `policies.ts`).

#### 3.4.2 `roles.ts`, `markers.ts`
- `ROLES = ["patient", "doctor", "admin"]`, `ACCOUNT_STATUSES = ["pending", "active", "rejected", "suspended"]`,
  `isRole(v)`, `isAccountStatus(v)` (identity parity; a unit test asserts they equal the `lib/types` unions).
- `AUTHORIZE_MARKER = Symbol.for("vcare.authorize")`, `GUARD_MARKER = Symbol.for("vcare.guard")`,
  `PROBE_EXEMPT_MARKER = Symbol.for("vcare.probe-exempt")` (same symbol names as identity); non-enumerable
  `defineProperty`; `isAuthorizeHandler`, `isGuardHandler`, `markProbeExempt(router)`, `isProbeExempt`.

#### 3.4.3 `authorize.ts`
```ts
export function authorize(policy: Policy | undefined, logger?: Logger): RequestHandler;
```
**At construction** (route registration = boot): `undefined` → throws `route_without_policy`; an invalid policy →
throws `policy_invalid: <reason>`: empty or duplicate `roles`, a role outside `ROLES`, a `statuses` key not in
`roles`, an empty status list, **any status list containing `suspended`** (no Care route admits a suspended account),
a check whose `appliesTo` is empty or not ⊆ `roles`, duplicate check names, a check or resolver name not matching
`^[a-z][a-z0-9_]*$`.

**Per request**, in this order (each denial logs `info access_denied` `{ reason, route: routeLabel(req) }` — never ids):

| # | Step | Denial | Reason |
|---|---|---|---|
| 0 | `captureRoute(req, res)` | — | — |
| 1 | `req.auth` present | `401 Unauthorized` | `unauthenticated` |
| 2 | `auth.role ∈ policy.roles` | `403 Forbidden` | `role` |
| 3 | `auth.status ∈ statuses[auth.role] ?? ["active"]` | `403 Forbidden` (a `suspended` token lands here) | `status` |
| 4 | `accountState.emailVerified` → `auth.emailVerified` | `403 EmailNotVerified` | `email_unverified` |
| 5 | each check whose `appliesTo` contains `auth.role`, sequentially | `403 Forbidden` | `check:<name>` |
| 6 | ownership: `none`/`self` → allow; `resolver` → decision | `deny-not-found` → `404 NotFound`; `deny-forbidden` → `403 Forbidden` | `ownership_not_found` / `ownership_forbidden` |
| 7 | — | `next()` | — |

- Status, email, and checks run **before** ownership, so a caller who may not act at all cannot probe whether a
  private id exists (404 vs 403). This reorders `rbac.md` → Principles 3 ("role, then ownership, then account
  state") — docs follow-up §13.2.
- A resolver or check that throws → `next(err)` (500 `InternalError` through the error handler; the database is the
  usual cause). A decision value outside the union → `403 Forbidden` (fail closed).
- The handler carries `AUTHORIZE_MARKER`. It is `async`; Express 5 forwards a rejection to `next`.
- **Doctor local suspension (brainstorm decision 2026-10-02):** practising-doctor policies declare an `AccessCheck`
  named `doctor_not_suspended` (`appliesTo: ["doctor"]`) supplied by the doctors module, reading
  `doctor_profiles.suspended_at` by `auth.userId`. `access` ships only the hook. Booking's check of the **target**
  doctor (Domain rules → Eligibility 6) is a service rule of the consultations module, not a policy check.

#### 3.4.4 `assert-routes-authorized.ts`
```ts
export function assertRoutesAuthorized(router: Router): void;   // throws on the first violation
```
Walks Express 5 `router.stack` recursively (identity's algorithm, tightened by review 2026-10-03 H1 — deny by default
at every depth). For every `layer.route`, **one chain per method** (`route.stack` grouped by `entry.method`; `.all`
entries, `method === undefined`, are interleaved into every verb's chain and also form an `ALL` chain), and per chain:
- no handler with `AUTHORIZE_MARKER` → throws `route_without_policy: <METHOD> <path>`;
- no handler with `GUARD_MARKER` **before** the first `AUTHORIZE_MARKER` handler → throws
  `route_without_guard: <METHOD> <path>`;
- any handler before `authorize` that is not a guard, a `markPreAuth` handler, or a 4-arity error handler → throws
  `handler_before_authorize: <METHOD> <path>`.
Every **non-route** layer must be a router (walked), an Express 5 sub-app mounted with `router.use` (its `app.router`
is walked), a probe-exempt router, a 4-arity error handler (`sealRouter`'s capture), or middleware carrying
`PRE_AUTH_MARKER` (`markPreAuth`, `lib/rbac/markers.ts`) — anything else (`router.use(path, handler)`, the `app.use`
`mounted_app` wrapper) throws `middleware_without_policy: <fn name> under <path>`. `markPreAuth` is applied where the
middleware is defined: `requestId`, `inFlight`, `requestLogger`, `cors`, `optionsNotFound`, `noStore`, `rateLimit`;
`app.ts`/`internal-app.ts` mark the third-party `helmet()` and `express.json()`.
Every walked router — the root `app.router`, nested routers, a sub-app's `app.router`, and probe-exempt routers —
must have no `router.param` / `app.param` callbacks (`router.params[name]` non-empty) → else throws
`param_callback_without_policy: <name> under <path>` (review 2026-10-03, round 2). Express 5 `processParams` runs them
for every matched layer whose path has that param **before** the route's guard and `authorize`, so a by-id loader
would answer an anonymous caller (404 before 401) and skip the ownership 404. **Never use `router.param`; load by id
inside the service after `authorize`.**
Layers whose handle carries `PROBE_EXEMPT_MARKER` are skipped (the health router: `buildHealthRouter()` returns
`markProbeExempt(sealRouter(router))`). `createPublicApp`/`createInternalApp` call it on `app.router` before the
`extraRouters` loop, so test-only routers are never checked and production never has them. Runs in **every**
environment.

### 3.5 `lib/audit` — the write side
Files: `audit.ts`, `constants.ts`, `partition-loop.ts`, `types.ts`.

```ts
// types.ts
export type AuditActor =
  | { kind: "user"; userId: number; role: Role }          // actor_user_id = userId, actor_role = role
  | { kind: "service"; clientId: string }                 // actor_user_id NULL, actor_role 'service', metadata.actorClientId
  | { kind: "system" };                                   // actor_user_id NULL, actor_role 'system' (worker loops, retriers)
export type AuditMetadataValue = string | number | boolean | null;   // contract AuditLogEntry.metadata
export interface AuditEntry {
  actor: AuditActor; action: string; entityType: string; entityId: number;
  metadata: Readonly<Record<string, AuditMetadataValue>>;
  requestId?: string;                                     // default: currentRequestId(); null when none
}
// audit.ts
export class AuditRecorder {
  constructor(options: { logger: Logger });
  record(trx: Knex.Transaction, entry: AuditEntry): Promise<void>;
}
export function actorFromAuth(auth: AuthContext): AuditActor;   // { kind: "user", userId, role }
```
**`record(trx, entry)`:**
1. `trx.isTransaction !== true` → throws `audit_requires_transaction` (a programming error, 500). It never opens a
   transaction itself (CLAUDE.md → Database rules → Transactions); clinical reads therefore run their read and audit
   in one `db.transaction(async (trx) => { read; audit.record(trx, entry) })`, so a failed audit fails the read (contract `InternalError`: "Also
   returned when an audit write for a clinical read fails").
2. Validation (each failure throws `audit_entry_invalid: <field>` — a programming error, 500, the transaction rolls
   back): `action` matches `^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$` and ≤ 64 chars; `entityType` matches
   `^[a-z][a-z0-9_]*$` and ≤ 64; `entityId` positive safe integer; `actor.userId` positive safe integer; `metadata` a
   plain object with ≤ 20 keys, keys match `^[a-zA-Z][a-zA-Z0-9]*$`, **no key whose normalised form is in
   `REDACTED_KEYS`** (clinical/PII field names such as `complaintText`, `email`, `fullName`), values scalar per
   `AuditMetadataValue`, numbers finite, strings ≤ 500 chars, serialized JSON ≤ 2 048 bytes (the DB cap is 4 096);
   `requestId` a UUID when present.
3. One statement, explicit columns, no `RETURNING`:
   `INSERT INTO audit_logs (actor_user_id, actor_role, action, entity_type, entity_id, request_id, metadata) VALUES (?, ?, ?, ?, ?, ?, ?::jsonb)`.
4. Insert failure → log `error audit_write_failed` `{ action, entityType, error }` (never metadata) +
   `metric("audit_write_failed", 1, { action })` (feeds `AuditWriteFailures`), then rethrow.

The unit audits nothing itself; it is the mechanism every later module's service calls.

### 3.6 `care-worker` — `audit-partitions` loop (`lib/audit/partition-loop.ts`)
```ts
export function buildAuditPartitionLoop(deps: { db: Knex; logger: Logger; monthsAhead: number }): WorkerLoop;
      // name "audit-partitions", intervalMs 86_400_000 (daily; the LoopRunner runs the first tick at start)
```
`constants.ts`: `AUDIT_PARTITION_LOOP_NAME = "audit-partitions"`, `AUDIT_PARTITION_INTERVAL_MS = 86_400_000`,
`AUDIT_PARTITION_LOCK_KEY = 7_311_420_001` (bigint advisory-lock key reserved for this loop),
`AUDIT_DEFAULT_SAMPLE_LIMIT = 1_001`.

**Tick** (`signal.aborted` → return before starting):
1. `await db.transaction(async (trx) => { lock; ensure })`:
   `SELECT pg_try_advisory_xact_lock(?) AS locked` → `false` → log `debug audit_partitions_locked_elsewhere`, return.
   Otherwise `SELECT partition_name, created FROM audit_logs_ensure_partitions(?)` (`monthsAhead`) → log
   `info audit_partitions_ensured` `{ created: [names created this tick], checked: <count> }`;
   `metric("audit_partition_missing", 0)`.
   - The transaction-scoped lock (`pg_try_advisory_xact_lock`, not the session `pg_try_advisory_lock` named in the
     brief) releases on commit or rollback, so a pooled connection can never leak a held lock.
2. If step 1 throws (lock timeout, a `DEFAULT` row in the new range, permissions): log
   `error audit_partition_missing` `{ error }` (SQLSTATE only, per `serializeError`) and
   `metric("audit_partition_missing", 1)`; do **not** rethrow (step 3 must still run).
3. `SELECT count(*)::int AS rows FROM (SELECT 1 FROM audit_logs_default LIMIT 1001) AS sample` →
   `metric("audit_default_partition_rows", rows)` (bounded at 1 001); `rows > 0` → `warn
   audit_default_partition_nonempty` `{ rows }`. Read-only, so it runs on every worker (two workers emit the same
   gauge — harmless).

`AuditPartitionMissing` (ticket, `deployment.md`) fires on `audit_partition_missing = 1` or
`audit_default_partition_rows > 0`.

**`src/worker.ts` changes** (foundation §3.3 "the first module with a loop adds exactly what it uses"):
1. `const workerDb = createKnex({ url: env.DATABASE_URL, poolMax: 2, statementTimeoutMs: 5_000, applicationName:
   "care-worker" })` (acquire timeout 1 s per foundation §3.4.8). No Redis.
2. `buildWorkerLoops({ env, db: workerDb, logger })` → `[buildAuditPartitionLoop({ db, logger, monthsAhead:
   env.AUDIT_PARTITION_MONTHS_AHEAD })]` (`WorkerLoopDeps` in `lib/worker/types.ts`).
3. Stop path: `runner.stop()` then `workerDb.destroy()`, both inside the existing `SHUTDOWN_TIMEOUT_MS` deadline.
4. **`--once <loop>`** (`node dist/worker.js --once audit-partitions`, already referenced by `runbook.md`; review
   2026-10-03 L4: a tick may return `TickOutcome` `"incomplete"` — the partition loop does when `ensure()` returned
   `"locked"` or `"failed"` — and `--once` then logs `worker_once_incomplete` and exits 1; `LoopRunner` ignores it): build the
   loops, run exactly one tick of the named loop with a fresh `AbortController`, destroy the pool, exit 0; unknown
   name → `error worker_loop_unknown` + exit 1; a tick that throws → `error worker_tick_failed` + exit 1.

### 3.7 Health module changes (`src/app/health/`)
- `types.ts`: `HealthChecks { database; redis; identityJwks: ProbeStatus }` (comment: informational, never affects
  `status`).
- `service/health.service.ts`: constructor adds `@inject(TOKENS.JwksCache) private readonly jwks: JwksStatusSource`;
  `ready()` sets `checks.identityJwks = jwks.status() === "up" ? Up : Down` synchronously; status/HTTP logic unchanged.
- `dto/health.response.dto.ts`: `ReadyResponseDto.checks` gains `identityJwks`, copied explicitly.
- `routes.ts`: returns `markProbeExempt(sealRouter(router))`.

### 3.8 `src/migrate.ts` and `lib/knex/app-login.ts`
- `migrate.ts` connects with `getMigrationEnv().MIGRATION_DATABASE_URL` (owner) for every command.
- New command **`ensure-app-login`** → `ensureAppLogin(ownerKnex, env.DATABASE_URL)`:
  ```ts
  export function ensureAppLogin(owner: Knex, appDatabaseUrl: string): Promise<{ created: boolean }>;
  ```
  1. Parse user and password from `appDatabaseUrl` (URL-decoded). User must match `^[a-z_][a-z0-9_]{0,62}$`; password
     non-empty; else throws `app_login_url_invalid` (no value in the message).
  2. As owner: one parameterised `pg_roles` lookup of the login (attributes, owned objects, memberships — see 4).
     Absent → build the DDL server-side with
     `SELECT format('CREATE ROLE %I WITH LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD %L IN ROLE vcare_app', ?, ?) AS ddl`
     and execute the result. Present → `ALTER ROLE %I WITH LOGIN PASSWORD %L` and `GRANT vcare_app TO %I` (both via
     `format`). Quoting is PostgreSQL's (`%I`/`%L`); nothing is concatenated in TypeScript.
  3. Log `info app_login_ensured` `{ created }` only — never the user name, password, or URL.
  4. (Review 2026-10-03, L1 + M1.) An existing role that has `SUPERUSER`, `CREATEROLE`, `CREATEDB`, `REPLICATION`, or
     `BYPASSRLS`, or owns objects (`pg_shdepend` deptype `o`), or (round 2) is a direct member (`pg_auth_members`) of
     any role other than `vcare_app` — the owner role, `pg_write_all_data`, `pg_read_all_data`, `pg_monitor`, … —
     whose privileges it would inherit, is **refused** with `app_login_role_privileged` before any DDL (the
     transaction rolls back) — never taken over and never silently demoted. Every failure of the role check or of a
     DDL build/execute is rethrown as the fixed `app_login_ddl_failed` carrying only a SQLSTATE `code` (Knex
     prefixes the SQL — which holds the password — to the message of a failed statement, and a dropped connection
     has no SQLSTATE, so the message would otherwise be logged by `migration_failed`; the role check is wrapped too so
     the login name stays out even when the caller's pool interpolates bindings).
- `make` template gains a reminder comment: grant `vcare_app` explicitly; append-only tables get `INSERT, SELECT` only.
- `package.json`: `"migrate:ensure-app-login": "tsx --env-file-if-exists=.env src/migrate.ts ensure-app-login"`
  (the existing tooling test asserts every `migrate*` script loads `.env`).

### 3.9 DI tokens (`lib/di/tokens.ts`) and registration
| Token | Instance | Registered in |
|---|---|---|
| `TOKENS.JwksCache` (`Symbol.for("JwksCache")`) | `new JwksCache({ url: env.IDENTITY_JWKS_URL, logger })` | `registerCore(env)` |
| `TOKENS.UserTokenVerifier` (`Symbol.for("UserTokenVerifier")`) | `new UserTokenVerifier({ jwks })` | `registerCore(env)` |
| `TOKENS.AuditRecorder` (`Symbol.for("AuditRecorder")`) | `new AuditRecorder({ logger })` | `registerCore(env)` |

All three are `lib/` classes registered as instances (no decorators needed). Services inject `@inject(TOKENS.AuditRecorder)`.
`src/server.ts`: after `registerDependencies(env)`, `container.resolve<JwksCache>(TOKENS.JwksCache).start()`;
`closeResources` gains `async () => jwks.stop()` as its **first** entry. The worker does not register or start the cache.

### 3.10 Environment (`lib/config/env.ts`, `lib/config/types.ts`)
| Variable | zod type | Default | Secret | Used by |
|---|---|---|---|---|
| `DATABASE_URL` | unchanged refines | **none** | yes | `care-api`, `care-worker` — **now the app login (`care_app`)** |
| `MIGRATION_DATABASE_URL` | same refines as `DATABASE_URL`; **optional** in `envSchema`; when both are set, its user must differ from `DATABASE_URL`'s ("must use a different role than DATABASE_URL") | **none** | yes | `src/migrate.ts` (required there via `getMigrationEnv()`, same `invalid_environment` exit), test global setup and `truncateAll` |
| `IDENTITY_JWKS_URL` | `http:`/`https:` URL | **none** (a wrong default would 401 every request silently) | no | `JwksCache` |
| `AUDIT_PARTITION_MONTHS_AHEAD` | `coerce.number().int().min(1).max(12)` | `2` (ADR 0009) | no | worker loop |

- `MIGRATION_DATABASE_URL` stays optional so `care-api`/`care-worker` tasks never need the owner secret (least
  privilege; hub `deployment.md` → Release pipeline step 3).
- `getMigrationEnv(): MigrationEnv` (`Env & { MIGRATION_DATABASE_URL: string }`) — memoized; missing key → one
  `invalid_environment` line naming `MIGRATION_DATABASE_URL`, exit 1.
- `IDENTITY_JWKS_URL` is required by the shared schema, so `care-worker` and `care-migrate` must set it too (as they
  already set `REDIS_URL`).

| File | Change |
|---|---|
| `.env.example` | `MIGRATION_DATABASE_URL=postgres://care:care@localhost:5433/care` (SECRET, owner); `DATABASE_URL=postgres://care_app:care_app@localhost:5433/care` (SECRET, app login); `IDENTITY_JWKS_URL=http://localhost:3000/.well-known/jwks.json` (comment: point at wherever the local identity public listener runs); `AUDIT_PARTITION_MONTHS_AHEAD=2` |
| `.env.test` | `MIGRATION_DATABASE_URL=postgres://care:care@localhost:5434/care_test`; `DATABASE_URL=postgres://care_app:care_app@localhost:5434/care_test`; `IDENTITY_JWKS_URL=http://127.0.0.1:1/.well-known/jwks.json` (unreachable placeholder; suites override the cache with a fake JWKS, §9.1) |
| `docker-compose.yml` | `migrate`: `command: ["sh", "-c", "node dist/migrate.js latest && node dist/migrate.js ensure-app-login"]`, env `MIGRATION_DATABASE_URL=postgres://care:care@postgres:5432/care` and `DATABASE_URL=postgres://care_app:care_app@postgres:5432/care`; `care-api`, `care-worker`: `DATABASE_URL` → `care_app`; all three: `IDENTITY_JWKS_URL: ${IDENTITY_JWKS_URL:-http://host.docker.internal:3000/.well-known/jwks.json}` and `extra_hosts: ["host.docker.internal:host-gateway"]`; `care-worker` adds `AUDIT_PARTITION_MONTHS_AHEAD: 2` |
| `docker-compose.test.yml`, `.github/workflows/ci.yml` | unchanged (the `care` superuser of the test containers creates `vcare_app` and `care_app`; CI reads `.env.test`) |

### 3.11 Tooling
- `package.json` dependencies: `jose`, `undici` (exact versions, `save-exact`).
- ESLint (`eslint.config.mjs`): `jose` may be imported only under `src/lib/auth/**`; `undici` only in
  `src/lib/auth/jwks-fetcher.ts` (and later `src/lib/identity-client/**`); `no-restricted-globals: fetch` in `src/`.
  Tests are exempt (they sign tokens with jose). Each rule gets a case in `tests/unit/lint/restricted-imports.test.ts`.
- `scripts/access-qa-server.ts` (dev-only QA harness, run with `tsx --env-file-if-exists=.env`): refuses
  `NODE_ENV=production`; `registerDependencies(env)`, `JwksCache.start()`, then `createPublicApp({ extraRouters:
  [{ path: "/api", router: buildAccessTestRouter() }] }).listen(PORT)`. Lets `/manual-qa` hit the test-only routes
  with real Identity tokens without mounting them in `src/routes.ts`. `scripts/` is already in `.dockerignore`.

### 3.12 File list
```
src/
  lib/auth/       constants.ts  jwks-cache.ts  jwks-fetcher.ts  jwks.dto.ts  user-token-verifier.ts  user-guard.ts  types.ts
  lib/rbac/       types.ts  roles.ts  markers.ts  authorize.ts  assert-routes-authorized.ts
  lib/audit/      audit.ts  constants.ts  partition-loop.ts  types.ts
  lib/knex/       app-login.ts (new)
  lib/redis/      breaker.ts (new) · redis.ts (isRedisUsable, withRedis)                       §12.3
  lib/http/       route-pattern.ts (captureRoute, sealRouter; routePattern reads res.locals)    §12.2
  lib/error/      errorHandler.ts (#5) · errors.ts (TokenExpired, EmailNotVerified)             §12.1
  lib/idempotency/ idempotency.ts · idempotency-store.ts (#10, #11)                             §12.3, §12.4
  lib/rate-limit/ rate-limit.ts (#10, #11)                                                       §12.3, §12.4
  lib/config/     env.ts · types.ts
  lib/di/         tokens.ts · register-core.ts
  lib/logger/     redact.ts (REDACTED_KEYS + connectionString, databaseUrl, migrationDatabaseUrl)
  lib/worker/     types.ts (WorkerLoopDeps)
  pkg/utils/      id.ts (parsePositiveId)
  app/health/     types.ts · service/health.service.ts · dto/health.response.dto.ts · routes.ts
  app.ts  internal-app.ts  server.ts  worker.ts  worker-loops.ts  migrate.ts
  migrations/     <ts>_create_app_role.ts  <ts>_create_audit_logs.ts  <ts>_create_audit_logs_ensure_partitions.ts
scripts/access-qa-server.ts
tests/helpers/    tokens.ts  fake-jwks.ts (new) · db.ts (ownerDb, truncateAll) · test-routers.ts · types.ts
tests/integration/global-setup.ts (owner URL + ensureAppLogin)
tests/unit/  tests/integration/   (suites listed in §9)
package.json  eslint.config.mjs  .env.example  .env.test  docker-compose.yml
```

---

## 4. Business rules

| # | Rule (testable) | Enforced by |
|---|---|---|
| A1 | The only principal is the verified token: `X-User-Id`, `X-Role`, `X-Forwarded-User`, body ids, and path params never set or change `req.auth` | `userGuard` (reads only `Authorization`) |
| A2 | A token is accepted only with an EdDSA signature by a JWKS key matching its `kid`, `iss=vcare-identity`, `aud` ∋ `vcare-care`, `typ=user`, required `sub`/`exp`/`iat`/`jti`, well-formed `sub`/`role`/`status`/`ev`; otherwise `401 Unauthorized` | `UserTokenVerifier` |
| A3 | A token whose signature verifies but whose `exp` + 30 s has passed gets `401 TokenExpired` | `UserTokenVerifier` |
| A4 | The JWKS is refreshed every 5 min; a demand fetch (unknown `kid`, no keys, stale) happens at most once per 60 s across all triggers; concurrent refreshes share one HTTP request; each fetch is bounded by 2 s and 64 KiB | `JwksCache` |
| A5 | Cached keys are trusted for at most 1 h after the last successful fetch; with no usable key the answer is `401`, never a skipped verification | `JwksCache.getKey`, `UserTokenVerifier` |
| A6 | A successful fetch replaces the key set wholesale (a removed `kid` stops verifying immediately); a failed or malformed fetch keeps the previous set | `JwksCache` |
| A7 | Readiness reports `checks.identityJwks` from cache state without a network call; it never changes `status` or the HTTP code | `HealthService.ready` |
| A8 | A route registered with `authorize(undefined)` or an invalid policy throws at construction; a route method without `authorize`, without a guard before it, or with a non-guard/non-pre-auth handler before it, and any unmarked non-route, non-router layer (`router.use(path, fn)`, an unwalkable sub-app), and any `router.param` / `app.param` callback on a walked router (never use `router.param`; load by id inside the service after `authorize`), stops the process at boot; health is exempt by marker; test routers are mounted after the check | `authorize`, `assertRoutesAuthorized`, `createPublicApp`/`createInternalApp` |
| A9 | `authorize` order and outcomes: no principal 401 · role 403 · status 403 (default `active`; `suspended` never allowed) · email 403 `EmailNotVerified` · checks 403 · ownership 404/403 | `authorize` |
| A10 | Ownership and checks decide from the database with `auth` and path params only; the request body is not passed to them | `AccessContext` type + tests |
| A11 | `audit.record` writes exactly one row inside the caller's transaction, refuses a non-transaction connection, and the row disappears when the transaction rolls back | `AuditRecorder` + Postgres |
| A12 | Audit rows hold no clinical text or PII: flat scalar metadata, ≤ 2 KB (DB ≤ 4 KB), no redacted key names, strings ≤ 500; user actors carry a user id, service/system actors do not | `AuditRecorder` validation + `chk_audit_logs_*` |
| A13 | `audit_logs` is append-only for the app: `INSERT`/`SELECT` succeed; `UPDATE`, `DELETE`, `TRUNCATE` fail with `42501` on the parent, the default partition, and every monthly partition | grants (migrations 2, 3) |
| A14 | `care-api` and `care-worker` connect as `care_app` (member of `vcare_app`), which cannot create tables or alter `audit_logs` and can INSERT only the seven non-key `audit_logs` columns (never `id`/`created_at`); migrations run as the owner; the two URLs must name different roles; `ensure-app-login` refuses a privileged, object-owning, or other-role-member existing role | migration 1, `ensure-app-login`, env refine |
| A15 | After a successful worker tick the partitions for the current UTC month and the next `AUDIT_PARTITION_MONTHS_AHEAD` months exist with grants; ticks are idempotent; concurrent ticks serialize on one advisory lock and never fail on a duplicate | `audit_logs_ensure_partitions` + `partition-loop` |
| A16 | A failed ensure emits `audit_partition_missing`; a non-empty `DEFAULT` partition emits `audit_default_partition_nonempty` and its row-count gauge; `worker --once audit-partitions` exits 1 unless that tick ensured the partitions; creating a month never blocks concurrent audit inserts (ATTACH) | `partition-loop` |
| A17 | A malformed percent-encoded path parameter → `400 ValidationFailed`, no `unhandled_error`, the raw value never logged (#5) | `errorHandler` (§12.1) |
| A18 | `request_completed.route` keeps the full mount prefix when a nested router's handler throws (#6) | `captureRoute`/`sealRouter` (§12.2) |
| A19 | A Redis that stalls while `status === "ready"` costs at most `REDIS_BREAKER_FAILURE_THRESHOLD` command timeouts per open window; then idempotency is skipped and rate limits fall back without touching Redis (#10) | `RedisBreaker` (§12.3) |
| A20 | A malformed stored idempotency record (or any unexpected throw in the idempotency or rate-limit middleware) never crashes the process and never produces an endless `409` (#11) | §12.4 |

---

## 5. Cross-service behavior
| Direction | Call | Integration case | Failure policy |
|---|---|---|---|
| Care → Identity public listener | `GET {IDENTITY_JWKS_URL}` (`/.well-known/jwks.json`), unauthenticated, `X-Request-Id` forwarded | **none of Cases 1–4** — public-key distribution (hub `landscape.md` → "Authorization without a network call") | **Degrade to cache, fail closed:** keep verifying with cached keys ≤ 1 h; unknown `kid` → one gated refetch → `401`; no usable key → `401`; never skip verification. Reported as `identityJwks: down`; never fails readiness, never 5xx |

- Not routed through `lib/identity-client` (out of scope; no service token): CLAUDE.md → Folder structure places
  `jwks-cache.ts` in `lib/auth/`. `overview.md` still says identity-client holds the JWKS cache (docs follow-up).
- Hub and Identity alignment was applied on 2026-10-02 by the orchestrator, not by this spec (§14.3).
- Identity's `max-age=300` and its emergency-rotation guarantee (identity `docs/architecture/auth-tokens.md`: a
  compromised key stops verifying once consumers refetch, ≤ 5 min) hold because the background refresh runs every
  5 minutes and replaces the set wholesale.

---

## 6. Error codes
No new code. All are in the contract `ErrorCode` enum and CLAUDE.md → API conventions.

| Code | HTTP | When (this unit) | Emitted by |
|---|---|---|---|
| `Unauthorized` | 401 | missing/malformed `Authorization`; invalid token; unknown `kid`; JWKS unavailable with no matching key; route reached without a principal | `userGuard`, `authorize` |
| `TokenExpired` | 401 | valid signature, expired (`exp` + 30 s) — message `Access token expired` | `userGuard` |
| `Forbidden` | 403 | role not in policy; account status not allowed (incl. `suspended`); a policy check denied (e.g. local doctor suspension); ownership `deny-forbidden`; unknown resolver outcome | `authorize` |
| `EmailNotVerified` | 403 | policy requires `ev=true` — message `Verify your email before booking` (contract example; modules may `withMessage`) | `authorize` |
| `NotFound` | 404 | ownership `deny-not-found` (private resource) | `authorize` |
| `ValidationFailed` | 400 | malformed percent-encoded path parameter (`[{ field: "path", issue: "must be valid percent-encoding" }]`); other non-`AppError` client errors (`[{ field: "request", issue: "could not be processed" }]`) | `errorHandler` (§12.1) |
| `InternalError` | 500 | resolver/check threw; audit insert failed or entry invalid (transaction rolled back) | `errorHandler` |

---

## 7. Security & privacy
- **RBAC summary:** this unit ships the mechanism; it adds no business route. Health stays the documented exception
  (`markProbeExempt`). Every future route must be `userGuard() → authorize(policy)` (or the later `serviceGuard`),
  proven at boot. Policies name roles explicitly; `suspended` is never admissible; admins are never listed on clinical
  routes (enforced per module by the `rbac-ownership-guard` skill and its tests).
- **Audit events:** none written by this unit. It provides `AuditRecorder` for the events of CLAUDE.md → Privacy and
  logging; rows are append-only by grant (A13).
- **Never logged:** the bearer token or any part of it (header, payload, signature, `kid`, `jti`); `Authorization`;
  the JWKS URL path/query or response body (only `host`, `reason`, `status`); database URLs, the app-login user name or
  password (`app_login_ensured` carries only `created`); audit `metadata` (failures log `action`/`entityType` only);
  ownership decisions log a reason, never ids. New `REDACTED_KEYS`: `connectionString`, `databaseUrl`,
  `migrationDatabaseUrl` (each with a redaction-test row).
- **Database privileges:** least privilege by role split (A13, A14). `audit_logs_ensure_partitions` is the only
  `SECURITY DEFINER` object: integer argument bounded 0–12, `search_path = pg_catalog, pg_temp`, every identifier
  schema-qualified and `%I`-quoted, `EXECUTE` revoked from `PUBLIC` and granted to `vcare_app` only, `lock_timeout` 200 ms (migration 5; was 2 s).
  The app role can call it (idempotent and bounded); it cannot create anything else.
- **Token handling:** `alg` pinned to `EdDSA`; key chosen by `kid` only from Identity's set; `crit`/`b64` handled by
  jose; tokens > 4 096 chars rejected before parsing; the per-minute demand-fetch gate stops random-`kid` tokens from
  turning Care into a JWKS request amplifier.
- **Rate limits:** none added; health is never rate-limited. Modules mount limiters per §3.2.
- **Files:** none.
- **`ensure-app-login`:** the password travels once per run to the owner session inside a `CREATE/ALTER ROLE`
  statement; it is never written to Care's logs. A server-side `log_statement = 'ddl'` or `'all'` would log it: keep
  it off for the provisioning run (runbook follow-up).

---

## 8. Performance
| Path | Cost | Budget |
|---|---|---|
| `userGuard` (steady state) | 0 network, 0 DB, 0 Redis; one Ed25519 verify (tens of µs) | negligible against every route budget |
| `userGuard` (unknown `kid`) | at most one gated JWKS fetch per 60 s per task, ≤ 2 s; other requests in that window answer 401 at once | — |
| `authorize` | 0 queries for `none`/`self` and no checks; +1 indexed query per resolver and per applicable check (module-supplied) | modules count them in their route's query budget |
| `audit.record` | 1 `INSERT` into the current month's partition (PK index only) | < 2 ms, inside the caller's budget (booking < 200 ms) |
| readiness | unchanged probes + an in-memory `status()` read | unchanged (< 1 s) |
| worker tick (daily) | 1 transaction (lock + function) + 1 bounded `LIMIT 1001` count | `lock_timeout` 200 ms (ATTACH: never blocks inserts), statement timeout 5 s |
| Redis breaker open (§12.3) | 0 Redis round trips on idempotency/rate-limit until the half-open probe | removes the 500 ms per-command stall of #10 |

Partition pruning keeps audit inserts and future time-bounded reads on one partition (ADR 0009). No query of this
unit needs a secondary index.

---

## 9. Test plan outline
Names follow `should <do something> when <condition>`. Unit tests mock collaborators (fetcher, clock, Knex, Redis,
logger). Integration tests use the real wiring, real Postgres 17 (as `care_app` for the app, `care` only for
setup/teardown/grant assertions), real Redis, and a **fake JWKS HTTP server**; only Identity is faked.

### 9.1 Helpers
| File | Exports |
|---|---|
| `tests/helpers/tokens.ts` | `generateSigningKey(kid)` (fresh Ed25519 per call; no key in the repo) · `signUserToken(key, overrides?, options?)` — defaults `{ iss: "vcare-identity", aud: ["vcare-identity","vcare-care"], sub: "101", typ: "user", role: "patient", status: "active", ev: true, jti: <uuid>, iat: now, exp: now + 900 }`, header `{ alg: "EdDSA", kid, typ: "JWT" }`; overrides may delete claims · `signExpiredUserToken` · `tamperToken(token)` (flips a payload byte, keeps the signature) |
| `tests/helpers/fake-jwks.ts` | `startFakeJwks(kids)` on `startFakeHttpServer` with a mutable route: `{ jwksUrl; keys; addKey(kid); removeKey(kid); setBody(raw); setMode(mode, options); requests; close() }` · `withFakeJwksCache(fake, fn)` — `withContainerOverrides` for `TOKENS.JwksCache` and `TOKENS.UserTokenVerifier` built on `fake.jwksUrl` |
| `tests/helpers/db.ts` | `ownerDb` (lazy `createKnex` on `MIGRATION_DATABASE_URL`, `applicationName: "care-test"`) · `truncateAll(conn = ownerDb)` now lists parents only (`pg_class.relkind IN ('r','p') AND NOT relispartition`, schema `public`, excluding `knex_migrations*`) and truncates them `RESTART IDENTITY` (partitions go with their parent; `care_app` has no `TRUNCATE`) · `closeDb()` also destroys `ownerDb` |
| `tests/helpers/test-routers.ts` | `buildAccessTestRouter()`, `buildAuditTestRouter()`, `buildNestedRouter()`, `buildParamRouter()` (§9.3) |
| `tests/integration/global-setup.ts` | migrates with `MIGRATION_DATABASE_URL`, then `ensureAppLogin(owner, DATABASE_URL)` |

Synthetic fixtures for log assertions: the foundation's `SYNTHETIC-COMPLAINT-7731`, `synthetic.patient@example.test`,
plus every signed token string used in a suite.

### 9.2 Unit tests (`tests/unit/`)
- `lib/auth/jwks-cache.test.ts` (fake fetcher, fake clock, fake timers): should fetch once at start and every 5 min when started (A4) · should share one fetch when refreshes overlap (A4) · should fetch at most once per 60 s when unknown kids arrive repeatedly (A4) · should count a failed attempt toward the 60 s gate (A4) · should refetch once and return the key when an unknown kid appears after rotation (A4) · should keep the previous set when the response is malformed, has duplicate kids, more than 16 keys, or a non-Ed25519 key (A6) · should drop a removed kid when a refresh succeeds (A6) · should return keys between 5 min and 1 h old and start a background refresh without awaiting it (A5) · should return undefined when the set is older than 1 h and the fetch fails (A5) · should log jwks_keys_expired once per crossing (A5) · should report up only when the set is younger than 1 h and the last attempt succeeded (A7) · should log host and reason but never the path or body when a fetch fails · should abort an in-flight fetch when stopped.
- `lib/auth/jwks-fetcher.test.ts` (local `node:http` server): should reject a redirect, a non-JSON content type, a body over 64 KiB, and invalid JSON with the matching reason · should time out after 2 s · should send X-Request-Id from the request context, else a generated UUID.
- `lib/auth/user-token-verifier.test.ts`: should return the AuthContext when the token is valid (A2) · should throw Unauthorized when the signature, iss, aud, typ, alg, or kid is wrong (A2) · should throw Unauthorized when sub, exp, iat, or jti is missing or sub is not a positive safe integer (A2) · should throw Unauthorized when role, status, or ev has the wrong shape (A2) · should throw TokenExpired when exp + 30 s has passed (A3) · should accept a token 29 s past exp (A3) · should throw Unauthorized when an alg=none or HS256 token is presented (A2) · should throw Unauthorized and log token_verification_error when the key source throws unexpectedly (A5).
- `lib/auth/user-guard.test.ts`: should return Unauthorized when the header is missing, not Bearer, has two tokens, or exceeds 4 096 chars · should set req.auth and the request-context userId and role when verification succeeds · should ignore X-User-Id and X-Role (A1) · should carry GUARD_MARKER.
- `lib/rbac/authorize.test.ts`: should throw route_without_policy when the policy is undefined (A8) · should throw policy_invalid for each invalid shape incl. a status list containing suspended (A8) · should return 401 when req.auth is missing · 403 when the role is not listed · 403 when the status is not allowed for that role, with active as the default · 403 when the token status is suspended even for onboarding policies · 403 EmailNotVerified when emailVerified is required and ev is false · run only checks that apply to the role and deny with Forbidden · 404 on deny-not-found and 403 on deny-forbidden · 403 on an unknown decision value · run status, email, and checks before the ownership resolver (A9) · pass only auth and params to resolvers and checks (A10) · log access_denied with a reason and no ids.
- `lib/rbac/assert-routes-authorized.test.ts`: should throw route_without_policy naming method and path when a route lacks authorize (A8) · should throw route_without_guard when authorize precedes the guard · should walk nested routers · should skip probe-exempt routers · should pass when every route is guarded and authorized. · (review 2026-10-03, H1) handler_before_authorize (between guard and authorize; before the guard) · middleware_without_policy for a terminal `router.use(path, fn)` and unmarked middleware; pass for `markPreAuth`/error handlers · walk a sub-app mounted with `router.use`; throw for `app.use`'s `mounted_app` · per-method `router.route()` chains in both orderings · `.all` entries in every chain. · (round 2) param_callback_without_policy for `router.param` in a module router, `app.param` on the root, `app.param` on a mounted sub-app, and a probe-exempt router; pass guarded `:param` routes with no param callback.
- `lib/rbac/roles.test.ts`: should keep ROLES and ACCOUNT_STATUSES equal to the lib/types unions.
- `lib/audit/audit.test.ts` (fake trx): should insert one row with explicit columns and the context request id (A11) · should throw audit_requires_transaction when given a non-transaction connection (A11) · should map user, service, and system actors to actor_user_id/actor_role (A12) · should reject a bad action, entityType, entityId, metadata key, nested value, oversize string, oversize object, or a REDACTED_KEYS key (A12) · should log audit_write_failed and emit the metric without metadata, then rethrow, when the insert fails.
- `lib/audit/partition-loop.test.ts` (fake Knex): should skip and log locked_elsewhere when the advisory lock is not acquired · should log created partitions and emit audit_partition_missing 0 · should log audit_partition_missing and emit 1 without rethrowing when the function fails (A16) · should still run the default-partition check after a failure · should warn and emit the row gauge when the default partition is non-empty (A16) · should return immediately when the signal is aborted.
- `lib/config/env.test.ts`: should require IDENTITY_JWKS_URL · should reject a non-http(s) IDENTITY_JWKS_URL · should accept a missing MIGRATION_DATABASE_URL in envSchema and require it in getMigrationEnv · should reject MIGRATION_DATABASE_URL when it uses the same user as DATABASE_URL (A14) · should apply the same query-string refines to MIGRATION_DATABASE_URL · should bound AUDIT_PARTITION_MONTHS_AHEAD to 1..12 and default it to 2.
- `lib/knex/app-login.test.ts`: should build CREATE ROLE through format() when the login is absent · should ALTER and GRANT when present · should reject a URL without a password or with an invalid user name without echoing it · should log only created. · (review 2026-10-03) refuse privileged / object-owner / other-role-member rows with app_login_role_privileged and run no DDL · code-less DDL and role-check failures → app_login_ddl_failed without the password or login name · SQLSTATE kept.
- `app/health/health.service.test.ts`: should report identityJwks up/down from the cache and keep status and httpStatus unchanged in every Postgres/Redis/shutdown combination (A7).
- `pkg/utils/id.test.ts`: should parse 1 and 9007199254740991 · should reject 0, leading zeros, signs, decimals, 17 digits, and unsafe integers.
- `lib/logger/redact.test.ts`: one row per new key (`connectionString`, `databaseUrl`, `migrationDatabaseUrl`).
- `lint/restricted-imports.test.ts`: should report jose outside lib/auth, undici outside jwks-fetcher, and global fetch in src.
- Foundation-fix units: §12.

### 9.3 Test-only routers (integration; mounted at `/api` through `extraRouters`)
| Route | Guard | Roles | Ownership | Account state / checks | Idempotency |
|---|---|---|---|---|---|
| `GET /api/__test/access/any` | `userGuard()` | patient, doctor, admin | none | default (`active`) | — |
| `GET /api/__test/access/admin` | `userGuard()` | admin | none | default | — |
| `GET /api/__test/access/onboarding` | `userGuard()` | doctor | self | doctor: `pending, active, rejected` | — |
| `POST /api/__test/access/verified` | `userGuard()` | patient | self | `emailVerified: true` | optional (`idempotency({ required: false })`, proves the principal is `user:<id>`) |
| `GET /api/__test/access/owned/:id` | `userGuard()` | patient, doctor | resolver `test_owner`: real query `SELECT owner_user_id FROM (VALUES (1, 101), (2, 102)) AS t(id, owner_user_id) WHERE id = ?` with `parsePositiveId(params.id)`; no row or patient non-owner → `deny-not-found`; doctor non-owner → `deny-forbidden` | default | — |
| `GET /api/__test/access/checked` | `userGuard()` | doctor, admin | none | check `test_blocked_doctor` (`appliesTo: ["doctor"]`, real query `SELECT ? = ANY (ARRAY[9001]) AS blocked`) | — |
| `POST /api/__test/audit` | `userGuard()` | admin | none | default; `audit: "admin-action"` | — |
| `GET /api/__test/nested/inner/boom/:id` | none (sealed router only) | — (test-only, exercises #6 without a guard) | none | — | — |
| `GET /api/__test/nested/guarded/boom/:id` | `userGuard()` | admin | none | default | — |
| `GET /api/__test/params/:value` | `userGuard()` | patient | none | default | — |

`POST /api/__test/audit` body `{ fail?: boolean }`: `db.transaction(async (trx) => { await audit.record(trx, { actor:
actorFromAuth(req.auth), action: "test.performed", entityType: "test_entity", entityId: 1, metadata: { reason:
"synthetic" } }); if (fail) throw new Error("synthetic rollback"); })` → 201 or 500.

### 9.4 Integration tests (`tests/integration/`)
- `auth.test.ts` (fake JWKS): should return 200 with the token's userId and role for a patient, a doctor, and an admin (A2) · should return 401 Unauthorized with no token, a non-Bearer scheme, a tampered token, a wrong aud, a wrong iss, typ=service, or an unknown kid (A2) · should return 401 TokenExpired for an expired token (A3) · should ignore X-User-Id and X-Role headers (A1) · should accept a token signed by a newly added key after exactly one extra JWKS request (A4) · should make at most one JWKS request for two unknown-kid requests within a minute (A4) · should reject a token whose kid was removed after the next refresh (A6) · should keep verifying with cached keys when the JWKS server fails (A5) · should return 401 when the JWKS server is down and no key matches (A5) · should forward X-Request-Id on a request-triggered JWKS fetch.
- `rbac.test.ts` (routes of §9.3; RBAC matrix — CLAUDE.md → Testing policy "RBAC per route"): for each route × {no token, patient, doctor, admin} assert 401/403/200 per the table (A9) · onboarding: pending/rejected doctor 200, suspended doctor 403, pending patient 403 · verified: ev=false 403 EmailNotVerified, ev=true 201 · owned: owner 200, patient non-owner 404, doctor non-owner 403, unknown id 404, non-numeric id 404 · owned with a body `{ "ownerUserId": 101 }` from a non-owner still 404 (A10) · checked: doctor 9001 403, other doctor 200, admin 9001 200 (check does not apply) · pending patient on `owned/:id` gets 403 before any ownership query (A9).
- `boot.test.ts`: should throw route_without_policy from createPublicApp when buildPublicRoutes returns an unpoliced route (module mock) (A8) · should throw route_without_guard likewise · should start with test routers that lack authorize because extraRouters are mounted after the check (A8) · should keep health reachable without a token on both listeners. · (H1) middleware_without_policy and handler_before_authorize through the real createPublicApp. · (round 2) param_callback_without_policy through the real createPublicApp.
- `audit.test.ts`: should write exactly one row with actor, action, entity, request id, and metadata when the transaction commits (A11) · should leave no row when the transaction rolls back (A11) · should return 500 and write no row when the metadata is invalid (A12) · should reject UPDATE, DELETE, and TRUNCATE on audit_logs, audit_logs_default, and a monthly partition with 42501 as care_app (A13) · should allow INSERT and SELECT as care_app (A13) · should reject a metadata object over 4 KB at the database (A12) · should reject a user actor without a user id at the database (A12).
- `db-roles.test.ts`: should connect the request pool as care_app with vcare_app membership (A14) · should deny CREATE TABLE in public and ALTER TABLE audit_logs to care_app (A14) · should deny EXECUTE on audit_logs_ensure_partitions to a role outside vcare_app (owner creates a throwaway role) · should pin the function's search_path and SECURITY DEFINER (`pg_proc.prosecdef`, `proconfig`) · should make ensureAppLogin idempotent and resync the password on a second run. · (review 2026-10-03) column-level INSERT on the parent and every partition; care_app `INSERT … (created_at)` / `(id)` → 42501 while `AuditRecorder.record` inserts (L2) · `ensureAppLogin` refuses a pre-existing CREATEDB login (L1) · (round 2) refuses a pre-existing login that is a member of the owner role / `pg_write_all_data`, membership untouched · function `lock_timeout=200ms`.
- `migrations.test.ts` (updated): should create partitions for the current UTC month and the next two after migrate latest · should round-trip rollback and latest for every migration (the existing btree_gist case now rolls back the whole batch; its `finally` re-runs `latest` and `ensureAppLogin`, because dropping `vcare_app` removes `care_app`'s membership) · should keep vcare_app when another database still references it (DROP ROLE guarded).
- `worker-partitions.test.ts` (real Postgres, two Knex pools as care_app): should create the configured months and grant them when a month is missing (owner drops a future partition first) (A15) · should create nothing on a second tick (A15) · should complete two concurrent ticks from two pools with one partition set and no error (A15) · should skip when another session holds the advisory lock, then create once it is released (A15) · should report audit_default_partition_nonempty with rows when a far-future row lands in the default partition (A16) · should report audit_partition_missing when a default-partition row blocks a new month (A16) · should run one tick and exit 0 for `worker --once audit-partitions`, and exit 1 for an unknown loop (child process; skipped on win32 like the foundation process tests). · (review 2026-10-03) `--once` exits 1 with `worker_once_incomplete` when a default row blocks a month or the lock is held (L4) · a concurrent audit insert completes < 200 ms while a tick attaches a month under an open audit transaction (L3).
- `health.test.ts` (updated): should include identityJwks up when the fake JWKS served keys (A7) · should report identityJwks down and keep 200 ok when the JWKS fetch failed (A7) · should report identityJwks down and keep 503 down when Postgres is down · should match the updated contract HealthStatus on both listeners (contract conformance).
- `logs.test.ts` (updated): should never contain a token, a token signature, the Authorization header, the JWKS path, or an audit metadata value in captured logs across all auth, rbac, audit, and JWKS-failure scenarios.
- Contract conformance: every 401/403/404 body above is validated against `ErrorEnvelope` with a `code` from `ErrorCode`.

### 9.5 Mandatory scenarios (CLAUDE.md → Testing policy) that apply
RBAC per route (wrong role, non-owner 404/403, owner allowed) — via §9.3 routes · logs contain no clinical fixture
strings · every audit write is in the caller's transaction. Not applicable (no business routes, no Identity Case
1–4 calls, no files): concurrent booking, Case 1–3 outages, record lock, slot budget, uploads, download URLs.
**Admin denied on every clinical route** has no clinical route to apply to yet; `authorize` makes it a one-line policy
rule for the records/patients modules.

### 9.6 Regression tests for the foundation fixes — §12.

### 9.7 Manual QA (`/manual-qa access`, real local Identity — brainstorm decision 2026-10-02)
Identity `feature/auth` (or `main` once merged) running locally (previously on 3020/3120 on this machine; set
`IDENTITY_JWKS_URL` accordingly); sign up and log in a patient and a doctor, create the admin per identity's runbook;
run `scripts/access-qa-server.ts`; CURL `GET /api/__test/access/any` with each token (200), `/api/__test/access/admin` with the patient
(403), no token (401); `GET /api/health/ready` shows `identityJwks: up`, then `down` within 5 min of stopping Identity
(still 200). Edge-case tokens are integration-test only. Record no tokens in `manual-qa.md`.

---

## 10. Out of scope
- Service guard, `ServiceTokenRequired`, `InsufficientScope`, the `service` policy kind — doctors module.
- `lib/identity-client`, real ownership resolvers, the `doctor_not_suspended` check — doctors and later modules.
- `GET /audit-logs`, the audit read model, and its three read indexes (decision D1, §14.1) — `audit` module.
- Any business table or public route, including specialties.
- Foundation gaps routed elsewhere: #7 cursor µs, #8 implicit boolean conversion, #9 rate-limit member →
  `specialties`; #12–#17 at their own triggers (#15 is adjacent to #6 and stays open).
- Archiving or detaching partitions older than 6 years (ops procedure, ADR 0009).
- An "audit row was written" runtime check for `audit: "clinical-*"` policies (the class stays declarative; per-route
  integration tests prove the row).

---

## 11. Open questions

None. The user decided every question of the first draft on 2026-10-02. The decision (D1), the contract edits
(C1, C2), and the applied platform and CLAUDE.md changes are recorded in §14.

---

## 12. Fixes foundation issues #5 #6 #10 #11
Foundation [spec §13.3](../foundation/spec.md#133-known-latent-gaps-deferred-not-fixed) text is quoted for each; the
PR closes the four issues. Foundation §13.3 and `resilience.md` mark them fixed at `/update-docs access`.

### 12.1 [#5](https://github.com/OmarRedaX/vcare-care-api/issues/5) — malformed path parameter → 500
> "a malformed percent-encoded path parameter (router `URIError`, or any non-`AppError` with a 4xx `status`) is treated
> as unknown: `500 InternalError` and an `unhandled_error` log line with the raw value" — fix before "the first
> `:param` route".

**Fix (`lib/error/errorHandler.ts`, after the body-parser mapping):**
| Input | Status | Code | `details` | Logged |
|---|---|---|---|---|
| `URIError` (Express 5's router `decodeParam` sets `status = 400` and puts the raw value in the message) | 400 | `ValidationFailed` | `[{ field: "path", issue: "must be valid percent-encoding" }]` | no |
| other non-`AppError` with numeric `status`/`statusCode` 400–499: 404 | 404 | `NotFound` | `[]` | `warn client_error_mapped` `{ name, status }` (never `message`) |
| other non-`AppError` with numeric `status`/`statusCode` 400–499 | 400 | `ValidationFailed` | `[{ field: "request", issue: "could not be processed" }]` | `warn client_error_mapped` `{ name, status }` |
| anything else | unchanged (500 `InternalError`, `unhandled_error`) | | | |

Regression: unit `errorHandler.test.ts` — should map a URIError to 400 ValidationFailed with the path detail and no
log · should map a non-AppError with status 404 to NotFound and other 4xx to ValidationFailed without echoing the
message · should keep 500 for a non-AppError without a 4xx status. Integration `envelope.test.ts` —
`GET /api/__test/params/%E0%A4%A` with a valid token → 400 `ValidationFailed`, and captured logs contain neither
`unhandled_error` nor `%E0%A4%A`.

### 12.2 [#6](https://github.com/OmarRedaX/vcare-care-api/issues/6) — route label loses the mount prefix
> "when a handler throws inside a nested router, `request_completed.route` loses the mount prefix (`/boom/:id`),
> corrupting route-keyed metrics" — fix before "the first module that mounts routes".

**Fix (`lib/http/route-pattern.ts`, identity parity):**
```ts
export function captureRoute(req: Request, res: Response): void;   // first capture wins: res.locals.routePattern = req.baseUrl + req.route.path
export function sealRouter(router: Router): Router;                // appends an error middleware that captures, then next(err)
export function routePattern(req: Request): string | undefined;    // res.locals.routePattern first, else baseUrl + route.path
```
`captureRoute` runs in `userGuard`, `authorize`, `rateLimit`, `idempotency`, and the sealed router's error layer —
each at a point where `req.baseUrl` still carries the full prefix. Every module `routes.ts` and the health router
return `sealRouter(router)`. `routeLabel` is unchanged (it reads `routePattern`).

Regression: unit `route-pattern.test.ts` — should keep the first captured pattern · should prefer the captured
pattern over the live baseUrl. Integration `logs.test.ts` — `GET /api/__test/nested/inner/boom/42` and
`/api/__test/nested/guarded/boom/42` (handler throws) → `request_completed.route` equals `/api/__test/nested/inner/boom/:id` and
`/api/__test/nested/guarded/boom/:id`.

### 12.3 [#10](https://github.com/OmarRedaX/vcare-care-api/issues/10) — no breaker for a stalled-but-ready Redis
> "a Redis that stalls while connected keeps `status === "ready"`, so every command waits the full 500 ms
> `commandTimeout` (no breaker); §8's 'at most one failed command's latency' holds only for a hard disconnect" — fix
> before "the first route using rate-limit or idempotency".

**Fix (`lib/redis/breaker.ts` + `lib/redis/redis.ts`):**
```ts
export class RedisBreaker {
  constructor(options?: { failureThreshold?: number /* 3 */; openMs?: number /* 5_000 */; now?: () => number });
  canAttempt(): boolean;   // closed → true; open before openMs → false; open after openMs → half-open: true for ONE caller
  recordSuccess(): void;   // → closed; logs info redis_breaker_closed on a transition
  recordFailure(): void;   // consecutive++; ≥ threshold, or any failure while half-open → open;
                           // logs warn redis_breaker_open + metric("redis_breaker_open", 1) once per transition
  readonly state: "closed" | "open" | "half_open";
}
export function breakerFor(client: Redis): RedisBreaker;        // one per client (WeakMap)
export function isRedisUsable(client: Redis): boolean;          // isRedisReady(client) && breakerFor(client).canAttempt()
export function withRedis<T>(client: Redis, command: () => Promise<T>): Promise<T>;
      // records success/failure on the client's breaker; every Redis call in idempotency and rate-limit goes through it
```
`REDIS_BREAKER_FAILURE_THRESHOLD = 3`, `REDIS_BREAKER_OPEN_MS = 5_000` (constants, not env). `idempotency` replaces
`isRedisReady` with `isRedisUsable` and skips with `reason: "redis_breaker_open"`; `rateLimit` degrades to the memory
limiter. The readiness `PING` probe is independent (its own 500 ms bound) and does not feed the breaker. The worst
case becomes `3 × 500 ms` per 5 s window per process instead of 500 ms on every command.

Regression: unit `breaker.test.ts` — should open after 3 consecutive failures · should reset the count on success ·
should admit exactly one half-open probe after openMs · should close on a successful probe and reopen on a failed one ·
should log and emit the metric once per transition. Integration `redis-stall.test.ts` (Redis through the existing
`black-hole-proxy` helper: connected, then black-holed while `status` stays `ready`) — after 3 slow requests, the next
idempotency and rate-limited requests complete in < 100 ms with `idempotency_skipped{reason:"redis_breaker_open"}` and
`rate_limiter_degraded`; after the proxy forwards again and 5 s pass, Redis is used again.

**Socket timeout (review 2026-10-03, M2).** `createRedis` also sets `socketTimeout: REDIS_SOCKET_TIMEOUT_MS` (2 000 ms;
`REDIS_COMMAND_TIMEOUT_MS = 500` < socket 2 s < `REDIS_BREAKER_OPEN_MS` 5 s; constants, not env): a connection with
commands outstanding that receives no byte for 2 s is destroyed and `retryStrategy` redials, so a half-open socket
(un-RST failover) recovers within seconds instead of ~15 min and the half-open probe lands on the fresh connection.
The breaker does not disconnect on open (it also opens on slow-but-alive replies). `redis-stall.test.ts` no longer
disconnects the client itself: it asserts `redis_breaker_closed` within `REDIS_SOCKET_TIMEOUT_MS +
REDIS_BREAKER_OPEN_MS + 3 s`, a new proxied connection, and `redis_recovered`.

### 12.4 [#11](https://github.com/OmarRedaX/vcare-care-api/issues/11) — malformed idempotency record crashes the process
> "a stored `done` record without a numeric `status` makes `replay()` throw inside an unguarded async block →
> `unhandledRejection` → shutdown with exit 1 (same pattern in the rate-limit middleware)" — fix before "the first
> route using idempotency".

**Fix:**
- `idempotency-store.ts`: `readRecord` returns `{ kind: "absent" } | { kind: "valid"; record } | { kind: "invalid"; raw }`
  through a shape guard: `done` needs `bodyHash` (64 hex), integer `status` 100–599, and a `body` member;
  `in_progress` needs `bodyHash` and a string `owner`; unparsable JSON is `invalid` (today it is read as "absent",
  which answers `409 Conflict` to every retry until the 24 h TTL).
- `idempotency.ts`: `invalid` → compare-and-delete of exactly that raw value (`DEL` iff `GET` still equals it), log
  `warn idempotency_record_invalid` `{ route }`, `metric("idempotency_skipped", 1, { reason: "invalid_record" })`,
  then `next()` (handler runs; DB-level guarantees apply, like row 5 of foundation §3.4.10). `replay` validates
  before writing the response.
- Both async blocks (idempotency, rate-limit) end in a terminal `.catch(fail)`: `fail` calls `next(err)` once if no
  response was started and `next` was not yet called, else logs `error idempotency_internal_error` /
  `error rate_limit_internal_error`. No promise in either middleware can reject unobserved.

Regression: unit `idempotency.test.ts` — should treat a done record without a numeric status as invalid, delete it,
and call next · should treat unparsable JSON as invalid instead of answering 409 · should not delete a record that
changed between read and delete · should forward an unexpected throw to next exactly once. Unit
`rate-limit.test.ts` — should forward an unexpected throw in the degrade path to next exactly once. Integration
`idempotency.test.ts` — with `{"state":"done","bodyHash":"<hash>"}` and with `garbage` stored under the computed key:
the request returns the handler's 201, no `unhandledRejection` listener fires, the process stays up, and a second
request with the same key stores and then replays normally.

---

## 13. Required follow-ups (decided; not open)

### 13.1 Written during `/develop access`
- **ADR 0018 — Database owner/app role split, explicit grants, and the `SECURITY DEFINER` partition function**
  (service decision of 2026-10-02; records why the worker does not get the owner credential and why the advisory lock
  is transaction-scoped).
- `.claude/skills/write-migration/SKILL.md`: every table migration grants `vcare_app` explicitly (no
  `ALTER DEFAULT PRIVILEGES`); append-only tables get `INSERT, SELECT` only plus `USAGE` on their sequence; the
  "Append-only tables" section's `REVOKE UPDATE, DELETE ON audit_logs FROM vcare_app` example becomes the explicit-grant form;
  partitioned tables grant the parent and the `DEFAULT` partition.
- `.claude/skills/rbac-ownership-guard/SKILL.md`: the `Policy` sketch matches §3.4.1 (`kind`, `accountState.statuses`
  per role, `checks`, step order of §3.4.3, `Forbidden` for any disallowed status).
- **Hub observability item (platform scope, docs task):** the **`IdentityJwksStale`** alert (page when
  `jwks_cache_age_s` > 1 800; cached keys are distrusted at 3 600, after which every authenticated Care request is
  401) with its metric belongs in hub `architecture/deployment.md` → Observability. List it as a platform delta in the
  PR description; the orchestrator applies it to the hub when the code lands (only `/system-design` edits hub docs).
  Care's own metric rows and runbook entry follow in §13.2.

### 13.2 `/update-docs access`
- `architecture/infrastructure.md`: implemented variables (§3.10); `JWT_ISSUER`/`JWT_AUDIENCE` dropped (constants);
  `IDENTITY_JWKS_URL` has no default; worker pool row; DB roles paragraph replaces the one-line "application role (`vcare_app`)"
  bullet under Database connection; readiness body with `identityJwks`.
- `architecture/data-model.md`: `audit_logs` with the added checks, explicit grants, sequence grant, the function, and
  decision D1 (read indexes ship with the `audit` module); built-so-far line.
- `architecture/rbac.md`: Principles 3 order (§3.4.3); policy shape; `suspended` → `Forbidden`.
- `architecture/overview.md`: JWKS cache lives in `lib/auth`, not identity-client; built `lib/` pieces.
- `architecture/resilience.md`: JWKS row (5-min refresh, 1 h cap, per-minute gate); #10 and #11 no longer "not yet
  fixed"; Redis breaker in the Redis section.
- `architecture/deployment.md` → Observability: metrics `jwks_refresh_failed` (`reason`), `jwks_cache_age_s`,
  `audit_partition_missing`, `audit_write_failed` (`action`), `redis_breaker_open`; an `IdentityJwksStale` row linking to the
  hub alert (§13.1); `AuditPartitionMissing` reads `audit_partition_missing` too.
- `runbook.md`: `IdentityJwksStale` and `jwks_refresh_failed`; `AuditPartitionMissing` (now with
  `--once audit-partitions` actually implemented; moving default rows); `AuditWriteFailures` grant check names
  `vcare_app`; `ensure-app-login` (and `log_statement` off while it runs); `route_without_policy` /
  `route_without_guard` / `policy_invalid` boot lines.
- `quickstart.md`: env split, `npm run migrate:ensure-app-login`, migrating an existing dev volume in place, pointing
  `IDENTITY_JWKS_URL` at the local Identity.
- `foundation/spec.md` §1.4 (parity exception), §13.3 (#5 #6 #10 #11 fixed by `access`).
- `docs/service-card.md` (**service card affected**): status line, the two DB roles, the JWKS dependency row (5-min
  refresh, 1 h stale cap, 401 when no key), readiness body; then the hub sync.

---

## 14. Decisions, contract changes, and platform changes (2026-10-02)

### 14.1 Decisions
- **D1 — The `audit_logs` read indexes are deferred to the `audit` module** (user decision, 2026-10-02). CLAUDE.md →
  Database rules: "Indexes exist only for a query in code". The only query they serve (`GET /audit-logs`) arrives
  with that module, and nothing is in production, so building them later costs nothing. Rejected: creating them here
  as a documented exception; creating them `ON ONLY` the parent and attaching them later.

**Hand-off for the `audit` module** (its `/brainstorm` and `/construct-spec` pick this up):
- One migration creates the three indexes of `data-model.md` on the partitioned parent. Indexes on the parent cascade
  to every existing and future partition, including `audit_logs_default`. Each is commented with its `listAuditLogs`
  query:
  ```sql
  -- GET /audit-logs?entityType=&entityId= newest first
  CREATE INDEX idx_audit_logs_entity_type_entity_id_created_at ON audit_logs (entity_type, entity_id, created_at DESC, id DESC);
  -- GET /audit-logs?actorUserId= newest first
  CREATE INDEX idx_audit_logs_actor_user_id_created_at ON audit_logs (actor_user_id, created_at DESC, id DESC);
  -- GET /audit-logs (unfiltered, or action/time-range filtered) newest first
  CREATE INDEX idx_audit_logs_created_at_id ON audit_logs (created_at DESC, id DESC);
  ```
- `CREATE INDEX` on a partitioned parent cannot run `CONCURRENTLY`. If `audit_logs` is already large when the module
  ships, that spec decides whether to build per partition `CONCURRENTLY` and attach them to an index created `ON ONLY`
  the parent.
- Reads stay time-bounded (ADR 0009) so partition pruning applies. `vcare_app` already holds `SELECT` on the parent
  and every partition, so no new grant is needed.

### 14.2 Contract changes (decided — applied in `/develop` step 0, then hub sync)
Additive edits to `contracts/openapi.yaml`; no new operation. `/develop access` applies them first (CLAUDE.md → Build
order for a new module, step 0), then runs `../vcare-hub/scripts/sync-from-spoke.sh` (the hub copy is never
hand-edited).

- **C1 — `checks.identityJwks`** (decided by the user 2026-10-02). In `components.schemas.HealthStatus`, replace the
  `checks` property and the `example` with:
  ```yaml
        checks:
          type: object
          required: [database, redis]
          properties:
            database:
              type: string
              enum: [up, down]
            redis:
              type: string
              enum: [up, down]
              description: Reported only; Redis is Tier 2 and never fails readiness.
            identityJwks:
              type: string
              enum: [up, down]
              description: >-
                Reported only; never fails readiness. `up` when the in-memory JWKS cache holds a key set younger than
                1 h and the latest refresh succeeded. The probe makes no network call.
      example: { status: degraded, checks: { database: up, redis: down, identityJwks: up } }
  ```
  `required` stays `[database, redis]`. The top-level `additionalProperties: false` is untouched, because the field
  sits inside `checks`. In the `description` of both `getPublicReadiness` and `getInternalReadiness`, replace
  `Identity is not a dependency.` with
  `Identity is not a dependency; the Identity JWKS cache state is reported in checks.identityJwks (informational, no network call).`
- **C2 — `bearerUser` wording** (follows the decided cache policy). In
  `components.securitySchemes.bearerUser.description`, replace the line
  ```
  `IDENTITY_JWKS_URL` (cached; refreshed on unknown `kid` at most once per minute). Required claims:
  ```
  with
  ```
  `IDENTITY_JWKS_URL` (cached in memory; re-fetched once older than Identity's 5-minute `max-age` and on an unknown
  `kid` at most once per minute; while refreshes fail, cached keys stay trusted for at most 1 hour after the last
  successful fetch). Required claims:
  ```
- **C3 — `bearerUser` claims (applied 2026-10-03, review D1).** The required-claims line now lists what the verifier
  already enforced: header `alg=EdDSA`; `sub`, `exp`, `iat`, `jti` (≤ 64 chars), `role`, `status`, `ev`; `exp`/`nbf`
  with a 30 s tolerance; expired → `401 TokenExpired`, otherwise `401 Unauthorized`. No behaviour change; the hub copy
  was re-synced.

### 14.3 Platform changes (applied 2026-10-02)
The orchestrator applied these; this spec does not edit them. They are listed so `/update-docs` and reviewers can
check alignment.
- **Hub `architecture/deployment.md` → Release pipeline step 3.** The migrate task uses the owner credential, and the
  API and worker tasks use the app credential (`care` / `care_app` in `vcare_app`). `care-migrate` runs `latest`, then
  `ensure-app-login`, with both secrets (owner and app). The owner role holds `CREATEROLE` (user decision P1 → A).
- **Hub `architecture/landscape.md` and `data-ownership.md`.** Care re-fetches the JWKS every 5 minutes (Identity's
  `max-age=300`), on an unknown `kid` at most once per minute, and trusts cached keys for at most 1 hour without a
  successful refresh.
- **Identity `docs/architecture/deployment.md`.** The JWKS row reflects the consumer's 1 h cap: an Identity JWKS
  outage longer than 1 h makes Care reject every user token.

### 14.4 CLAUDE.md (applied 2026-10-02 with the user's approval)
This spec matches the current CLAUDE.md wording:
- **Authentication and service-to-service auth:** the JWKS is "re-fetched once older than Identity's 5-minute
  `max-age` and on an unknown `kid` at most once per minute; while refreshes fail the cached keys stay trusted for at
  most 1 hour after the last successful fetch, then none are". §3.3.4 implements exactly this.
- **Database rules → Two database roles:** migrations run as the owner (`MIGRATION_DATABASE_URL`); `care-api` and
  `care-worker` log in as `care_app`, a member of `vcare_app` (`DATABASE_URL`), and never hold the owner secret.
  Every table migration grants to `vcare_app` explicitly (no `ALTER DEFAULT PRIVILEGES`). Append-only tables get
  `INSERT, SELECT` only. `care-migrate` runs `ensure-app-login` after `latest`. §2.1, §2.2, §3.8, and §3.10 implement
  exactly this. The `USAGE` grant on a table's own sequence (`audit_logs_id_seq`) belongs to its `INSERT` grant: it is
  not a table privilege.
