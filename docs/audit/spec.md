---
title: audit — Spec
owner: care-team
service: care-service
module: audit
status: ready
version: 1.0.0
diataxis: reference
last_verified: 2026-10-09
tags: [spec, audit, audit-logs, pagination, keyset, partitions, indexes, explain, rbac]
related: [audit-brainstorm, access-spec, specialties-spec, verification-spec, admin-doctors-spec, data-model, api, adr-0009-audit-logs-monthly-partitions, adr-0018-db-role-split-explicit-grants-partition-function]
contracts: [contracts/openapi.yaml]
---

# audit — Spec

The read side of the audit trail: one admin-only route, `GET /api/audit-logs`, over the append-only, monthly-partitioned
`audit_logs` table that the `access` base created and every module writes through `lib/audit`. This module adds **no
table and no write path**: it adds one migration (the three read indexes whose creation `access` decision D1 deferred
to here), the `src/app/audit/` read module, and one DTO decorator.

Scope follows [brainstorm.md](./brainstorm.md); no owner decision was open. The four items it left to this spec are
decided in §11.2 (A1–A4). Contract edits are listed in §11.1 and applied by `/develop` first.

Binding rules: CLAUDE.md → "Database rules", "API conventions" (pagination), "Authorization — RBAC and ownership",
"Security rules", "Privacy and logging", "Testing policy", "Performance rules", "Build order for a new module". Related
specs: [access/spec.md](../access/spec.md) (§3.4 `authorize`, §3.5 `AuditRecorder`, §14.1 hand-off), the keyset
precedent in [specialties/spec.md](../specialties/spec.md) and the signed cursor of
[verification/spec.md](../verification/spec.md).

---

## 1. Overview

### 1.1 What `audit` owns
| Area | Delivers |
|---|---|
| Route | `GET /api/audit-logs` (admin), newest first by `(created_at DESC, id DESC)` |
| Filters | `actorUserId`, `action`, `entityType`, `entityId`, `from`, `to` (whitelisted; unknown query keys are `400`) |
| Window | always time-bounded: `[from, to)`, defaults `to = now`, `from = to - 30 days`; the effective `from` and `to` are frozen into the cursor |
| Migration | `20261009120000_add_audit_logs_read_indexes` — the three read indexes on the partitioned parent |
| Code | `src/app/audit/` (read module), `IsIsoDateTimeWithOffset` decorator in `lib/validation`, pure `parseIsoDateTimeWithOffset` in `pkg/utils` |

It does **not** own: the table, its partitions, its grants, or the write path (`access`, `lib/audit`, the
`audit-partitions` worker loop — all unchanged); export, free-text search, `metadata` filtering, retention tooling (§10).

### 1.2 Principles
1. **Every query is time-bounded** so partition pruning bounds the scan (ADR 0009). No code path reads `audit_logs`
   without both `created_at` bounds.
2. **The read is not a clinical access.** Entries carry ids, statuses, and reason lengths only (`lib/audit` rejects
   clinical/PII key names and caps metadata), so reading them writes no audit row.
3. **One query per request.** No joins, no Identity hydration: `actorUserId` and `entityId` are returned as ids.
4. **Reuse the pagination foundation**: `PaginationQueryDto`, `signed-cursor`, `timestampCursorSelect` (full-microsecond
   `created_at`, foundation fix #7), the `limit + 1` page rule.

### 1.3 Dependencies
- **Modules:** none at runtime. Reads a table written by every other module through `lib/audit`.
- **Foundation:** `userGuard`, `authorize`, `rateLimit`, `noStore`, `sealRouter`, `validateQuery`, `sendSuccess`,
  `signed-cursor`, `timestamp-cursor`.
- **Other service:** none (no Identity call, no outbound call of any kind).

---

## 2. Database schema

No new table, column, constraint, or grant. The table (`audit_logs`, PK `pk_audit_logs (id, created_at)`, partitioned
`BY RANGE (created_at)`, `audit_logs_default` catch-all) is defined in [access/spec.md](../access/spec.md) §3.5 and
[data-model.md](../architecture/data-model.md). `vcare_app` already holds `SELECT` on the parent, the default partition,
and every monthly partition; **grants are unchanged** (still INSERT-columns + SELECT only: nothing here widens them).
`audit_logs` has no `deleted_at` (append-only; there is no soft delete), so reads carry no `deleted_at` predicate.

### 2.1 Migration `20261009120000_add_audit_logs_read_indexes`
Raw SQL in Knex `up`/`down` (`knex.raw`), one migration, additive only (expand-safe: no existing statement, grant, or
function changes; old code is unaffected by extra indexes).

```sql
-- up (inside the migration transaction)
SET LOCAL lock_timeout = '3s';   -- fail fast (migration is retried) instead of queueing writers behind a SHARE lock

-- GET /api/audit-logs?entityType=&entityId= newest first  (equality prefix, then the sort pair; shape E)
CREATE INDEX IF NOT EXISTS idx_audit_logs_entity_type_entity_id_created_at
    ON audit_logs (entity_type, entity_id, created_at DESC, id DESC);
-- GET /api/audit-logs?actorUserId= newest first  (shape A)
CREATE INDEX IF NOT EXISTS idx_audit_logs_actor_user_id_created_at
    ON audit_logs (actor_user_id, created_at DESC, id DESC);
-- GET /api/audit-logs unfiltered, or action / time-range filtered, newest first  (shape D; also the fallback for any filter combination)
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at_id
    ON audit_logs (created_at DESC, id DESC);

-- down (a real down; the indexes are additive, so dropping them loses no data)
DROP INDEX IF EXISTS idx_audit_logs_created_at_id;
DROP INDEX IF EXISTS idx_audit_logs_actor_user_id_created_at;
DROP INDEX IF EXISTS idx_audit_logs_entity_type_entity_id_created_at;
```

Each `CREATE INDEX` carries the SQL comment above naming its query (CLAUDE.md → Database rules). Notes:
- **On the partitioned parent**: the index is created on every existing partition (including `audit_logs_default`) and
  cascades to every future partition. A partition made later by `audit_logs_ensure_partitions` (`CREATE TABLE … LIKE`
  then `ATTACH PARTITION`, migration `20261003120100`) gets matching indexes built while attaching; the new table is
  empty so this is instant, and the function is **not** edited. Test T-IDX2 pins this.
- **Non-concurrent**: `CREATE INDEX` on a partitioned parent cannot run `CONCURRENTLY` and takes a `SHARE` lock on each
  partition, blocking audit INSERTs for the build time. Nothing is in production (decision D1), so the build is
  milliseconds and `lock_timeout 3s` bounds a stall. **Escape hatch (runbook, not code)** if the table is large when
  this ships (rule of thumb > 5 M rows): `CREATE INDEX … ON ONLY audit_logs`, `CREATE INDEX CONCURRENTLY` per partition,
  `ALTER INDEX … ATTACH PARTITION`; that needs `config.transaction = false` and is a new migration, not an edit of
  this one.
- Names fit the 63-byte identifier limit (longest is 48 characters).
- Index maintenance cost: 4 indexes total on the insert hot path (PK + 3), accepted by D1 for the ≈ 100 k rows/day load.

### 2.2 Query shapes and the index that serves each
All shapes share the predicate `created_at >= :from AND created_at < :to` and the order `created_at DESC, id DESC`, and
`LIMIT :limit + 1`. When a cursor is present, one more predicate is added: `(created_at, id) < (:cursorTs::timestamptz, :cursorId)`.

| Shape | Extra predicates | Index (leading columns) | Why it serves the query |
|---|---|---|---|
| **E** entity | `entity_type = :t AND entity_id = :id` | `idx_audit_logs_entity_type_entity_id_created_at (entity_type, entity_id, created_at DESC, id DESC)` | two equalities pin the prefix; the remaining columns are exactly the sort, so the scan is ordered and the range + keyset condition is an index condition |
| **A** actor | `actor_user_id = :actor` | `idx_audit_logs_actor_user_id_created_at (actor_user_id, created_at DESC, id DESC)` | one equality, then the sort pair |
| **D** default | none, or `action = :a` | `idx_audit_logs_created_at_id (created_at DESC, id DESC)` | ordered scan from the window top; `action` (and any extra filter) is applied to rows as they stream by, and the scan stops after `limit + 1` matches |

Combinations: `actorUserId` + `entityType`/`entityId` (+ `action`) is allowed; the planner picks E or A and filters the
rest. Correctness never depends on the chosen index, only speed; the EXPLAIN test (§9.4) asserts the three **single-shape**
queries. `entityType` alone (no `entityId`) has no index with `entity_type` as an ordered prefix: it runs as D with a
filter (window-bounded, see §8). `entityId` alone is rejected (rule R5), because it would have no usable index at all.

The repository builds the SQL with Knex and `whereRaw`; it passes the window bounds and the cursor timestamp as **bound
parameters computed in the application**, never `now() - interval '30 days'` in SQL. A `STABLE` expression in the SQL
would defer pruning to executor start-up ("Subplans Removed"); bound parameters make PostgreSQL prune at plan time and
make the plan assertion in §9.4 meaningful. `pg` sends parameters unnamed and untyped, so every placeholder is cast
(`?::timestamptz`, `?::bigint`) and the plan is a custom plan per call (no generic-plan pruning loss).

### 2.3 Partition pruning
- `created_at >= :from AND created_at < :to` against `PARTITION BY RANGE (created_at)` keeps only the monthly
  partitions overlapping `[from, to)`. A 30-day default window touches 1 to 2 monthly partitions.
- **`audit_logs_default` may stay in the plan** (PostgreSQL does not prune a default partition for an open range
  reaching past the highest partition bound). It must be empty by invariant (`AuditPartitionMissing` alert), so scanning
  it costs one empty index probe. The assertion therefore says "no monthly partition outside the window appears in the
  plan", not "only in-window partitions appear" (§9.4). With a default partition in the plan, PostgreSQL uses `Merge
  Append` rather than ordered `Append`; both stop after `LIMIT` rows and neither adds a `Sort` node.
- Retention detach (ADR 0009, ops) removes old monthly partitions; a window reaching into detached months simply
  matches nothing there.

---

## 3. API contract

Guard `user` (`userGuard()`), mounted on the **public** listener only (`/api`). Router-level `noStore()`
(`Cache-Control: no-store`; the data is privileged and per-admin). Route chain, in this order:
`userGuard()` → `authorize(AUDIT_POLICIES.list)` → `rateLimit(audit-read)` → `controller.list`.

### 3.1 `GET /api/audit-logs` (`listAuditLogs`)
| Aspect | Value |
|---|---|
| Guard | `user` (Bearer access token) |
| Roles | `admin` only (explicit list; patient, doctor → `403 Forbidden`) |
| Ownership predicate | `none` (`owner: { kind: "none" }`): an admin reads any entry |
| Account state | default (token `status = active`); `suspended` is never allowed. No `accountState` override |
| Audit class | none: reading the audit log writes no audit row (rule R9) |
| `Idempotency-Key` | not applicable (GET) |
| Rate limit | 120/min per admin user (`audit-read`, `byUser`), after `authorize`; see §7.3 |
| Success | `200` `{ success: true, data: AuditLogEntry[], meta: PaginationMeta }` |
| Errors | `400 ValidationFailed`, `401 Unauthorized`/`TokenExpired`, `403 Forbidden`, `429 RateLimited`, `500 InternalError` |

**Query DTO** `ListAuditLogsQueryDto extends PaginationQueryDto` (`cursor` optional string ≤ 1024; `limit` strict
`ToInt`, 1..100, default 20 — inherited unchanged). All members are optional; unknown query keys are rejected
(`forbidNonWhitelisted`, `400`, `issue: "is not allowed"`). Duplicated keys (`action=a&action=b`, which `qs` parses as an
array) fail the string/integer validators → `400`.

| Field | Validators | Notes |
|---|---|---|
| `actorUserId` | `@IsOptional() @ToInt() @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER)` | strict canonical integer (`007`, `1e3`, `1.5`, `+1`, ` 1` → `400`); `Max` is implied by `ToInt` (`Number.isSafeInteger`) and kept explicit |
| `action` | `@IsOptional() @IsString() @MinLength(1) @MaxLength(64) @NoControlCharacters("nul")` | exact match, case-sensitive; no pattern check (a never-written value just returns an empty page); NUL rejected (Postgres would error → 500) |
| `entityType` | `@IsOptional() @IsString() @MinLength(1) @MaxLength(64) @NoControlCharacters("nul")` | exact match |
| `entityId` | `@IsOptional() @ToInt() @IsInt() @Min(1)` | requires `entityType` (R5) |
| `from` | `@IsOptional() @IsString() @MaxLength(40) @IsIsoDateTimeWithOffset()` | inclusive lower bound |
| `to` | `@IsOptional() @IsString() @MaxLength(40) @IsIsoDateTimeWithOffset()` | exclusive upper bound |

`IsIsoDateTimeWithOffset()` (new, domain-free, in `src/lib/validation/date-decorator.ts` beside `IsCalendarDate`) is
backed by the pure `parseIsoDateTimeWithOffset(value): Date | undefined` in `src/pkg/utils/iso-datetime.ts`. Accepted:
`YYYY-MM-DDTHH:MM:SS[.f{1,9}](Z|±HH:MM)` with uppercase `T`/`Z`, a real calendar date (`isCalendarDate`), `HH 00..23`,
`MM 00..59`, `SS 00..59` (a leap second `60` is rejected), offset hours `00..23` and minutes `00..59`. The UTC instant
must lie in `1970-01-01T00:00:00Z .. 9999-12-31T23:59:59.999Z`. Fractional seconds beyond milliseconds are truncated to
milliseconds. **Rejected:** date-only (`2026-10-01`), no offset (`2026-10-01T00:00:00`), `+0100` without colon, lowercase
`t`/`z`, space instead of `T`, epoch numbers. **URL encoding:** a `+` offset must be sent as `%2B` (a raw `+` decodes to
a space and fails with `400`); `Z` needs no encoding. The `400` detail names the field (`from` or `to`) and
`"must be an ISO-8601 date-time with a UTC offset"`; rejected values are never echoed.

**Cross-field validation** (service-level, after DTO validation; details sorted by `field`):
| Condition | `400` detail |
|---|---|
| `entityId` present and `entityType` absent | `{ field: "entityType", issue: "is required when entityId is given" }` |
| effective `from` later than effective `to` | `{ field: "from", issue: "must not be later than to" }` |
| `cursor` malformed, wrongly signed, or with an invalid payload | `{ field: "cursor", issue: "is invalid" }` |

`from == to` is a valid empty window (R3), not an error.

**Response** `data: AuditLogResponseDto[]` (order: `created_at DESC, id DESC`); `meta: { nextCursor, hasMore, count }`
(`count` = items in this page; no total count, no `COUNT(*)`).

`AuditLogResponseDto` — exact contract `AuditLogEntry` (all nine keys required, nothing else, never an extra column):
| Field | Type | Source |
|---|---|---|
| `id` | integer | `audit_logs.id` |
| `actorUserId` | integer or `null` | `actor_user_id` (null for `service`/`system` actors) |
| `actorRole` | `patient \| doctor \| admin \| service \| system` | `actor_role` |
| `action` | string | `action` |
| `entityType` | string | `entity_type` |
| `entityId` | integer | `entity_id` |
| `requestId` | UUID string or `null` | `request_id` |
| `metadata` | object of scalars (`string \| number \| boolean \| null`) | `metadata`, **passed through verbatim** (shallow copy; no key is added, dropped, renamed, or transformed) |
| `createdAt` | ISO-8601 UTC string | `created_at.toISOString()` (millisecond precision; the cursor, not the DTO, carries microseconds) |

The viewer is always an admin and entries are not viewer-dependent, so there is no viewer-aware variant. BIGINT columns
arrive as JS numbers through the pool's global int8 parser (as in every other module); ids stay far below 2^53.

### 3.2 Cursor
Opaque, produced with `encodeSignedCursor` and read with `decodeSignedCursor` (HMAC-SHA256, constant-time compare,
key `SERVICE_CLIENT_SECRET` — the same key and helper the verification queue cursor uses). Payload:
```json
{ "t": "2026-04-15T11:59:59.123456Z", "id": 4821, "from": "2026-03-16T12:00:00.000Z", "to": "2026-04-15T12:00:00.000Z" }
```
- `t` is the last returned row's `created_at` at **full microsecond precision**, selected with
  `timestampCursorSelect(conn, "created_at", "cursor_timestamp")` (foundation fix #7), validated by
  `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$`; `id` is a positive safe integer; `from` and `to` are the **effective** inclusive lower and exclusive
  upper bounds of the first page in millisecond ISO form, validated by `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$`
  and `parseIsoDateTimeWithOffset`.
- Tamper handling: a bad shape, a bad MAC, a payload that fails validation, or a rotated `SERVICE_CLIENT_SECRET` →
  `400 ValidationFailed` with `details: [{ field: "cursor", issue: "is invalid" }]` (no `500`, no detail about which
  check failed). The MAC check precedes JSON parsing and SQL.
- A cursor is a **position, never a grant**: every page re-applies the request's filters and window. The cursor does
  not bind the filter set (unlike the verification queue's status): changing a filter between pages simply restarts
  ordering from that position within the new filter; it cannot reveal anything the admin could not already query.
- Size: about 165 characters, far below the 1024 cap.

---

## 4. Business rules

| # | Rule (testable invariant) | Enforced in |
|---|---|---|
| R1 | Newest first: rows are ordered `created_at DESC, id DESC`; the keyset predicate is `(created_at, id) < (cursorTs, cursorId)`, so rows sharing a `created_at` (every row of one transaction does) are neither skipped nor duplicated across pages | repository SQL; cursor |
| R2 | The window is `created_at >= from AND created_at < to` (**`from` inclusive, `to` exclusive**) | repository SQL |
| R3 | Effective `to` = `query.to`, else `cursor.to`, else `clock.now()` (ms). Effective `from` = `query.from`, else `cursor.from`, else effective `to` minus 30 days. The default `to` is the application clock while rows are stamped by the database `NOW()`: with clock skew a just-written row can be absent from page 1 (accepted, like R14). `from > to` → `400` (`field: "from"`); `from == to` → `200` with an empty page (no SQL executed) | service `resolveAuditWindow` (pure) |
| R4 | **The effective `from` and `to` are frozen into every `nextCursor`**, so a client that omits them sees the same window on every page while the wall clock advances; a row inserted after page 1 never appears on page 2. Page 1 is the only call that reads the clock | service; cursor payload `from`, `to` |
| R5 | `entityId` without `entityType` → `400` (`field: "entityType"`). Reason: no index serves an `entity_id`-only filter, and an unindexed rare-id scan over the window breaks the performance rules | DTO/service cross-field check |
| R6 | No span cap: an explicit window of any size (even 1970..9999) is accepted. The scan is bounded by pruning, the keyset `LIMIT`, and the pool `statement_timeout`; see §8 | none (deliberate) |
| R7 | The page is `limit + 1` rows; `hasMore = rows > limit`; `nextCursor` is set from the last **returned** row only when `hasMore`; `count` = returned items | `buildPage`-style logic in the service (signed variant) |
| R8 | `limit` is 1..100 (default 20); anything else, including `0`, `101`, `1.5`, `abc`, is `400` | `PaginationQueryDto` |
| R9 | The read writes **no** audit row and calls no other service; the table is unchanged by any request | service has no `AuditRecorder`, no transaction |
| R10 | `metadata` is returned verbatim; the module never filters, searches, or derives from it (it was validated flat/clinical-free at write time) | response DTO |
| R11 | Only the whitelisted filters and exact-match semantics exist; `action` and `entityType` are compared with `=`, never `LIKE`; every value is a bound parameter | DTO whitelist; repository |
| R12 | Admin only, token status `active`, ownership `none`; every other role/state is denied before any query runs | `authorize(policy)` |
| R13 | Request logs carry the route pattern, status, duration, request id, and user id; never the query string, filter values, cursor, or any `metadata` | existing logger; test |
| R14 | Rows are ordered by transaction **start** time (`created_at DEFAULT NOW()`), not commit time: a transaction that began before page 1's last row but commits later can appear out of order or be missed by an in-progress pagination. Accepted limitation of keyset over `created_at` (the same holds for every other keyset list); a fresh first page always shows it | documented |

---

## 5. Cross-service behavior

None. No call is made or served on any integration case; Identity is not consulted (`actorUserId` stays a bare id).
The route is on the public listener only; there is no `/internal` counterpart. Failure policy: not applicable.

---

## 6. Error codes

| Code | HTTP | When |
|---|---|---|
| `ValidationFailed` | 400 | unknown query key; `limit`/`actorUserId`/`entityId` not a strict integer in range; `action`/`entityType` empty, too long, or containing NUL; `from`/`to` not ISO-8601 with offset; `from` later than effective `to`; `entityId` without `entityType`; malformed, tampered, or no longer valid cursor. `details[]` carries `field` and `issue` (no rejected values) |
| `Unauthorized` / `TokenExpired` | 401 | missing, invalid, or expired bearer token |
| `Forbidden` | 403 | role is not `admin`, or token status is not `active` (including `suspended`) |
| `RateLimited` | 429 | the 121st request in 60 s by one admin (`Retry-After`) |
| `InternalError` | 500 | unhandled (including a `statement_timeout` cancel); no internals in the body |

No new error code. `NotFound` is never returned (an empty result is `200` with `data: []`).

---

## 7. Security & privacy

### 7.1 RBAC summary
| Route | Roles | Ownership | Token status |
|---|---|---|---|
| `GET /api/audit-logs` | `admin` | `none` | `active` |

`AUDIT_POLICIES.list = { kind: "user", roles: ["admin"], owner: { kind: "none" } }` in `src/app/audit/policies.ts`
(`AuditPolicies = Readonly<Record<"list", UserPolicy>>`). The boot route assertion fails if the route is mounted
without `authorize`. A doctor or patient never reaches the repository.

### 7.2 Audit events and privacy
- **Audit events written:** none. Reasoning: entries are metadata-only by construction (`lib/audit` validation and the
  `chk_audit_logs_metadata_size` / key-name rules), so the read exposes no clinical text; the contract states the same.
  If the owner later wants "who read the audit log", that is a new `audit.read` action and a contract `x-audit-actions`
  edit, not part of this module.
- **Never logged:** `metadata`, `cursor`, the query string, filter values (`actorUserId`, `entityId`, `action`,
  `entityType`, `from`, `to`), tokens, `Authorization`. Logs for this route carry only the route pattern
  (`GET /api/audit-logs`), status, duration, request id, user id. Error details never echo rejected values.
- **No file or URL fields** exist in this module.
- **Response caching:** `Cache-Control: no-store`.

### 7.3 Rate limit
`rateLimit({ name: "audit-read", limit: 120, windowMs: 60_000, subject: byUser })` placed **after** `authorize`
(admin-only route; the per-user subject needs the verified principal). Rationale: every other admin read uses
120/min per admin (`verification-admin`, the specialties user limiter); the route is paginated at ≤ 100 rows with one
indexed query, so the same ceiling is proportionate. No pre-auth IP limiter is added (unlike the public-facing
catalog list): an unauthenticated caller is rejected by `userGuard` before any DB work, and the guard's JWKS cache
absorbs the cost. Redis-down behavior follows the shared limiter (fail-open per the existing `lib/rate-limit`
contract); readiness is unaffected.

---

## 8. Performance

- **Hot path:** one admin page = 1 SQL statement (explicit columns, `LIMIT limit+1`, no `SELECT *`, no `COUNT`, no
  join) + 1 Redis limiter call + the cached JWKS. Query count is asserted (§9.5).
- **Index coverage:** shapes E, A, D are each served by an index whose leading columns match the equality filters and
  whose trailing columns match the sort (§2.2); the keyset predicate is applied in the index, so page N costs the same as
  page 1 (no `OFFSET`).
- **Pruning:** a default window reads 1 to 2 monthly partitions plus the empty default (§2.3). An explicit multi-year
  window plans over more partitions (planning cost grows roughly linearly, still milliseconds for ≤ 72 partitions =
  6 years of retention) while execution still stops after `limit + 1` rows via `Merge Append`.
- **Budget:** engineering target p95 < 200 ms for a default-window page of 20 at design load (≈ 100 k rows/day,
  ≈ 3 M rows in 30 days); CLAUDE.md → Performance rules lists no audit budget, so this is the "other reads" ceiling, to
  be confirmed when a load test exists. Not asserted by wall clock in CI (flaky); asserted structurally by EXPLAIN.
- **Known cost (accepted by D1):** an `action` filter (and `entityType` without `entityId`) has no dedicated index, so a
  rare value scans window rows along `idx_audit_logs_created_at_id` until `limit + 1` matches or the window ends
  (worst case ≈ 3 M index entries for a never-seen action over 30 days). Mitigations: pruning, the 30-day default,
  the keyset `LIMIT`, `statement_timeout`, and 120/min. **Revisit trigger:** if admins routinely filter by `action`
  and p95 for that shape exceeds the target, add `idx_audit_logs_action_created_at (action, created_at DESC, id DESC)`
  in a new migration (its own ADR/decision, since it adds insert cost). Not built now: "indexes exist only for a query
  in code" and D1 assigned `action` to the default index.
- **No cache** (privileged, per-admin, always-fresh; the table is append-only so a cache would hide recent writes).

---

## 9. Test plan outline

Layout follows the repo: unit under `tests/unit/`, integration `tests/integration/audit-read.test.ts` (a new file; the
existing `audit.test.ts` covers the write side and stays), real Postgres as `care_app` plus owner connection for
seeding, real Redis, `FakeClock` bound to `TOKENS.AuditClock`, signed admin tokens from `tests/helpers/tokens.ts`.

### 9.1 Determinism rules
- **No wall-clock assertions.** The service reads time only through `TOKENS.AuditClock` (`{ now(): number }`,
  production binding `{ now: () => Date.now() }` in `bootstrap.ts`; `FakeClock` satisfies it structurally). Tests
  `container.registerInstance(TOKENS.AuditClock, clock)` before resolving the controller, as `admin-doctors.test.ts`
  does for `SyncTiming`.
- **Fixed instant:** `NOW = 2026-04-15T12:00:00.000Z`. Default window = `[2026-03-16T12:00:00.000Z, NOW)`.
- **Seeding as the owner connection** (`ownerDb`): the app role cannot set `created_at`, the owner can. Insert with
  explicit `created_at` (microsecond literals, e.g. `'2026-04-15 11:59:59.123456+00'`) and explicit `id` where order
  matters. Rows are synthetic (`@example.test` never needed: no PII exists in this table); metadata uses only
  `{ fromStatus, toStatus, consultationId, reasonLength }`-style scalars. **No clinical fixture string is ever seeded.**
- **Partitions the test needs** are created as the owner in `beforeAll` with
  `CREATE TABLE IF NOT EXISTS audit_logs_y2026m01..m05 PARTITION OF audit_logs FOR VALUES FROM (..) TO (..)` (plus the
  grants the app role needs: `GRANT SELECT ON … TO vcare_app`) and dropped in `afterAll` (only those the test created).
  The date is far enough before the real current month that the migration-created partitions never overlap. Rows must
  not land in `audit_logs_default`; a final `afterEach` assertion checks it is empty.
- `truncateAll` between tests; rate-limit keys reset between tests (existing helper).

### 9.2 Unit tests (mock collaborators, < 100 ms each)
| Area | Cases |
|---|---|
| `parseIsoDateTimeWithOffset` | should accept `Z`, `+05:30`, `-08:00`, 1–9 fraction digits (truncated to ms); should reject date-only, no offset, `+0100`, lowercase `t`/`z`, space separator, hour 24, minute 60, second 60, `2027-02-30`, year 0000/1969/10000, empty, arrays; should convert `2026-04-15T14:00:00+02:00` to `12:00:00.000Z` |
| `IsIsoDateTimeWithOffset` + DTO | should return `400`-shaped details with `field` `from`/`to` and no echoed value; should reject unknown keys; should reject `limit` `0`/`101`/`1.5`/`abc`; should reject `actorUserId` `0`/`-1`/`007`/`1e3`/`abc`; should reject empty or 65-char `action`/`entityType` and NUL; should accept all filters together |
| `resolveAuditWindow` (pure) | should default `to` to the clock and `from` to `to` minus 30 days; should use `cursor.to` when `query.to` is absent; should prefer `query.to` over `cursor.to`; should reject `from > to` with field `from`; should accept `from == to` and report empty; should reject `entityId` without `entityType` with field `entityType`; should compute the 30 days with `toMs(30, "d")` |
| cursor | should round-trip `{ t, id, to }`; should answer `400` `cursor` for: not base64, missing MAC, flipped MAC byte, flipped payload byte, a verification-queue cursor, `t` with 3 fraction digits, `id` 0 / float / string, missing `to`, `to` not a valid instant, rotated secret |
| service (fake repo, fake clock) | should call the repository once with `limit + 1`; should not call the clock when `cursor` and `to` are both present; should set `nextCursor` only when `hasMore`; should freeze `to` into the cursor; should not call the repository when `from == to`; should not touch any audit recorder |
| response DTO | should produce exactly the nine contract keys and no other; should copy `metadata` verbatim (null, number, boolean, string); should render `createdAt` with `toISOString`; should map a `service` actor to `actorUserId: null` |
| policies | should list only `admin`, owner `none`, no `accountState` override |

### 9.3 Integration tests (real wiring)
**RBAC matrix (`GET /api/audit-logs`)**
- should return 200 when an `active` admin calls it
- should return 403 `Forbidden` when a patient, a doctor `active`, a doctor `pending`, or an admin with token status `suspended` calls it (no row is read: assert the repository path by seeding rows and checking the body is the error envelope)
- should return 401 `Unauthorized` without a token and 401 `TokenExpired` with an expired token

**Rules, one test each (R1–R14)**
- R1 should return rows newest first and break `created_at` ties by `id DESC`
- R1 page 2 on the default sort: should return the next 2 rows, no duplicate and no gap, with `limit=2` over 7 rows where **5 share one `created_at`** (microsecond-equal) and 2 differ; walk every page via `nextCursor` until `hasMore=false` and assert the concatenation equals the seeded order exactly
- R1 microsecond cursor: should not skip or repeat rows whose `created_at` differ only in microseconds (`…123456` vs `…123789`), proving the foundation #7 precision
- R2 should include a row at exactly `from` and exclude a row at exactly `to`
- R3 should default to the last 30 days: with `NOW` fixed, a row at `NOW - 30d + 1 ms` is returned, one at `NOW - 30d - 1 ms` is not, and one at `NOW` is not
- R3 should return 400 with `details[0].field = "from"` when `from > to`; also when only `from` is given and is later than the clock's `NOW`
- R3 should return 200 with `data: []` and `meta.count = 0`, `hasMore = false`, `nextCursor = null` when `from == to`
- R3 should accept `from`/`to` with `Z`, `+02:00`, and `%2B02:00`-encoded offsets and treat them as the same instants; a raw `+` (decoded to a space) is `400`
- R4 frozen window: should keep page 2 stable when the clock advances and a new row is inserted between the pages: page 1 with no `to`, then `clock.advance(1 h)` and insert a row at the advanced time, then page 2 with the cursor and still no `to` — the new row never appears; a fresh page 1 afterwards shows it
- R4 should send `nextCursor` whose decoded payload `to` equals the page-1 effective `to` (decode in the test with the secret)
- R5 should return 400 `field = "entityType"` for `entityId=5` alone; should return 200 for `entityType` alone
- R6 should accept `from=1970-01-01T00:00:00Z&to=9999-12-31T23:59:59Z` with 200 and still page correctly (no cap)
- R7 should return `hasMore=true` and a `nextCursor` when more than `limit` rows exist; `hasMore=false`, `nextCursor=null` and `count` = row count on the last page; `count` never exceeds `limit`
- R8 limit bounds: 400 for `0`, `101`, `-1`, `1.5`, `abc`; 200 for `1` and `100`; default 20 when omitted
- R9 should leave the `audit_logs` row count unchanged (owner `COUNT(*)` before and after) and write no `audit.read` row
- R10 metadata passthrough: should return `{ fromStatus, toStatus, consultationId, flag: true, note: null, reasonLength: 12 }` byte-for-byte equal (types preserved: number stays number, null stays null) for a seeded row, and the response contains no key the row did not have
- R10 round trip: should return a row written by the real `AuditRecorder.record` when the clock is set 1 s after the commit (the only test that touches the real `created_at DEFAULT`)
- R11 should treat `%`, `_`, and `'` in `action` as literal characters (no match, no error)
- R12 covered by the RBAC matrix; also should not execute any SQL for a denied role (query-count spy equals 0)
- R13 should keep `metadata` values, the cursor, `entityId`, `actorUserId`, and the query string out of captured logs on success, `400`, and `429` (`captureLogs`, `expectNoSensitiveStrings`); the route label is `GET /api/audit-logs`
- R14 not tested (documented limitation)

**Every filter** (each with a positive and an exclusion assertion, seeded with at least 3 actors, 3 actions, 3 entity types)
- `actorUserId` returns only that actor's rows, and excludes `service`/`system` rows (null actor)
- `action` exact match; `entityType` exact match; `entityType` + `entityId` pair; `entityType` alone
- `from` alone; `to` alone; `from` + `to`
- combination `actorUserId + entityType + entityId + action + from + to` returns the intersection
- unknown filter key (`foo=1`), `requestId=…`, `metadata.x=1` → 400 `is not allowed`
- paging with a filter: page 2 with the same filter yields the rest; a cursor reused with a **different** filter still returns only rows matching the new filter (position, not grant)

**Cursor tamper**
- should return 400 `field = "cursor"` for: random string, valid base64 JSON without a MAC, flipped MAC, edited payload with the old MAC, a verification-queue cursor, an over-1024-character cursor
- should never return 500 for any of the above

**Contract conformance** (`tests/helpers/contract.ts`)
- 200 body is `{ success: true, data, meta }`; each entry has exactly the contract `AuditLogEntry` required keys (read from the contract block), `actorRole` in the contract enum, `requestId` UUID or null, `createdAt` ISO date-time; `meta` has exactly `nextCursor, hasMore, count`
- the set of error codes the route returns (400, 401, 403, 429, 500) is a subset of the contract's declared responses (`contractResponseCodes("/api/audit-logs", "get")`)
- `Cache-Control: no-store`; `X-Request-Id` echoed, and an incoming valid UUID is adopted
- 429 on the 121st request within a minute by one admin (`Retry-After` present); a second admin is unaffected

### 9.4 EXPLAIN and partition pruning (integration, real Postgres)
Run inside `db.transaction(trx => …)` with `SET LOCAL enable_seqscan = off` (tiny tables otherwise choose a seq scan;
the same technique as the specialties plan test), after `ANALYZE audit_logs` as the owner, over the 5 test partitions
(`2026m01..m05`) holding rows in every month. Plans come from `EXPLAIN (FORMAT JSON)` of the repository's exported
`listAuditLogsQuery(params, conn).toQuery()` (literals inlined, so the plan equals plan-time pruning with bound
parameters), for the default window `[2026-03-16T12:00:00Z, 2026-04-15T12:00:00Z)` — which overlaps m03 and m04 only.
Collect every `"Relation Name"` of the plan tree.

| Test | Assertion |
|---|---|
| should prune to the in-window partitions for the default query | the relation set contains `audit_logs_y2026m03` and `audit_logs_y2026m04`; it contains none of `…m01`, `…m02`, `…m05`; `audit_logs_default` is allowed |
| should prune when a cursor is present (page 2) | same set; the plan still has no `Sort` node |
| should use `idx_audit_logs_created_at_id` for the unfiltered shape and for `action = …` | the plan names the partition-level child of that index (index names beginning `audit_logs_y2026m03_` / `m04_` and ending `…created_at_id_idx`, matched by `pg_inherits` to the parent index); no `"Node Type":"Sort"`; no `Seq Scan` on a monthly partition |
| should use `idx_audit_logs_entity_type_entity_id_created_at` for `entityType` + `entityId` | child of that parent index; no Sort node; the `Index Cond` mentions `entity_type`, `entity_id`, and the `created_at` bounds |
| should use `idx_audit_logs_actor_user_id_created_at` for `actorUserId` | child of that parent index; no Sort node |
| should include the whole-table range for an explicit 1970..9999 window | all five test partitions appear (proves the pruning test is not vacuous) |
| should bind the bounds as parameters, not SQL time functions | the built SQL string contains no `now()`, `current_timestamp`, or `interval` |

The parent-to-child index mapping is resolved in the test with `pg_inherits` + `pg_class` (index relation `i` whose
`inhparent` is the named parent index), so the assertion does not depend on PostgreSQL's auto-generated child names.

### 9.5 Migration and structure tests (`migrations.test.ts`, `audit-read.test.ts`)
- T-IDX1 should create the three named indexes on `audit_logs` with exactly the declared column lists and `DESC` order (`pg_indexes.indexdef` contains `created_at DESC, id DESC`), valid (`indisvalid`), and not `UNIQUE`.
- T-IDX2 should give a partition created later by `audit_logs_ensure_partitions` and every existing partition (including `audit_logs_default`) a child of each of the three indexes.
- T-IDX3 should keep the app role's privileges unchanged: `has_table_privilege('care_app','audit_logs','UPDATE'|'DELETE'|'TRUNCATE')` stay false, `SELECT` true; the column-level `INSERT` set is unchanged.
- T-IDX4 `down` then `up` is clean (rollback drops the three indexes, re-apply recreates them).
- T-Q1 should execute exactly one SQL statement against `audit_logs` per request (statement counter on the Knex client: `query` events filtered to the table, excluding the limiter's Redis calls).
- T-Q2 should issue a statement whose text contains no `SELECT *` and lists exactly the nine columns plus `cursor_timestamp`.

### 9.6 Failure-mode unit tests
- should answer `500 InternalError` (envelope, no stack) when the repository rejects with a generic error, and `503`-class handling stays with the shared error handler (no module code).
- should propagate a `statement_timeout` cancellation as `500` without logging filter values.

---

## 10. Out of scope
- Export (CSV/NDJSON), free-text search, `metadata` filtering or full-text, aggregate/count endpoints, "who read the audit log".
- Retention, detach, archive tooling, and the escape-hatch index rebuild (ops runbook, ADR 0009).
- Any change to the write path (`lib/audit`), the partition function, the worker loop, or the grants.
- Identity hydration of `actorUserId` (names, emails); admins resolve ids through the verification/admin screens.
- A dedicated `action` index (§8 revisit trigger).
- Per-admin or per-entity audit visibility rules beyond admin-only.

---

## 11. Open questions
**None.** Every decision below is made in this spec; the contract edits in §11.1 are decided and applied by `/develop`
as its step 0 (CLAUDE.md → Build order for a new module), then the hub copy is synced. No platform change is required.

### 11.1 Contract changes required (decided; applied by `/develop` first)
Additive or clarifying edits to `contracts/openapi.yaml`, operation `listAuditLogs`; no new operation, no new error code.
- **C1 — description.** Replace the description with a precise one: window `created_at >= from AND created_at < to`
  (`from` inclusive, `to` exclusive); `to` defaults to now, `from` to 30 days before `to`; `from` later than `to` →
  `400 ValidationFailed` (`details[].field = "from"`); `from == to` is an empty page; `entityId` requires `entityType`
  (`400`, `details[].field = "entityType"`); the effective `from` and `to` are carried inside `meta.nextCursor` so later pages keep the
  same window; a malformed, tampered or no longer valid cursor (e.g. after a secret rotation) → `400`; a `+` in an offset must be URL-encoded as `%2B`; the response is
  `Cache-Control: no-store`.
- **C2 — parameters.** `action` and `entityType`: add `minLength: 1` (an empty value is `400`, not "no filter"). `from` and
  `to`: add `maxLength: 40` and a description "ISO-8601 date-time with a UTC offset (`Z` or `±HH:MM`)".
- **C3 — headers.** Add `Cache-Control: no-store` to the `200` response headers (use the existing `NoStore` header
  component if the contract has one; `contractNoStoreValue()` in `tests/helpers/contract.ts` reads it).
- **C4 — `x-` extensions.** None to add: no `x-audit` / `x-audit-actions` (the route writes none) and no
  `x-account-state` (the default `active` applies).

After applying: run `../vcare-hub/scripts/sync-from-spoke.sh`; hub copies are never hand-edited.

### 11.2 Decisions
| # | Decision | Why | Rejected |
|---|---|---|---|
| A1 | **Bounds `[from, to)`**; effective `from` and `to` are frozen into a signed cursor `{ t, id, from, to }` | an exclusive upper bound plus a frozen value makes page 2 independent of the clock; `from` inclusive matches "starting at" | inclusive `to` (a row at exactly `now` is ambiguous and `to` could not be frozen cleanly); re-reading the clock per page (unstable pages) |
| A2 | **No span cap** | the contract declares none; pruning + keyset `LIMIT` + `statement_timeout` bound cost; a cap would make a legitimate "all history of one entity" query impossible | a 31-/92-day cap (reintroduces a client-visible limit the contract lacks) |
| A3 | **`entityId` requires `entityType`** (`400`) | no index serves `entity_id` alone; accepting it would scan the window unbounded by an index | accept and filter on the created_at index (slow, unpredictable); add a fourth `entity_id` index (insert cost for a query nobody needs) |
| A4 | **Signed cursor reusing `signed-cursor` + `SERVICE_CLIENT_SECRET`**; no new env var | the plain `encodeCursor` carries exactly two values and cannot carry `to`; the signed helper is the existing precedent, tamper → `400` is its contract; rotating the secret just invalidates open cursors | a new `AUDIT_CURSOR_SECRET` (new env, no benefit); extending `encodeCursor` to three values (touches every module's cursor) |
| A5 | **Rate limit 120/min per admin** after `authorize` | same as every other admin read | 60/min (stricter than peers without evidence); an IP pre-limiter (the guard already rejects unauthenticated callers before DB work) |
| A6 | **No audit row for the read** | metadata-only data; contract states it is not a clinical read | `audit.read` per request (would write to the table on every page and self-amplify) |

---

## 12. File and wiring plan (for `/develop`)
```
src/app/audit/
  constants.ts      AUDIT_DEFAULT_WINDOW_DAYS = 30, AUDIT_READ_LIMIT = 120, AUDIT_READ_WINDOW_MS = 60_000, AUDIT_ACTION_MAX_LENGTH = 64
  entity/audit-log.entity.ts            plain class, constructor(Partial)
  repository/audit.repo.ts              AUDIT_LOG_COLUMNS, toEntity, listAuditLogsQuery(params, conn) [exported for EXPLAIN], listAuditLogs
  service/audit.service.ts              @injectable; resolveAuditWindow, cursor encode/decode, one repo call; no transaction
  window.ts         pure resolveAuditWindow(now, from, to, cursorTo, cursorFrom?) -> { from, to, empty }
  controller/audit.controller.ts        validateQuery -> service.list -> sendSuccess(data, { meta })
  dto/audit.request.dto.ts              ListAuditLogsQueryDto
  dto/audit.response.dto.ts             AuditLogResponseDto.from(entity)
  policies.ts  routes.ts  types.ts  errors.ts (no new AppError; cursor/window errors use ValidationFailed.withDetails)
src/pkg/utils/iso-datetime.ts           parseIsoDateTimeWithOffset
src/lib/validation/date-decorator.ts    + IsIsoDateTimeWithOffset
src/lib/di/tokens.ts                    + AuditService, AuditController, AuditClock
src/bootstrap.ts                        register AuditService, AuditController, AuditClock = { now: () => Date.now() }
src/routes.ts                           router.use(buildAuditRouter())
src/migrations/20261009120000_add_audit_logs_read_indexes.ts
tests/unit/…  tests/integration/audit-read.test.ts  (+ migrations.test.ts additions)
```
Types (`AuditLogRow`, `ListAuditLogsParams`, `AuditCursorPayload`, `AuditWindow`, `AuditClock`, `AuditPolicies`) live in
`src/app/audit/types.ts`, never inline. Layering: `app/audit` imports `lib/` and `pkg/` only; it does not import
`lib/audit` (the write side) or any other module. Files that change outside the module: only those listed above.

### 12.1 Docs and service card
`/update-docs` after the build: `docs/architecture/data-model.md` (replace "deferred" with the built indexes),
`docs/architecture/api.md` (audit row: window, filters, cursor), `docs/INDEX.md`, and `docs/service-card.md` (endpoint
list gains `GET /api/audit-logs` as built; the indexes on `audit_logs`). The **service card will need updating** when the
module ships; this spec does not edit it.
