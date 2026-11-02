---
title: help-articles — Spec
owner: care-team
service: care-service
module: help-articles
status: implemented
version: 0.2.0
diataxis: reference
last_verified: 2026-10-29
tags: [spec, help-articles, help-center, markdown, pagination, keyset, rbac, audit, rate-limit, idempotency, migration]
related: [help-articles-brainstorm, help-articles, adr-0027-help-articles-shape-and-access, adr-0028-help-corpus-read-path-for-phase-2, specialties-spec, access-spec, foundation-spec, data-model, api, rbac, adr-0017-generic-helpers-and-transaction-scoping, adr-0018-db-role-split-explicit-grants-partition-function]
contracts: [contracts/openapi.yaml]
---

# help-articles — Spec

The help center: admin-authored Markdown articles that patients and doctors read, and later the Phase-2 help-assistant
corpus (PRD 7.10 and 12). One table, five routes, one service; the last unbuilt Care module. Structurally it follows
[specialties/spec.md](../specialties/spec.md) (admin-managed content, `userGuard` → `authorize` → `AuditRecorder`, keyset
pagination, 23505 mapping by constraint name, no-op `PATCH`) and adds soft delete and a role-dependent read view.

Scope follows [brainstorm.md](./brainstorm.md), [architecture/help-articles.md](../architecture/help-articles.md) and ADRs
[0027](../adr/0027-help-articles-shape-and-access.md) and [0028](../adr/0028-help-corpus-read-path-for-phase-2.md). The
five **owner decisions** (§1.4) are not reopened here. The items the shard and brainstorm left as "proposed" or "call"
are decided in §1.4 (HA-D1 to HA-D14), each with a one-line rationale.

Binding rules: CLAUDE.md → "Database rules", "API conventions", "Authentication and service-to-service auth",
"Authorization — RBAC and ownership", "Security rules", "Privacy and logging", "Testing policy", "Build order for a new
module". The access base is [access/spec.md](../access/spec.md) (§3.2 route composition, §3.4 `authorize`, §3.5
`AuditRecorder`).

---

## 1. Overview

### 1.1 What `help-articles` owns
| Area | Delivers |
|---|---|
| Table | `help_articles` (title, Markdown body, category, audience, publish state, `deleted_at`); soft delete only |
| Routes | `GET /api/help-articles`, `GET /api/help-articles/{id}` (patient, doctor, admin); `POST /api/help-articles`, `PATCH /api/help-articles/{id}`, `DELETE /api/help-articles/{id}` (admin) |
| Audit | `help_article.created`, `help_article.updated`, `help_article.deleted` (class `admin-action`), written in the write's transaction |
| Data | none seeded: the table starts empty (owner decision O4) |
| Generic helpers (new, `lib/`) | `lib/http/private-no-cache.ts` (`privateNoCache()`), a kind-tagged timestamp cursor decoder in `lib/http/pagination/cursor.ts` (§3.7) |

### 1.2 Principles
- **Not clinical data.** Articles are admin-authored product content: no `no-store`, no viewer-aware clinical DTO, no
  clinical audit on reads. The same response shape is returned to every role.
- **The constraint is the guarantee.** The unique live title per audience lives in `uq_help_articles_audience_title`; the
  service maps SQLSTATE `23505` by constraint name to `409 Conflict`. No "does it exist?" pre-check.
- **Existence is private for non-admins.** An unpublished, other-audience, or deleted article is `404 NotFound` to a
  patient or doctor, identical to an id that never existed. A deleted article is `404` to admins too (HA-D4).
- **Audit in the same transaction.** A write and its audit row commit or roll back together. The audit `metadata` never
  holds `title` or `body`.
- **A no-op is not a write** (HA-D9): it changes neither `updated_at` nor the audit log, so `updated_at` stays a true
  change signal for the Phase-2 indexer.
- **Verbatim Markdown.** `body` is stored and returned byte for byte. Care never renders, sanitises, trims, or rewrites it;
  clients render it with a sanitiser that does not render raw HTML (ADR 0027).
- **Position, not grant.** A cursor is a keyset position; every page re-applies the caller's role filter.

### 1.3 Dependencies
- **Other modules:** foundation and access only (`userGuard`, `authorize`, `AuditRecorder`, `lib/http/pagination`,
  `lib/validation`, `lib/rate-limit`, `lib/idempotency`). No module reads `help_articles`; the Phase-2 reader is
  `GET /internal/help-articles` (ADR 0028), which is **not built here**.
- **Other service:** none. No Identity call (the admin comes from the verified token), no worker loop, no Redis cache of
  content, no storage, no video, no email.
- **New runtime dependencies:** none (Markdown stays verbatim).
- **New env variables:** none (rate-limit numbers are module constants, §3.9).

### 1.4 Decisions

**Owner decisions (2026-10-29, not reopened).**
| # | Decision |
|---|---|
| O1 | `body` is Markdown stored verbatim, cap 50,000 characters, no new dependency |
| O2 | Edits in place, no revision table; `published_at` is set on the **first** publish and kept (unpublish keeps it) |
| O3 | Two audiences only (`patient`, `doctor`); content that applies to both is two rows |
| O4 | Start empty: no seed rows and no seed migration; QA and tests create synthetic fixtures |
| O5 | `GET /internal/help-articles` is designed (ADR 0028) and **not built** in this iteration |

**Spec decisions (confirmed or made by this spec).**
| # | Decision | Rationale |
|---|---|---|
| HA-D1 | **List ordering.** Non-admins: `published_at DESC, id DESC` on the partial index. Admins: `updated_at DESC, id DESC`. The cursor carries its sort kind: the sort value is `published:<µs timestamp>` or `updated:<µs timestamp>`; a cursor whose kind differs from the caller's sort is `400 ValidationFailed` (`cursor: is invalid`). | Readers get a stable "newest published first" order that an edit never reshuffles; admins want recently edited rows first. Tagging the kind stops a cursor from silently mispositioning a page. |
| HA-D2 | **Rate limits.** Reads: 120/min per user (after `authorize`), no per-IP limiter. Writes: 20/min per user, one shared bucket for `POST`, `PATCH`, `DELETE`. | Reads use the authenticated-read class of `doctors`, `patients`, `records`, `consultations` (120/min); the per-IP limiter is for the public search class, and these routes need a token. 20/min is the write class of `doctors`, `patients`, `records`; help edits are rare, admin-only and audited. |
| HA-D3 | **`PATCH` may change `category` and `audience` of a published article** without unpublishing first. The unique-title rule applies to the resulting `(audience, title)`. | Moving an article between audiences or categories is an editorial fix, not a new publication; forcing an unpublish would hide it from readers. |
| HA-D4 | **A deleted article is `404` for everyone, admins included.** There is no restore and no read of deleted rows. Deleting frees the title for reuse. | Soft delete exists to keep history in the table, not to add an admin trash feature the PRD does not ask for. |
| HA-D5 | **Unique live `(audience, title)`** (case-sensitive, exact, no trimming) via `uq_help_articles_audience_title`; a clash on create or update → `409 Conflict` with `details: [{ field: "title", issue: "is already in use for this audience" }]`. | The index is already in the data model; case-sensitive exactness matches specialties (D3) and keeps the DB and DTO the same rule. |
| HA-D6 | **Logger redaction.** `body` is **already** in `REDACTED_KEYS` (`src/lib/logger/redact.ts`), so no new entry is added. The redaction unit test gains a help-articles row asserting that `body` is redacted. `title` is not added: the module never logs it, and it is not sensitive. | The owner asked for a `body` entry as defence in depth; it exists. A second entry would be a duplicate. |
| HA-D7 | **`Cache-Control: private, no-cache`** on every response under `/api/help-articles`, set by a prefix middleware mounted before the JSON parser (same mechanism as `NO_STORE_PREFIXES`). | Content is per-audience and per-token, so shared caches must not reuse it; `no-cache` makes browsers revalidate so an edit shows up at once. |
| HA-D8 | **Audit.** `help_article.created`, `help_article.updated`, `help_article.deleted`, entity type `help_article`, entity id = the article id, in the write's transaction. `metadata` = `isPublishedBefore`, `isPublishedAfter` and, on update, `changedFields` (sorted API field names). Never `title` or `body`. Reads are not audited. | ADR 0027 and the contract's `x-audit-actions`. The article id is the audit row's `entity_id`, so it is not repeated in `metadata`. |
| HA-D9 | **No-op `PATCH`** (every provided value equals the stored one) → `200` with the current article, no `UPDATE`, no `updated_at` change, no audit row. A partly-equal `PATCH` writes and audits only the changed fields. | Precedent: specialties S1. An audit row should mean something changed, and `updated_at` drives Phase-2 re-embedding. |
| HA-D10 | **Filters for non-admins.** `category` applies to every role. `audience` and `isPublished` are validated for every role (junk → `400`) but **applied only for admins** and silently ignored for patients and doctors, who always get published articles of their own audience. | Precedent: specialties `includeInactive`. Ignoring (not rejecting) keeps one client for all roles and leaks nothing. |
| HA-D11 | **Database checks added to the data-model DDL** so the database accepts exactly what the contract accepts: `chk_help_articles_title_length` (`char_length(title) >= 3`) and `chk_help_articles_body_length` (`char_length(body) BETWEEN 1 AND 50000`). | The DDL had only `VARCHAR(200)` and `TEXT NOT NULL`; the contract has `minLength: 3` and `1..50000`. Precedent: specialties added the same kind of checks. |
| HA-D12 | **Indexes.** The data-model index `(audience, category, published_at DESC, id DESC)` serves only a list with a `category` filter, because `category` is the second column; the unfiltered non-admin list could not use it for its order. It is **replaced** by `idx_help_articles_audience_published_at_id (audience, published_at DESC, id DESC) WHERE is_published AND deleted_at IS NULL`, which serves both (a `category` filter is applied to the in-order scan; there are four categories). A second partial index serves the admin list. | CLAUDE.md → Database rules: every query backed by an index, composite = equality then sort. One index for both non-admin shapes is simpler than two. See §2.3. |
| HA-D13 | **Request size.** The app-wide JSON limit (100 kb) is **not** raised for this route. A body of 50,000 code points passes the DTO, but a request larger than 100 kb is refused by the parser (`400 ValidationFailed`, `body: must not exceed 100kb`); that binds before the 50,000 cap only for text averaging more than about 2 bytes per character. The contract says so in the `body` description. | The corpus is English (localisation is deferred); a per-route parser limit is a new `lib/http` mechanism for a case that cannot occur with the planned content. Revisit with localisation. |
| HA-D14 | **Account state.** Reads: doctor `pending`, `active` or `rejected`; patient and admin `active`; writes: admin `active`. Care's `suspended_at` is not checked. The mechanism is the existing `accountState: { statuses: { doctor: ["pending", "active", "rejected"] } }` policy field of `GET /specialties` and the doctors onboarding routes (`src/lib/rbac/authorize.ts`). | ADR 0027 (D4). A doctor applying, or fixing a rejected application, needs the platform rules; reading reference content is not a practising action (CLAUDE.md → Authentication and service-to-service auth). A `suspended` token is never admitted by `authorize`. |

---

## 2. Database schema

### 2.1 Migration (one file; the timestamp is assigned by `npm run migrate:make` and sorts after `20261021120000`)
| # | File (`src/migrations/<ts>_<name>.ts`) | Change |
|---|---|---|
| 1 | `<ts>_create_help_articles` | table, constraints, the two partial indexes, comments, grants |

Runs as the owner (`MIGRATION_DATABASE_URL`), like every migration. There is no seed migration (O4).

### 2.2 `create_help_articles`
```sql
-- up
CREATE TABLE help_articles (
    id              BIGSERIAL PRIMARY KEY,
    title           VARCHAR(200) NOT NULL,
    body            TEXT NOT NULL,                       -- Markdown, verbatim (ADR 0027)
    category        VARCHAR(32) NOT NULL,
    audience        VARCHAR(16) NOT NULL,
    is_published    BOOLEAN NOT NULL,                    -- no default: the INSERT states it
    published_at    TIMESTAMPTZ,                         -- set on the first publish and kept (O2)
    created_by      BIGINT NOT NULL,                     -- Identity user id (admin); no FK
    updated_by      BIGINT NOT NULL,                     -- Identity user id (admin); no FK
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at      TIMESTAMPTZ,
    CONSTRAINT chk_help_articles_category
        CHECK (category IN ('how-it-works', 'preparing-for-consultation', 'cancellation-policy', 'platform-rules')),
    CONSTRAINT chk_help_articles_audience CHECK (audience IN ('patient', 'doctor')),
    CONSTRAINT chk_help_articles_published CHECK (NOT is_published OR published_at IS NOT NULL),
    CONSTRAINT chk_help_articles_title_length CHECK (char_length(title) >= 3),
    CONSTRAINT chk_help_articles_body_length CHECK (char_length(body) BETWEEN 1 AND 50000)
);

COMMENT ON TABLE help_articles IS 'Admin-authored help center articles (Markdown) and the Phase-2 RAG corpus. Soft delete only (vcare_app has no DELETE). Not clinical data.';

-- Non-admin list GET /help-articles[?category=]: WHERE audience = $1 AND is_published AND deleted_at IS NULL
--   [AND category = $2] [AND (published_at, id) < ($3::timestamptz, $4)] ORDER BY published_at DESC, id DESC LIMIT $n
CREATE INDEX idx_help_articles_audience_published_at_id ON help_articles (audience, published_at DESC, id DESC)
    WHERE is_published AND deleted_at IS NULL;

-- Admin list GET /help-articles[?audience=&category=&isPublished=]: WHERE deleted_at IS NULL [AND …filters…]
--   [AND (updated_at, id) < ($1::timestamptz, $2)] ORDER BY updated_at DESC, id DESC LIMIT $n
CREATE INDEX idx_help_articles_updated_at_id ON help_articles (updated_at DESC, id DESC) WHERE deleted_at IS NULL;

-- Unique live title per audience: admin create/update conflict -> 23505 -> 409 Conflict
CREATE UNIQUE INDEX uq_help_articles_audience_title ON help_articles (audience, title) WHERE deleted_at IS NULL;

GRANT SELECT, INSERT, UPDATE ON help_articles TO vcare_app;     -- no DELETE, no TRUNCATE (soft delete only)
GRANT USAGE ON SEQUENCE help_articles_id_seq TO vcare_app;      -- nextval() for BIGSERIAL

-- down
DROP TABLE IF EXISTS help_articles;
```
- Each statement is its own `await knex.raw(...)` (style of the specialties and audit migrations). No `?` appears in any
  literal, so no binding is involved.
- No foreign keys: `created_by`/`updated_by` are Identity ids; the table has no relation to another Care table.
- `uq_help_articles_audience_title` is a partial unique **index** (a partial unique cannot be a table constraint); the
  `uq_` prefix follows the naming rule, and Postgres reports its name as `error.constraint` on `23505`.
- The table is tiny (a handful to a few hundred rows), so the planner will usually seq-scan; the integration test proves
  the indexes are usable with `enable_seqscan = off` (§9.2).

### 2.3 Verification of the data-model DDL against the shard, the contract, and CLAUDE.md
| Item in `architecture/data-model.md` | Finding | Resolution |
|---|---|---|
| columns, `NOT NULL`s, `is_published` without default, `TIMESTAMPTZ` | match the shard, contract (`HelpArticle` required list) and CLAUDE.md | unchanged |
| `chk_help_articles_category`, `chk_help_articles_audience` | match the contract enums exactly | unchanged |
| `chk_help_articles_published` | matches O2 (`published_at` kept on unpublish) | unchanged |
| `title VARCHAR(200)`, `body TEXT` | **Mismatch:** the contract has `title` 3..200 and `body` 1..50,000; the database would accept a 1-character title or an empty or 10 MB body | HA-D11: two added checks |
| `idx_help_articles_audience_category_published_at_id (audience, category, published_at DESC, id DESC)` | **Mismatch with the shard:** the shard says non-admins are ordered by `published_at DESC, id DESC` with `category` optional; with `category` second in the key the unfiltered query cannot read the index in order | HA-D12: replaced by `idx_help_articles_audience_published_at_id` |
| (no index for the admin list) | **Gap:** the admin list (`updated_at DESC, id DESC`, drafts included) had no index | HA-D12: `idx_help_articles_updated_at_id` |
| `uq_help_articles_audience_title` | matches the shard (unique live title per audience) | unchanged |
| grants | the DDL lists none | `SELECT, INSERT, UPDATE` + sequence `USAGE`, no `DELETE`/`TRUNCATE` (CLAUDE.md → Database rules) |

`architecture/data-model.md` is reconciled by `/update-docs` (§13).

---

## 3. API contract and file-level design

### 3.1 Endpoints (mirror `contracts/openapi.yaml` after the edits of §12; the contract wins on disagreement)
| | `GET /api/help-articles` (`listHelpArticles`) | `GET /api/help-articles/{id}` (`getHelpArticle`) | `POST /api/help-articles` (`createHelpArticle`) | `PATCH /api/help-articles/{id}` (`updateHelpArticle`) | `DELETE /api/help-articles/{id}` (`deleteHelpArticle`) |
|---|---|---|---|---|---|
| Guard | `userGuard()` (bearerUser) | `userGuard()` | `userGuard()` | `userGuard()` | `userGuard()` |
| **Roles** (`x-roles`) | patient, doctor, admin | patient, doctor, admin | admin | admin | admin |
| **Ownership** (`x-ownership`) | **none**; non-admins are filtered to published + own audience in the query | **none**; hidden → `404` | **none** | **none** | **none** |
| Account state | doctor `pending`/`active`/`rejected`; patient and admin `active` (HA-D14) | same | admin `active` | admin `active` | admin `active` |
| Audit (`x-audit`) | — (reads not audited) | — | `admin-action`: `help_article.created` | `admin-action`: `help_article.updated` (only when something changed, HA-D9) | `admin-action`: `help_article.deleted` |
| `Idempotency-Key` | n/a | n/a | **optional** (`IdempotencyKeyOptional`) | not declared → no idempotency middleware; a sent header is ignored | not declared → ignored |
| Rate limit | 120/min per user (HA-D2) | 120/min per user | 20/min per user, shared write bucket | same bucket | same bucket |
| Request | query `cursor?`, `limit?`, `category?`, `audience?` (admin), `isPublished?` (admin) | path `id` | body `HelpArticleCreate` | path `id`, body `HelpArticleUpdate` | path `id` |
| Success | `200` `{ success, data: HelpArticleSummary[], meta: PaginationMeta }` | `200` `{ success, data: HelpArticle }` | `201` `{ success, data: HelpArticle }` | `200` `{ success, data: HelpArticle }` | `204` no body |
| Errors | 400, 401, 403, 429, 500 | 401, 403, 404, 429, 500 | 400, 401, 403, 409, 422, 429, 500 | 400, 401, 403, 404, 409, 429, 500 | 401, 403, 404, 429, 500 |
| `Cache-Control` | `private, no-cache` | `private, no-cache` | `private, no-cache` | `private, no-cache` | `private, no-cache` on the prefix (no body) |

Every status above is declared by the contract for that operation. `429` is declared on all five.

**Response shapes** (identical for every viewer, no clinical field, so the DTOs are not viewer-aware):
- `HelpArticle`: `{ id: number, title: string, body: string, category, audience, isPublished: boolean, publishedAt: ISO-8601 UTC | null, createdAt: ISO-8601 UTC, updatedAt: ISO-8601 UTC }` — exactly the contract's `required` list. `created_by`/`updated_by` are never returned.
- `HelpArticleSummary` (new, §12 C1): `{ id, title, category, audience, isPublished, publishedAt, updatedAt }`. **Never `body`, never `createdAt`.**

**Behaviour by route**
- **List.** A non-admin gets published, live articles of the audience matching their role (`patient` → `patient`, `doctor` → `doctor`), ordered `published_at DESC, id DESC`. An admin gets every live article (drafts included), ordered `updated_at DESC, id DESC`, and may filter by `audience`, `isPublished`, `category`. `limit` default 20, max 100; `limit + 1` fetch; `meta = { nextCursor, hasMore, count }`.
- **Get.** One statement carrying the visibility predicate. A non-admin: `id`, `audience = own`, `is_published`, `deleted_at IS NULL`. An admin: `id`, `deleted_at IS NULL`. No row → `404 NotFound`. A non-canonical id (`abc`, `0`, `007`, 17 digits) → `404` after the role check.
- **Create.** Body `{ title, body, category, audience, isPublished }`, all required. `isPublished = true` sets `published_at = now()`; `false` leaves it `NULL`. Returns `201` with the full article.
- **Patch.** Partial update of `title`, `body`, `category`, `audience`, `isPublished` (at least one member). Setting `isPublished` to `true` sets `published_at = COALESCE(published_at, now())` — the first publish stamps it, a later re-publish keeps the original. Setting it to `false` keeps `published_at`. A deleted or unknown id → `404`.
- **Delete.** Sets `deleted_at = now()` (and `updated_at`, `updated_by`); `204`. A deleted or unknown id → `404`, so a retried `DELETE` after a lost response sees `404`.

### 3.2 Route composition (`src/app/help-articles/routes.ts`)
```ts
export function buildHelpArticlesRouter(): Router {
    const router = Router();
    const controller = container.resolve<HelpArticlesController>(TOKENS.HelpArticlesController);
    const p = HELP_ARTICLES_POLICIES;
    const readLimit = () => rateLimit({ name: HELP_ARTICLES_READ_RATE_NAME, limit: HELP_ARTICLES_READ_USER_LIMIT, windowMs: HELP_ARTICLES_RATE_WINDOW_MS, subject: byUser });
    // One bucket for the three writes (admin-doctors precedent: a single named limiter shared by sibling routes).
    const writeLimit = () => rateLimit({ name: HELP_ARTICLES_WRITE_RATE_NAME, limit: HELP_ARTICLES_WRITE_USER_LIMIT, windowMs: HELP_ARTICLES_RATE_WINDOW_MS, subject: byUser });

    router.get("/help-articles", userGuard(), authorize(p.list), readLimit(), controller.list);
    router.get("/help-articles/:id", userGuard(), authorize(p.get), readLimit(), controller.get);
    router.post("/help-articles", userGuard(), authorize(p.create), writeLimit(), idempotency({ required: false }), controller.create);
    router.patch("/help-articles/:id", userGuard(), authorize(p.update), writeLimit(), controller.update);
    router.delete("/help-articles/:id", userGuard(), authorize(p.remove), writeLimit(), controller.remove);

    return sealRouter(router);
}
```
- Order: guard → `authorize` → user limiter → idempotency (POST) → handler. There is no pre-auth per-IP limiter (HA-D2).
  Each `rateLimit(...)` is built once per route (each owns its fallback `MemoryLimiter`); with Redis down it falls back
  to the per-instance limiter, as for every other module.
- Paths are full (`/help-articles`, `/help-articles/:id`); the router is mounted without a path in `src/routes.ts`
  (`router.use(buildHelpArticlesRouter())`), so route labels are `/api/help-articles` and `/api/help-articles/:id`.
  There is no sibling literal under `/help-articles`, so the mount position is free.
- **No `router.param`** (it would fail boot). `:id` is parsed in the controller after `authorize`.
- `src/routes.ts` also exports `PRIVATE_NO_CACHE_PREFIXES = ["/api/help-articles"]`, and `src/app.ts` mounts
  `markPreAuth(privateNoCache())` on each prefix next to the `NO_STORE_PREFIXES` loop and **before** the JSON parser, so
  a malformed-body `400`, a `401`, and a `404` under the prefix carry the header too (HA-D7).

### 3.3 File list
```
src/app/help-articles/
  constants.ts                          HELP_ARTICLE_TITLE_MIN/MAX_LENGTH (3/200), HELP_ARTICLE_BODY_MIN/MAX_LENGTH (1/50_000),
                                        HELP_ARTICLES_READ_USER_LIMIT (120), HELP_ARTICLES_WRITE_USER_LIMIT (20),
                                        HELP_ARTICLES_RATE_WINDOW_MS (60_000), HELP_ARTICLES_READ_RATE_NAME ("help-articles-read-user"),
                                        HELP_ARTICLES_WRITE_RATE_NAME ("help-articles-write"), HELP_ARTICLE_ENTITY_TYPE ("help_article"),
                                        HELP_ARTICLE_TITLE_CONSTRAINT ("uq_help_articles_audience_title"),
                                        CURSOR_KIND_PUBLISHED ("published"), CURSOR_KIND_UPDATED ("updated")
  enums.ts                              HelpArticleCategory (how-it-works | preparing-for-consultation | cancellation-policy | platform-rules),
                                        HelpArticleAudience (patient | doctor),
                                        HelpArticleAuditAction { Created = "help_article.created", Updated = "help_article.updated", Deleted = "help_article.deleted" },
                                        HelpArticleField { Title = "title", Body = "body", Category = "category", Audience = "audience", IsPublished = "isPublished" }
  errors.ts                             HelpArticleTitleTaken, EmptyHelpArticleUpdate (§6)
  types.ts                              HelpArticleRow, HelpArticleSummaryRow, ListHelpArticlesParams, HelpArticleVisibility,
                                        HelpArticleCreateInput, HelpArticleChanges, HelpArticleColumnChanges, HelpArticleDiff,
                                        HelpArticlesRoute, HelpArticlesPolicies
  entity/help-articles.entity.ts        class HelpArticle, class HelpArticleSummary
  dto/help-articles.request.dto.ts      ListHelpArticlesQueryDto, CreateHelpArticleDto, UpdateHelpArticleDto
  dto/help-articles.response.dto.ts     HelpArticleResponseDto, HelpArticleSummaryResponseDto
  repository/help-articles.repo.ts      HELP_ARTICLE_COLUMNS, HELP_ARTICLE_SUMMARY_COLUMNS, listHelpArticlesQuery, listHelpArticles,
                                        findVisibleHelpArticle, findLiveHelpArticleForUpdate, insertHelpArticle, updateHelpArticle,
                                        softDeleteHelpArticle (functions, private toEntity)
  service/help-articles.service.ts      HelpArticlesService (@injectable)
  policies.ts                           HELP_ARTICLES_POLICIES
  controller/help-articles.controller.ts HelpArticlesController (@injectable, arrow-function methods)
  routes.ts                             buildHelpArticlesRouter()
src/routes.ts                           mounts buildHelpArticlesRouter(); exports PRIVATE_NO_CACHE_PREFIXES
src/app.ts                              mounts markPreAuth(privateNoCache()) per prefix, before the JSON parser
src/bootstrap.ts                        registers HelpArticlesService, HelpArticlesController
src/lib/di/tokens.ts                    HelpArticlesService, HelpArticlesController tokens
src/lib/http/private-no-cache.ts        privateNoCache() (new, beside no-store.ts)
src/lib/http/pagination/cursor.ts       decodeKindedTimestampCursor (new, §3.7)
src/migrations/<ts>_create_help_articles.ts
tests/…                                 §9
```
Every type alias and interface lives in `types.ts` (ESLint enforces it). Constants live in the module's `constants.ts`
(precedent: specialties).

### 3.4 Entities (`entity/help-articles.entity.ts`)
```ts
export class HelpArticle {
    id!: number; title!: string; body!: string; category!: HelpArticleCategory; audience!: HelpArticleAudience;
    isPublished!: boolean; publishedAt!: Date | null; createdAt!: Date; updatedAt!: Date;
    constructor(data: Partial<HelpArticle>) { Object.assign(this, data); }
}
export class HelpArticleSummary {
    id!: number; title!: string; category!: HelpArticleCategory; audience!: HelpArticleAudience;
    isPublished!: boolean; publishedAt!: Date | null; updatedAt!: Date;
    constructor(data: Partial<HelpArticleSummary>) { Object.assign(this, data); }
}
```
Plain classes, no decorators, no DB knowledge. A summary has no `body` member, so the list cannot leak it by accident.

### 3.5 Request DTOs (`dto/help-articles.request.dto.ts`)
Validated with `lib/validation` (`whitelist`, `forbidNonWhitelisted`, `forbidUnknownValues`; implicit conversion off, so
every non-string query field carries `ToBoolean()`). Length is counted in **Unicode code points** (`CodePointLength`,
`lib/validation/string-decorators.ts`), the unit of the contract and of Postgres `char_length`.
```ts
export class ListHelpArticlesQueryDto extends PaginationQueryDto {   // cursor?: IsOptional IsString MaxLength(1024); limit?: ToInt IsInt Min(1) Max(100) = 20
    @IsOptional() @IsEnum(HelpArticleCategory)
    category?: HelpArticleCategory;

    @IsOptional() @IsEnum(HelpArticleAudience)       // validated for every role, applied only for admins (HA-D10)
    audience?: HelpArticleAudience;

    @IsOptional() @ToBoolean() @IsBoolean()          // "true" -> true, "false" -> false; anything else -> 400; applied only for admins
    isPublished?: boolean;
}

export class CreateHelpArticleDto {
    @IsString() @CodePointLength(HELP_ARTICLE_TITLE_MIN_LENGTH, HELP_ARTICLE_TITLE_MAX_LENGTH) @NoControlCharacters("all")
    title!: string;

    @IsString() @CodePointLength(HELP_ARTICLE_BODY_MIN_LENGTH, HELP_ARTICLE_BODY_MAX_LENGTH) @NoControlCharacters("nul")
    body!: string;                                    // Markdown: newlines and tabs are valid; only NUL is refused (Postgres cannot store it)

    @IsEnum(HelpArticleCategory) category!: HelpArticleCategory;
    @IsEnum(HelpArticleAudience) audience!: HelpArticleAudience;
    @IsBoolean() isPublished!: boolean;               // required, no default

    toInput(): HelpArticleCreateInput;
}

export class UpdateHelpArticleDto {                   // every member: ValidateIf(value !== undefined) -> absent is skipped, null fails
    title?: string; body?: string; category?: HelpArticleCategory; audience?: HelpArticleAudience; isPublished?: boolean;
    isEmpty(): boolean;                               // minProperties: 1 (never Object.keys: class fields are defined as undefined)
    toChanges(): HelpArticleChanges;                  // only the members that are !== undefined
}
```
- Same rules per member as on create; unknown members (`id`, `createdAt`, `publishedAt`, `createdBy`) → `400`
  `"is not allowed"`. `publishedAt` cannot be set by a client: it is derived from `isPublished`.
- `{}` on `PATCH` passes class-validator; the controller rejects it with `EmptyHelpArticleUpdate` (§6).
- **No trimming and no case folding** (contract-exact): `"  x"` is a valid 3-character title; a whitespace-only `body`
  is valid. Accepted trade-off, as in specialties.
- `title` refuses every `\p{Cc}` control character (a title is one line of display text); `body` refuses only NUL.
- Rejected values are never echoed in error details.

### 3.6 Response DTOs (`dto/help-articles.response.dto.ts`)
```ts
export class HelpArticleResponseDto {
    id!: number; title!: string; body!: string; category!: HelpArticleCategory; audience!: HelpArticleAudience;
    isPublished!: boolean; publishedAt!: string | null; createdAt!: string; updatedAt!: string;
    static from(entity: HelpArticle): HelpArticleResponseDto;            // explicit copy; dates via toISOString()
}
export class HelpArticleSummaryResponseDto {
    id!: number; title!: string; category!: HelpArticleCategory; audience!: HelpArticleAudience;
    isPublished!: boolean; publishedAt!: string | null; updatedAt!: string;
    static from(entity: HelpArticleSummary): HelpArticleSummaryResponseDto;
}
```
No `viewer` parameter: the shape does not depend on the role (the module has no clinical field; the role only changes
*which rows* are visible). Timestamps on the wire are millisecond ISO strings with `Z`; microsecond precision matters
only inside cursors.

### 3.7 Repository (`repository/help-articles.repo.ts`)
```ts
export const HELP_ARTICLE_COLUMNS = ["id", "title", "body", "category", "audience", "is_published", "published_at", "created_at", "updated_at"] as const;
export const HELP_ARTICLE_SUMMARY_COLUMNS = ["id", "title", "category", "audience", "is_published", "published_at", "updated_at"] as const;

/** The keyset page query, exported so the EXPLAIN test inspects exactly what runs. */
export function listHelpArticlesQuery(params: ListHelpArticlesParams, conn: Knex = db): Knex.QueryBuilder;
export async function listHelpArticles(params: ListHelpArticlesParams, conn: Knex = db): Promise<HelpArticleSummaryRow[]>;
export async function findVisibleHelpArticle(id: number, visibility: HelpArticleVisibility, conn: Knex = db): Promise<HelpArticle | undefined>;
export async function findLiveHelpArticleForUpdate(id: number, conn: Knex.Transaction): Promise<HelpArticle | undefined>;
export async function insertHelpArticle(input: HelpArticleCreateInput, actorUserId: number, conn: Knex.Transaction): Promise<HelpArticle>;
export async function updateHelpArticle(id: number, changes: HelpArticleColumnChanges, actorUserId: number, conn: Knex.Transaction): Promise<HelpArticle>;
export async function softDeleteHelpArticle(id: number, actorUserId: number, conn: Knex.Transaction): Promise<void>;
// private: function toEntity(row: HelpArticleRow): HelpArticle ; function toSummary(row: HelpArticleSummaryRow): HelpArticleSummary
```
Types: `ListHelpArticlesParams = { scope: { kind: "reader"; audience: HelpArticleAudience; category?: HelpArticleCategory } | { kind: "admin"; audience?; category?; isPublished? }; after: StringCursorPosition | null; fetch: number }` (`after.sortValue` is the bare timestamp; the service strips the kind prefix). `HelpArticleVisibility = { kind: "reader"; audience } | { kind: "admin" }`. Write functions take a `Knex.Transaction`.

| Function | SQL (explicit columns, never `SELECT *`; `deleted_at IS NULL` on every read) |
|---|---|
| `listHelpArticlesQuery` (reader) | `SELECT <summary columns>, to_char(published_at AT TIME ZONE 'UTC', …US…) AS sort_cursor FROM help_articles WHERE audience = ? AND is_published = true AND deleted_at IS NULL` + `AND category = ?` + `AND (published_at, id) < (?::timestamptz, ?::bigint)` when `after` + `ORDER BY published_at DESC, id DESC LIMIT ?` |
| `listHelpArticlesQuery` (admin) | `SELECT <summary columns>, to_char(updated_at …) AS sort_cursor FROM help_articles WHERE deleted_at IS NULL` + `AND audience = ?` / `AND is_published = ?` / `AND category = ?` per filter + `AND (updated_at, id) < (?::timestamptz, ?::bigint)` when `after` + `ORDER BY updated_at DESC, id DESC LIMIT ?` |
| `findVisibleHelpArticle` | `SELECT <columns> FROM help_articles WHERE id = ? AND deleted_at IS NULL` + (reader) `AND audience = ? AND is_published = true` |
| `findLiveHelpArticleForUpdate` | `SELECT <columns> FROM help_articles WHERE id = ? AND deleted_at IS NULL FOR UPDATE` |
| `insertHelpArticle` | `INSERT INTO help_articles (title, body, category, audience, is_published, published_at, created_by, updated_by) VALUES (?, ?, ?, ?, ?, <now() when published else NULL>, ?, ?) RETURNING <columns>` |
| `updateHelpArticle` | `UPDATE help_articles SET <changed columns>, [published_at = COALESCE(published_at, CURRENT_TIMESTAMP) when isPublished becomes true], updated_by = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND deleted_at IS NULL RETURNING <columns>` |
| `softDeleteHelpArticle` | `UPDATE help_articles SET deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP, updated_by = ? WHERE id = ? AND deleted_at IS NULL` |

- **Timestamp cursors never travel through a JS `Date`** (foundation fix #7): the sort column is selected with
  `timestampCursorSelect(conn, "<column>", "sort_cursor")` (6-digit microsecond ISO) and compared back with `?::timestamptz`.
- The list never selects `body`, `created_by`, `updated_by`, or `created_at`.
- `updated_at` is set by the statement (no trigger); `CURRENT_TIMESTAMP` is the transaction start time.
- **Cursor with a sort kind (HA-D1).** The generic `[sortValue, id]` cursor format is unchanged. The sort value is the string
  `<kind>:<µs timestamp>` (`published:2026-10-29T10:00:00.123456Z`). `lib/http/pagination/cursor.ts` gains
  ```ts
  /** A position whose sort value is `<kind>:<µs timestamp>`; the kind must equal `expectedKind`, the timestamp must be a real instant. */
  export function decodeKindedTimestampCursor(cursor: string, expectedKind: string): StringCursorPosition;
  ```
  built on `decodeTextCursor` (cap 40 code points: the longest kind `published:` is 10, plus 27 for the timestamp) and the
  `decodeTimestampCursor` timestamp rule. A wrong kind, a missing prefix, a bad timestamp, or NUL → the existing
  `400` `[{ field: "cursor", issue: "is invalid" }]`. It lives in `lib/http/pagination` because it is generic cursor
  handling, not a Care rule. The page is built with `buildPage(rows, limit, (row) => [`${kind}:${row.sort_cursor}`, row.id])`.

### 3.8 Controller (`controller/help-articles.controller.ts`)
```ts
@injectable()
export class HelpArticlesController {
    constructor(@inject(TOKENS.HelpArticlesService) private readonly service: HelpArticlesService) {}

    list = async (req: Request, res: Response): Promise<void> => {
        const query = await validateQuery(ListHelpArticlesQueryDto, req.query);
        const page = await this.service.list(requireAuth(req), query);
        sendSuccess(res, page.items.map((item) => HelpArticleSummaryResponseDto.from(item)), { meta: { ...page.meta } });
    };
    get = async (req: Request, res: Response): Promise<void> => {
        const id = parsePositiveId(req.params.id);
        if (id === undefined) throw NotFound;
        sendSuccess(res, HelpArticleResponseDto.from(await this.service.get(requireAuth(req), id)));
    };
    create = async (req: Request, res: Response): Promise<void> => {
        const dto = await validateBody(CreateHelpArticleDto, req.body);
        const created = await this.service.create(requireAuth(req), dto.toInput());
        sendSuccess(res, HelpArticleResponseDto.from(created), { status: 201 });
    };
    update = async (req: Request, res: Response): Promise<void> => {
        const id = parsePositiveId(req.params.id);
        if (id === undefined) throw NotFound;
        const dto = await validateBody(UpdateHelpArticleDto, req.body);
        if (dto.isEmpty()) throw EmptyHelpArticleUpdate;
        sendSuccess(res, HelpArticleResponseDto.from(await this.service.update(requireAuth(req), id, dto.toChanges())));
    };
    remove = async (req: Request, res: Response): Promise<void> => {
        const id = parsePositiveId(req.params.id);
        if (id === undefined) throw NotFound;
        await this.service.remove(requireAuth(req), id);
        sendNoContent(res);
    };
}
```
Order on `PATCH`: guard → `authorize` (a patient gets `403` for any id) → id (`404`) → body (`400`) → service (`404`, `409`).
No business logic in the controller.

### 3.9 Service (`service/help-articles.service.ts`) and constants
```ts
@injectable()
export class HelpArticlesService {
    constructor(
        @inject(TOKENS.Db) private readonly db: Knex,
        @inject(TOKENS.AuditRecorder) private readonly audit: AuditRecorder,
    ) {}
    list(viewer: AuthContext, query: ListHelpArticlesQueryDto): Promise<Page<HelpArticleSummary>>;
    get(viewer: AuthContext, id: number): Promise<HelpArticle>;
    create(actor: AuthContext, input: HelpArticleCreateInput): Promise<HelpArticle>;
    update(actor: AuthContext, id: number, changes: HelpArticleChanges): Promise<HelpArticle>;
    remove(actor: AuthContext, id: number): Promise<void>;
    // private audienceOf(role): HelpArticleAudience   (patient -> patient, doctor -> doctor; Care rule R5)
    // private diff(current: HelpArticle, changes: HelpArticleChanges): HelpArticleDiff   (Care rule HA-D9)
    // private toConflict(error: unknown): unknown   (constraint name -> HelpArticleTitleTaken)
}
```
**`list`** (no transaction; one query):
1. `limit = resolveLimit(query.limit)`.
2. Admin: `kind = "updated"`, scope `{ kind: "admin", audience: query.audience, category: query.category, isPublished: query.isPublished }`. Anyone else: `kind = "published"`, scope `{ kind: "reader", audience: audienceOf(viewer.role), category: query.category }` — `audience` and `isPublished` from the query are ignored (HA-D10).
3. `after = query.cursor === undefined ? null : decodeKindedTimestampCursor(query.cursor, kind)`; the bare timestamp is passed to the repository.
4. `rows = await listHelpArticles({ scope, after, fetch: limit + 1 }, this.db)`; return `buildPage(rows, limit, …)` with the kind-tagged position.

**`get`**: `findVisibleHelpArticle(id, viewer.role === "admin" ? { kind: "admin" } : { kind: "reader", audience: audienceOf(viewer.role) }, this.db)`; `undefined` → `NotFound`.

**`create`**: one transaction (Knex handler form), `catch` outside it:
```ts
try {
    return await this.db.transaction(async (trx) => {
        const created = await insertHelpArticle(input, actor.userId, trx);
        await this.audit.record(trx, {
            actor: actorFromAuth(actor), action: HelpArticleAuditAction.Created, entityType: HELP_ARTICLE_ENTITY_TYPE,
            entityId: created.id, metadata: { isPublishedBefore: null, isPublishedAfter: created.isPublished },
        });
        return created;
    });
} catch (error) { throw this.toConflict(error); }
```
**`update`**: one transaction: `findLiveHelpArticleForUpdate` (`undefined` → `NotFound`) → `diff` → if no field changed, return the current article (no `UPDATE`, no audit) → `updateHelpArticle` → `audit.record` with `action: Updated`, `metadata: { changedFields: diff.fields.join(","), isPublishedBefore: current.isPublished, isPublishedAfter: updated.isPublished }` → return. `catch` outside, `toConflict`.
- `diff`: a field counts as changed only when provided (`!== undefined`) **and** different from the stored value (exact string equality for `title`/`body`, equality for the enums and the boolean). `fields` = API names (`HelpArticleField`) sorted alphabetically; `columns` = the same in snake_case. Setting `title` to its own current value is therefore never a `409` against itself. When `isPublished` changes from `false` to `true`, the repository adds the `COALESCE(published_at, now())` assignment.

**`remove`**: one transaction: `findLiveHelpArticleForUpdate` (`undefined` → `NotFound`) → `softDeleteHelpArticle` → `audit.record` with `action: Deleted`, `metadata: { isPublishedBefore: current.isPublished, isPublishedAfter: null }` (`null` = no longer visible to anyone).

**`toConflict(error)`**: `uniqueViolationConstraint(error)` (`lib/knex/pg-errors.ts`) equal to `HELP_ARTICLE_TITLE_CONSTRAINT` → `HelpArticleTitleTaken`; anything else is returned unchanged and rethrown. The audit write sits inside the transaction, so a failed audit insert rolls the write back (`500 InternalError`).

No call to Identity, storage, or video; nothing happens after the transaction.

Rate-limit constants (`constants.ts`): `HELP_ARTICLES_READ_USER_LIMIT = 120`, `HELP_ARTICLES_WRITE_USER_LIMIT = 20`,
`HELP_ARTICLES_RATE_WINDOW_MS = 60_000`. Constants, not env variables.

### 3.10 Policies (`policies.ts`)
```ts
const READER_STATES = { statuses: { doctor: ["pending", "active", "rejected"] } } as const;   // HA-D14; patient and admin: default ["active"]
export const HELP_ARTICLES_POLICIES: HelpArticlesPolicies = {
    list:   { kind: "user", roles: ["patient", "doctor", "admin"], owner: { kind: "none" }, accountState: READER_STATES },
    get:    { kind: "user", roles: ["patient", "doctor", "admin"], owner: { kind: "none" }, accountState: READER_STATES },
    create: { kind: "user", roles: ["admin"], owner: { kind: "none" }, audit: "admin-action" },
    update: { kind: "user", roles: ["admin"], owner: { kind: "none" }, audit: "admin-action" },
    remove: { kind: "user", roles: ["admin"], owner: { kind: "none" }, audit: "admin-action" },
};
// types.ts: HelpArticlesRoute = "list" | "get" | "create" | "update" | "remove"; HelpArticlesPolicies = Readonly<Record<HelpArticlesRoute, UserPolicy>>
```
- Matches `x-roles`, `x-ownership`, `x-account-state` and `x-audit` of the five operations. No `checks`: the doctors module's
  `doctor_not_suspended` check guards **practising** actions; reading help is not one (a locally suspended doctor whose
  token is still `active` may read until the token expires, as for `GET /specialties`).
- Row-level visibility (published, own audience, live) is a **query predicate**, not an ownership resolver: ownership is
  `none` because articles belong to no user. The predicate depends only on `req.auth.role`, never on the request.
- `suspended` is never admitted (`authorize` rejects such a policy at boot and a suspended token at request time).

### 3.11 DI
| Token (`lib/di/tokens.ts`) | Registration (`src/bootstrap.ts`) |
|---|---|
| `HelpArticlesService: Symbol.for("HelpArticlesService")` | `container.registerSingleton(TOKENS.HelpArticlesService, HelpArticlesService)` |
| `HelpArticlesController: Symbol.for("HelpArticlesController")` | `container.registerSingleton(TOKENS.HelpArticlesController, HelpArticlesController)` |

Every constructor parameter uses `@inject(TOKENS.X)` (ADR 0016).

---

## 4. Business rules

| # | Rule (testable) | Enforced by |
|---|---|---|
| HA-R1 | `body` is stored and returned verbatim: no trimming, normalisation, rendering, or HTML handling; newlines and tabs survive a round trip | repository (no transform) + response DTO |
| HA-R2 | `title` is 3-200 code points with no control character; `body` is 1-50,000 code points with no NUL; `category` and `audience` are from the enums; every violation is `400` with the member as `field` and never a database error | DTO (400) + `chk_help_articles_title_length`, `chk_help_articles_body_length`, `chk_help_articles_category`, `chk_help_articles_audience`, `VARCHAR(200)` |
| HA-R3 | `(audience, title)` is unique among live articles (case-sensitive, exact); a duplicate on create or update → `409 Conflict` with `details[0].field = "title"`; nothing is written and no audit row is left | `uq_help_articles_audience_title` + `toConflict` |
| HA-R4 | Creating with `isPublished=true` sets `published_at = now()`; the first transition to published stamps it; unpublish keeps it; a re-publish keeps the original value; `is_published` implies `published_at IS NOT NULL` | service/repository (`COALESCE`) + `chk_help_articles_published` |
| HA-R5 | A patient or doctor sees only published, live articles whose audience equals their role (`patient` → `patient`, `doctor` → `doctor`); any other article is absent from the list and `404` on `GET /{id}`, with the same body as an unknown id | repository query predicates + service `audienceOf` |
| HA-R6 | An admin sees drafts and published live articles of both audiences, and may filter by `audience`, `isPublished`, `category`; deleted articles are never shown | repository + service |
| HA-R7 | `audience` and `isPublished` query values are validated for every role (junk → `400`) and applied only for admins; patients and doctors ignore them; `category` applies to every role | DTO + service (HA-D10) |
| HA-R8 | A deleted article is `404` on get, patch, and delete for every role, admins included; its title can be reused by a new live article | `deleted_at IS NULL` in every read + partial unique index |
| HA-R9 | `PATCH` changes only the provided members; `category` and `audience` of a published article can change without unpublishing; the resulting `(audience, title)` must be free | service `diff` + unique index |
| HA-R10 | A `PATCH` whose provided values all equal the stored ones answers `200` with the current article, leaves `updated_at` unchanged, and writes no audit row; a partly-equal `PATCH` audits only the changed field names | `HelpArticlesService.diff` |
| HA-R11 | `PATCH` with `{}` → `400` (`body: must contain at least one property`); a `null` member → `400`; unknown members (`publishedAt`, `id`) → `400` | DTO + controller |
| HA-R12 | Every create, effective update, and delete writes exactly one audit row (`help_article.created|updated|deleted`, entity `help_article`, the admin as actor, the request id) in the same transaction; `metadata` holds only `isPublishedBefore`, `isPublishedAfter`, and (update) `changedFields` — never `title` or `body` | service + `AuditRecorder` (rejects redacted keys such as `body`) |
| HA-R13 | A rolled-back write (409, audit failure, any error) leaves neither the row change nor an audit row | one transaction (Knex handler form) |
| HA-R14 | Reads (`list`, `get`) write no audit row | service (no `audit.record`) |
| HA-R15 | Writes are admin-only: patient and doctor get `403` on `POST`, `PATCH`, `DELETE` for any id, before the id is parsed | `authorize` |
| HA-R16 | Read access by account status: doctor `pending`, `active`, `rejected` may read; patient and admin must be `active`; a `suspended` or `pending` patient, a `pending` admin, or any suspended token → `403`; writes need an `active` admin | `authorize` + `accountState` |
| HA-R17 | The list is ordered `published_at DESC, id DESC` for non-admins and `updated_at DESC, id DESC` for admins; the cursor encodes `(kind:timestamp, id)` at microsecond precision; paging through returns every visible row exactly once; a cursor of the other kind → `400` | repository keyset + `decodeKindedTimestampCursor` + `buildPage` |
| HA-R18 | The list item never contains `body`; the detail does | `HelpArticleSummary` entity and DTO |
| HA-R19 | `POST` with an `Idempotency-Key`: same key + same body → the original `201` replayed (one row, one audit row); same key + different body → `422 IdempotencyConflict`; same key in flight → `409` + `Retry-After: 1`; without a key the request is accepted (a second identical `POST` is then `409` by HA-R3) | `idempotency({ required: false })` |
| HA-R20 | Reads are limited to 120/min per user and writes to 20/min per user (one shared bucket); excess → `429 RateLimited` + `Retry-After`; Redis down → per-instance fallback | `rateLimit` (HA-D2) |
| HA-R21 | Every response under `/api/help-articles`, errors included, carries `Cache-Control: private, no-cache` | `privateNoCache()` prefix middleware |
| HA-R22 | Two concurrent creates of the same `(audience, title)`: exactly one `201`, the other `409` | `uq_help_articles_audience_title` |
| HA-R23 | An article is never hard-deleted: `vcare_app` has no `DELETE` or `TRUNCATE` (42501) | migration grants |
| HA-R24 | Article text (`title`, `body`) appears in no log line and no audit row | logger redaction (`body`) + no logging of bodies + HA-R12 |

---

## 5. Cross-service behavior

None. No call to identity-service (Cases 1-4 do not apply), no worker loop, no storage, no video, no email, no Redis cache
of content. The only Identity-related step is the existing local token verification of `userGuard`. The only failure
mode beyond input errors is Postgres being down (`503` from the readiness probe, `500` on a request).

The Phase-2 read path `GET /internal/help-articles` (`help:read`, tombstones) is **designed in ADR 0028 and not built
here** (O5). Nothing in this module blocks it: `updated_at` is maintained only on real changes (HA-R10), soft deletes keep
the row, and `idx_help_articles_updated_at_id` is partial on live rows, so the tombstone read will need its own index
review when built (ADR 0028 consequences). Hub `data-ownership.md`, `landscape.md` and `TODO.md` already name the
endpoint and the `help:read` provisioning, so no platform change is needed.

---

## 6. Error codes

No new code; all are in the contract `ErrorCode` enum and in CLAUDE.md → API conventions.

| Code | HTTP | When (this module) | Emitted by |
|---|---|---|---|
| `ValidationFailed` | 400 | invalid query (`cursor` malformed, over 1024 characters, of the other sort kind, or a bad timestamp; `limit` not a canonical integer 1-100; `category`/`audience` not in the enum; `isPublished` not `true`/`false`; unknown query member); invalid body (HA-R2, unknown or `null` members, non-object body, body over 100 kb); empty `PATCH` body; `Idempotency-Key` not a UUID | `lib/validation`, controller, `idempotency`, `errorHandler` |
| `Unauthorized` / `TokenExpired` | 401 | missing, invalid, or expired bearer token | `userGuard` |
| `Forbidden` | 403 | role not in the policy (patient or doctor on a write); account status not allowed (pending or suspended patient, pending admin, any suspended token) | `authorize` |
| `NotFound` | 404 | unknown, non-canonical, deleted, unpublished (non-admin), or other-audience (non-admin) id on `GET /{id}`; unknown, non-canonical, or deleted id on `PATCH`/`DELETE` | controller, service |
| `Conflict` | 409 | duplicate live `(audience, title)` on create or update (`details: [{ field: "title", issue: "is already in use for this audience" }]`); `POST` with an `Idempotency-Key` whose first request is in flight (`Retry-After: 1`) | service, `idempotency` |
| `IdempotencyConflict` | 422 | same `Idempotency-Key`, different body (`POST` only) | `idempotency` |
| `RateLimited` | 429 | a limiter tripped (`Retry-After` >= 1) | `rateLimit` |
| `InternalError` | 500 | unhandled error, including a failed audit insert (the write rolls back) | `errorHandler` |

Module error constants (`errors.ts`):
```ts
export const HelpArticleTitleTaken = new AppError("Conflict", 409, "A help article with this title already exists for this audience",
    [{ field: "title", issue: "is already in use for this audience" }]);
export const EmptyHelpArticleUpdate = ValidationFailed.withDetails([{ field: "body", issue: "must contain at least one property" }]);
```
Details never echo the rejected value.

---

## 7. Security & privacy

- **RBAC summary:** reads for patient (`active`), doctor (`pending`/`active`/`rejected`), admin (`active`); writes admin-only; ownership `none` on all five routes; deny by default through `authorize`; the boot assertion proves every route is guard then authorize. `X-User-Id`, `X-Role` and any identity header are ignored; no request member influences authorization or the audience filter (the audience comes from the verified token role).
- **No admin-versus-clinical split applies**: help articles carry no clinical field, so admins read them (drafts included) and the "admin denied on every clinical route" scenario does not apply to this module.
- **Non-admin existence privacy:** unpublished, other-audience, and deleted ids are `404` with the same body as an id that never existed. An `audience` or `isPublished` query value from a non-admin never widens the result (HA-D10).
- **Audit events:** `help_article.created`, `help_article.updated`, `help_article.deleted`, class `admin-action`, entity type `help_article`, entity id = the article id, actor the admin (`actorFromAuth`), `request_id` = the request's id. `metadata` keys: `isPublishedBefore`, `isPublishedAfter`, `changedFields` (names only). A no-op `PATCH` writes none. Reads write none.
- **Never logged or audited:** `title`, `body`, `Authorization`, tokens, request bodies (the request logger never logs bodies), rate-limit subjects. `body` is a redacted logger key (HA-D6), and `AuditRecorder` refuses a metadata key that the logger redacts. Article text is not clinical, but it stays out of logs and audit by rule so a later richer corpus cannot leak through them.
- **Markdown is untrusted for rendering** even though only admins author it: the contract states that clients must sanitise and must not render raw HTML. Care stores and returns text only and sets no HTML content type (`application/json`).
- **Database privileges:** `vcare_app` holds `SELECT, INSERT, UPDATE` + sequence `USAGE` on `help_articles`; no `DELETE`, no `TRUNCATE` (HA-R23).
- **Rate limits:** reads 120/min per user, writes 20/min per user (one bucket). No per-IP limiter (HA-D2).
- **Caching headers:** `Cache-Control: private, no-cache` (HA-D7). Not `no-store`: the content is not clinical. Express's default weak `ETag` lets a revalidating client receive `304`; that is standard HTTP behaviour, not an operation response, and is not added to the contract.
- **Files:** none. Articles carry no attachments or images (out of scope).

---

## 8. Performance

CLAUDE.md → Performance rules sets the 200 ms read budget for detail-style reads; this module has no budget of its own
and its traffic is inside the 300 k/day "other reads" line of [capacity.md](../architecture/capacity.md) (no headline changes).

| Path | Queries / round trips | Index | Target (p95, server) |
|---|---|---|---|
| `GET /help-articles` (reader) | 1 `SELECT … LIMIT n+1`; 1 Redis `EVAL` (user limiter); 0 Identity, 0 audit | `idx_help_articles_audience_published_at_id` | < 50 ms |
| `GET /help-articles` (admin) | same | `idx_help_articles_updated_at_id` | < 50 ms |
| `GET /help-articles/{id}` | 1 `SELECT` by PK + predicates; 1 Redis `EVAL` | PK | < 50 ms |
| `POST` | `BEGIN`, `INSERT … RETURNING`, audit `INSERT`, `COMMIT` (+ Redis `SET NX`/`SET` when a key is sent) | PK + `uq_help_articles_audience_title` | < 200 ms |
| `PATCH` | `BEGIN`, `SELECT … FOR UPDATE`, `UPDATE … RETURNING`, audit `INSERT`, `COMMIT` (no-op: `BEGIN`, `SELECT`, `COMMIT`) | PK | < 200 ms |
| `DELETE` | `BEGIN`, `SELECT … FOR UPDATE`, `UPDATE`, audit `INSERT`, `COMMIT` | PK | < 200 ms |

- No N+1, no `SELECT *`, `limit + 1` fetch (no `COUNT`), summaries only in lists (a 20-row page of full bodies could reach about 1 MB; ADR 0027).
- No Redis cache of content (ADR 0027): one indexed statement per read.
- `EXPLAIN` of both list queries is part of the integration suite (§9.2).

---

## 9. Test plan outline

Names follow `should <do something> when <condition>`. Unit tests mock collaborators (repository functions, the Knex
transaction, `AuditRecorder`, Redis, clock). Integration tests use the real wiring, real Postgres as `care_app` (the
owner connection only for setup and assertions), real Redis, and the fake JWKS (as in `tests/integration/audit.test.ts`).
Every suite runs `truncateAll()` and `flushByPrefix(["idem:", "rl:"])` in `beforeEach`. Fixtures are synthetic (titles
like `Synthetic Article 001`, a body containing the marker `SYNTHETIC-HELP-BODY-7731`); order-sensitive fixtures share a
prefix so the order is the same under any collation.

### 9.1 Unit (`tests/unit/`)
- `app/help-articles/help-articles.request.dto.test.ts`: list — should accept category, audience, isPublished "true"/"false" and default limit to 20 · **assert the `design:type` metadata of `isPublished` is `Boolean` first** (compiled-build condition of #8) · should reject isPublished "yes", "1", "TRUE", "", and a repeated value, category "other", audience "admin" · should reject limit "0", "101", "1.5", "1e1", "05". create — should accept a valid body · should reject title of 2 and 201 code points, title with a newline or other control character, body of 0 and 50,001 code points, body containing NUL, a missing `isPublished`, `isPublished: "true"`, and the members `id`, `publishedAt`, `createdAt` (HA-R2) · should accept a body with newlines, tabs and astral characters (code-point counting) · update — should report isEmpty for `{}` and for a body of undefined members (HA-R11) · should reject null in every member · should omit absent members from toChanges.
- `app/help-articles/help-articles.response.dto.test.ts`: should copy every field and render dates with `toISOString` · should produce exactly the contract `HelpArticle.required` keys and exactly the `HelpArticleSummary.required` keys, with no `body` on the summary (HA-R18).
- `app/help-articles/help-articles.service.test.ts`: list — should use scope reader with `audienceOf(role)` for a patient and a doctor and ignore their `audience` and `isPublished` (HA-R5, HA-R7) · should use the admin scope with the admin's filters · should pick sort kind `published` for readers and `updated` for admins and reject a cursor of the other kind (HA-R17) · should fetch limit + 1 and build the kind-tagged cursor. get — should query the reader visibility for non-admins and the admin visibility for admins · should throw NotFound when the row is absent. create — should insert then audit inside one transaction with action `help_article.created`, entity `help_article`, the actor from auth, metadata `{ isPublishedBefore: null, isPublishedAfter }` and no title or body (HA-R12) · should map 23505 on `uq_help_articles_audience_title` to `HelpArticleTitleTaken` (HA-R3) · should rethrow a 23505 on another constraint and a non-pg error unchanged · should reject (so Knex rolls back) when the audit throws (HA-R13). update — should throw NotFound when the row is absent or deleted (HA-R8) · should return the current row with no update and no audit when nothing changed (HA-R10) · should audit only the changed names, sorted, with `isPublishedBefore`/`After` (HA-R12) · should ask the repository to stamp `published_at` only when `isPublished` goes false to true (HA-R4) · should allow `category` and `audience` change on a published article (HA-R9) · should map 23505 like create. remove — should soft delete, audit `help_article.deleted` with `isPublishedAfter: null`, and throw NotFound for an absent or deleted row.
- `app/help-articles/help-articles.policies.test.ts`: should read `x-roles`, `x-ownership`, `x-account-state` and `x-audit` from `contracts/openapi.yaml` (`contractOperationBlock`) and equal the policies for each route · should admit doctor `pending`/`active`/`rejected` only on list and get · should build without throwing via `authorize()`.
- `app/help-articles/help-articles.routes.test.ts`: should compose GET as [guard, authorize, rateLimit, handler], POST as [guard, authorize, rateLimit, idempotency, handler], PATCH and DELETE as [guard, authorize, rateLimit, handler] (markers) · should pass `assertRoutesAuthorized` · should register no `router.param`.
- `lib/http/private-no-cache.test.ts`: should set `Cache-Control: private, no-cache` when applied and not when absent.
- `lib/http/pagination.test.ts`: `decodeKindedTimestampCursor` — should accept `published:<µs>` for kind `published` · should reject the other kind, a missing prefix, a millisecond-only timestamp, a non-existent date, NUL, and a value over 40 code points.
- `lib/logger/redact.test.ts`: should redact `body` in a help-articles-shaped payload (HA-D6) · should redact it nested in `requestBody`.
- `contract/help-articles-contract.test.ts`: should declare `HelpArticleSummary` with exactly the seven required members and no `body` · should reference it from `listHelpArticles` · should carry `x-account-state` on the two read operations · should declare `CacheControlPrivateNoCache` on the list 200, `HelpArticleOk`, and `HelpArticleCreated` · should keep `x-audit-actions` on the three writes (precedent: `records-contract.test.ts`).

### 9.2 Integration — `tests/integration/help-articles.test.ts` (routes mounted by the real `src/routes.ts`)
**RBAC per route** (CLAUDE.md → Testing policy; tokens: patient 101, doctor 202, admin 303):

| Route | none | patient active | doctor active | doctor pending / rejected | admin active | patient pending · admin pending · any suspended |
|---|---|---|---|---|---|---|
| `GET /api/help-articles` | 401 `Unauthorized` | 200 | 200 | 200 | 200 | 403 `Forbidden` |
| `GET /api/help-articles/{id}` | 401 | 200 / 404 | 200 / 404 | 200 / 404 | 200 / 404 | 403 |
| `POST /api/help-articles` | 401 | 403 | 403 | 403 | 201 | 403 |
| `PATCH /api/help-articles/{id}` | 401 | 403 | 403 | 403 | 200 | 403 |
| `DELETE /api/help-articles/{id}` | 401 | 403 | 403 | 403 | 204 | 403 |

Plus: expired token → 401 `TokenExpired` · a patient token with `X-Role: admin` / `X-User-Id: 303` → still 403 on every write · patient `PATCH /api/help-articles/abc` → 403 (role before id) · admin `GET/PATCH/DELETE /api/help-articles/abc`, `/0`, `/007`, `/9007199254740993`, `/999999` → 404. There is no non-owner case (ownership `none`) and no clinical route (the "admin denied on clinical routes" scenario does not apply).

**Visibility (HA-R5 to HA-R8):** with four seeded articles (patient published, patient draft, doctor published, doctor deleted) — a patient lists and gets only the patient-published one and gets `404` for the other three ids, with a body identical to an unknown id · a doctor (`active`, `pending`, `rejected`) sees only the doctor-published one · a patient passing `audience=doctor&isPublished=false` still gets only the patient-published one (HA-R7) · `category` filters for every role · an admin sees the three live rows, filters by `audience`, `isPublished`, `category`, gets `200` for a draft by id and `404` for the deleted one.

**Pagination (HA-R17):** **should reach page 2 and the last page on the default sort** (45 published rows, default limit 20: 20 + 20 + 5, exact `published_at DESC, id DESC` order, no duplicates) for a patient, and the same for an admin on `updated_at DESC, id DESC` · should page 30 rows that share one millisecond without skipping or repeating one (microsecond cursor) · should keep a valid cursor when the cursor row is unpublished or deleted between pages (position, not grant) · should return 400 `cursor` for a tampered cursor, a numeric sort value, the other sort kind (an admin cursor given to a patient and the reverse), and a millisecond-only timestamp · should return an empty page `{ nextCursor: null, hasMore: false, count: 0 }` · every page matches `PaginationMeta` and `HelpArticleSummary` and has no `body` (HA-R18).

**Create:** should return 201 with the contract `HelpArticle`, `publishedAt` set when `isPublished=true` and `null` otherwise (HA-R4), and write one row and one audit row (actor_user_id 303, actor_role admin, action `help_article.created`, entity_type `help_article`, entity_id = id, request_id = the sent `X-Request-Id`, metadata `{ isPublishedBefore: null, isPublishedAfter }`) · should return 409 Conflict with `details[0].field = "title"` for a duplicate title in the same audience and leave the audit count unchanged, while the same title in the other audience is 201 (HA-R3, HA-R13) · should store and return the body byte for byte, including `<script>`, newlines, tabs, and astral characters (HA-R1) · should return 400 for every invalid body of §9.1 · idempotency: same key + same body twice → 201 twice, same id, one row, one audit row · same key + different body → 422 `IdempotencyConflict` · key not a UUID → 400 · no key, same body twice → 201 then 409 (HA-R19) · **concurrency:** two parallel POSTs with the same title and audience and different keys → exactly one 201 and one 409, one row (HA-R22) · **audit failure rolls back:** the owner adds `ALTER TABLE audit_logs ADD CONSTRAINT chk_test_block_help CHECK (action <> 'help_article.created')`, POST → 500 `InternalError` and no `help_articles` row; dropped in `finally` (HA-R13).

**Update:** should change only the provided members and bump `updated_at` (owner query: greater than the old value) · should audit `changedFields` sorted (`"body,title"`) with `isPublishedBefore`/`After` and no title or body text (HA-R12) · should publish a draft: `publishedAt` set, then unpublish keeps `publishedAt`, then re-publish keeps the original value (HA-R4, O2) · should change `category` and `audience` of a published article in one call without unpublishing (HA-R9) · should return 409 when the new `(audience, title)` belongs to another live article and leave the row and audit count unchanged · should accept the article's own current title (no 409) · **no-op:** same values → 200, identical body, `updated_at` unchanged, no audit row (HA-R10) · partly equal → only the changed names audited · `{}` → 400 `body`; `{ "title": null }`, `{ "isPublished": "true" }`, `{ "publishedAt": "…" }` → 400 (HA-R11) · a deleted article → 404 (HA-R8).

**Delete:** should return 204, set `deleted_at` (owner query shows the row), write one audit row `help_article.deleted` with `isPublishedAfter: null`, and make the article 404 for the author-admin and every role · a second DELETE → 404 · the title is reusable by a new article after deletion (HA-R8) · `DELETE help_articles` / `TRUNCATE help_articles` as `care_app` → 42501 (HA-R23).

**Reads are not audited (HA-R14):** after a patient list, a patient get, and an admin get, the audit row count for entity type `help_article` is unchanged.

**Rate limit (HA-R20):** one patient GET stores hits under `rl:help-articles-read-user:101` · the 121st GET in a minute → 429 `RateLimited` with `Retry-After` >= 1 · the 21st write (mix of POST, PATCH, DELETE) in a minute by one admin → 429 (one shared bucket) · Redis flushed or down → per-instance fallback still limits.

**Cache-Control (HA-R21):** `private, no-cache` on 200 list, 200 get, 201, 200 patch, 204 delete, and on a 401, 403, 404, and a malformed-JSON 400 under the prefix.

**Grants and schema (as `care_app`; owner for assertions):** `SELECT`, `INSERT`, `UPDATE` succeed · `has_table_privilege('vcare_app', 'help_articles', 'DELETE')` is false and sequence `USAGE` is true · an `INSERT` with a 2-character title, an empty body, a 50,001-character body, `is_published = true` with `published_at NULL`, category `other`, or audience `admin` violates its named check (23514, HA-D11) · **EXPLAIN:** inside a transaction as `care_app`, `SET LOCAL enable_seqscan = off`, `EXPLAIN (FORMAT JSON)` of `listHelpArticlesQuery` for a reader without and with `category`, and for an admin, each with an `after` position → the plan scans `idx_help_articles_audience_published_at_id` (reader) or `idx_help_articles_updated_at_id` (admin), has no `Sort` node, and its `Index Cond` holds the `ROW(published_at, id) < ROW(…)` / `ROW(updated_at, id) < ROW(…)` comparison (CLAUDE.md → Performance rules: EXPLAIN the list queries).

**Logs:** captured logs across the suite contain no token string, no `Authorization` value, no `SYNTHETIC-HELP-BODY-7731`, and no fixture title; every `request_completed.route` is `/api/help-articles` or `/api/help-articles/:id`; no audit `metadata` contains the body marker or a title.

**Contract conformance:** every status returned per route is in `contractResponseCodes(<path>, <method>)`; every error body passes `expectErrorEnvelope`; every success body passes `expectSuccessEnvelope` and the `HelpArticle` / `HelpArticleSummary` key check; `idempotentOperations()` lists `POST /api/help-articles` with `Conflict`.

### 9.3 Integration — other suites touched
- `migrations.test.ts`: the rollback/latest round trip covers the new migration · should create no row (no seed, O4) · should leave `help_articles` empty after `latest`.
- `boot.test.ts`: should boot with the real `buildPublicRoutes()` and answer `GET /api/help-articles` without a token with 401 (mounted and guarded).
- `pagination.test.ts`: the kind-tagged cursor cases above, if the shared router helper is extended.

### 9.4 Mandatory scenarios (CLAUDE.md → Testing policy) that apply
Each business rule HA-R1 to HA-R24 · RBAC per route (wrong role 403, allowed role 2xx; ownership `none`, so no non-owner case; hidden articles 404) · pagination page 2 on the default sort · idempotent replay and conflicting body (`POST`) · every audited write writes its row in the transaction · logs free of fixture strings and tokens · contract conformance. Not applicable: concurrent booking, Cases 1-3, record lock and amendments, slot budget, uploads and download URLs, admin-on-clinical (no clinical route), audit-on-read (help reads are not audited).

### 9.5 Manual QA (`/manual-qa help-articles`)
Against a local Identity (real patient, doctor — including a `pending` doctor before approval — and admin tokens), with
synthetic fixtures created through the API: the RBAC table, create/duplicate-title/idempotent replay, publish →
unpublish → re-publish keeping `publishedAt`, audience and category change on a published article, no-op `PATCH`,
delete then 404 for admin and patient, page 2 for patient and admin, `403` on writes for patient and doctor, `429` on the
121st read and the 21st write, the `Cache-Control` header on each status, and the compiled-build `isPublished=yes` → 400
check (#8). Record no tokens and no realistic article text in `manual-qa.md`; script `scripts/curl-test-help-articles.sh`.

---

## 10. Out of scope
- `GET /internal/help-articles` and the `help:read` scope, tombstones, `updatedSince` (ADR 0028; built with the AI service).
- Revision history and citations pinned to a revision; localised articles; article search; an unauthenticated public help page; attachments or images in articles.
- Rendering, sanitising, or rewriting Markdown (clients do it); a new runtime dependency.
- A third audience value; admin-managed categories (the four categories are a `CHECK`-guarded enum).
- Restore of a deleted article; any read of deleted rows.
- Seed or demo articles (O4).
- A per-route raised request-size limit (HA-D13).
- Audit of reads; Redis caching of content.

---

## 11. Open questions

None.

**Platform changes required (/system-design):** none. Hub `data-ownership.md`, `landscape.md` and `TODO.md` already
describe the future internal endpoint (ADR 0028); nothing in this iteration changes a platform document, a capacity
headline, or a deployment fact.

The contract edits this module needs are decided, not open; they are listed in §12 and land in `/develop` step 0.

---

## 12. Contract changes required

Applied to `contracts/openapi.yaml` in `/develop` step 0, **before any code**, then synced to the hub with
`../vcare-hub/scripts/sync-from-spoke.sh` (never hand-edit the hub copy). No new error code, no new route, and no new
status code is needed; every status listed in §3.1 is already declared by the contract.

**C1 — `HelpArticleSummary` for list items.** Add the schema and point `listHelpArticles` at it; `getHelpArticle`,
`HelpArticleOk`, `HelpArticleCreated` keep `HelpArticle`.
```yaml
    HelpArticleSummary:
      type: object
      description: A list item. It never carries `body` or `createdAt`; the full article is `GET /api/help-articles/{id}`.
      required: [id, title, category, audience, isPublished, publishedAt, updatedAt]
      properties:
        id:
          type: integer
          format: int64
        title:
          type: string
          maxLength: 200
        category:
          $ref: '#/components/schemas/HelpArticleCategory'
        audience:
          $ref: '#/components/schemas/HelpArticleAudience'
        isPublished:
          type: boolean
        publishedAt:
          type: [string, 'null']
          format: date-time
        updatedAt:
          type: string
          format: date-time
```
and in `paths./api/help-articles.get` replace `items: $ref: '#/components/schemas/HelpArticle'` with `$ref: '#/components/schemas/HelpArticleSummary'`.

**C2 — `body` and `title` descriptions.** In `HelpArticle.properties.body`, `HelpArticleCreate.properties.body`, and `HelpArticleUpdate.properties.body`:
```yaml
          description: >-
            Markdown, stored and returned verbatim. Care never renders or sanitises it: clients must sanitise and must
            not render raw HTML. 1 to 50000 code points; U+0000 is rejected (`400`). The request must also fit the 100 kb
            request-size limit (`400 ValidationFailed`, `body: must not exceed 100kb`), which binds first for text
            averaging more than about 2 bytes per character.
```
In `HelpArticleCreate.properties.title` and `HelpArticleUpdate.properties.title` add: `Length counts Unicode code points; control characters are rejected (400); not trimmed; unique among live articles of the same audience (409 Conflict).`

**C3 — allowed account statuses per role.** Add to `listHelpArticles` and `getHelpArticle`:
```yaml
      x-account-state: 'doctor status in (pending, active, rejected); patient and admin active'
```
and extend each operation `description` with: "A doctor may read while `pending`, `active` or `rejected` (onboarding needs the platform rules); patients and admins must be `active`. The three write operations require an `active` admin."

**C4 — admin list sort and cursor sort kind; filters; visibility wording.** Replace the `listHelpArticles` description:
```yaml
      description: >-
        Patients and doctors see published articles of their own audience, ordered by `publishedAt` descending, then
        `id` descending. Admins see drafts too (never deleted articles), ordered by `updatedAt` descending, then `id`
        descending. The cursor encodes its sort kind: a cursor from the other kind is `400 ValidationFailed`
        (`cursor: is invalid`). `category` filters for every role. `audience` and `isPublished` are admin filters:
        they are validated for every role and ignored for patients and doctors.
```
The `audience` and `isPublished` parameter descriptions become "Admin only; validated for every role, ignored for others." Replace the `getHelpArticle` description with: "Unpublished, other-audience, or deleted articles return `404 NotFound` to non-admins. A deleted article is also `404` to admins." Add to `updateHelpArticle` a `description` (the `summary` stays): "Partial update and publish/unpublish. `publishedAt` is set on the first publish and kept afterwards (unpublish keeps it). `category` and `audience` may change on a published article. A request that changes nothing answers `200` with the current article and writes no audit row. A deleted article is `404`." Add to `deleteHelpArticle`: "Soft delete. The title becomes reusable; a repeated delete is `404`."

**C5 — `Cache-Control: private, no-cache`.** Add a header component and reference it on the success responses:
```yaml
    CacheControlPrivateNoCache:
      description: '`private, no-cache`: not for shared caches; stored copies must be revalidated before reuse.'
      schema:
        type: string
        const: private, no-cache
```
Add `Cache-Control: $ref '#/components/headers/CacheControlPrivateNoCache'` to the `200` response of `listHelpArticles`, to `components.responses.HelpArticleOk`, and to `HelpArticleCreated`. The shared error responses keep their `CacheControlNoStore` declaration; Care sends `private, no-cache` on error responses under this prefix (an accepted, documented difference: both values forbid reuse without revalidation, and the same gap already exists for every route outside `NO_STORE_PREFIXES`). The conformance tests assert the header on success responses only. No `info.description` change is needed (it is a header, not a vendor extension).

Also state in the `help-articles` tag description: "Help center content (Phase-2 RAG corpus). Not clinical data."

---

## 13. Required follow-ups (docs; not open)

- **`/develop` step 0:** C1-C5 and the hub sync.
- **`/update-docs help-articles`:**
  - `architecture/data-model.md`: `help_articles` as built (the two added checks, the replaced and added indexes of HA-D12, grants, the migration name, remove "help_articles" from the "design the remaining modules will build" line, add it to "Built so far").
  - `architecture/api.md` (help-articles section: statuses, rate limits, idempotency, `Cache-Control`, remove "Not built yet") and `architecture/rbac.md` (the two help rows: rate limits, account states unchanged).
  - `architecture/help-articles.md`: status "built", replace the "Proposed defaults" block by the decisions of §1.4, §8 → as applied.
  - `architecture/overview.md` module map (`help-articles` built) and `docs/system-design.md` ("understand the help center before it is built" wording).
  - `docs/INDEX.md` rows for the module (spec done now; tasks, manual-qa later).
  - **`docs/service-card.md`: affected.** Responsibilities (help articles now built, not only "the Phase-2 RAG corpus"), owned data (`help_articles` built), the endpoint family `/api/help-articles` live (reads 120/min and writes 20/min per user, admin writes, doctors `pending`/`active`/`rejected` may read, `private, no-cache`), and the status line. Then `../vcare-hub/scripts/sync-from-spoke.sh`; the hub copy is never hand-edited.
  - `.claude/hooks/retired-terms.txt`: nothing retired.
- **CLAUDE.md (owner edit, not made by the spec):** the status block says `help-articles` is "the only unbuilt module" and lists the built modules; it needs `help-articles` added to the built list when the module is done. The "Authentication and service-to-service auth" paragraph that names the read-only specialty catalog as the doctor-onboarding allowance could add `GET /help-articles*` to that list (ADR 0027 D4).

---

## 14. Task ordering (CLAUDE.md → Build order for a new module)

| Step | Work |
|---|---|
| 0 | Contract C1-C5 (§12) and the hub sync |
| 0a (lib) | `lib/http/private-no-cache.ts` + unit test; `decodeKindedTimestampCursor` in `lib/http/pagination/cursor.ts` + unit tests |
| 1 | Migration `<ts>_create_help_articles` (§2.2) |
| 2 | `constants.ts`, `enums.ts`, `errors.ts`, `types.ts` |
| 3 | Entities |
| 4 | Request DTOs |
| 5 | Response DTOs |
| 6 | Repository |
| 7 | Service + DI token and registration |
| 8 | `policies.ts` |
| 9 | Controller + DI registration |
| 10 | `routes.ts` |
| 11 | Mount in `src/routes.ts`; `PRIVATE_NO_CACHE_PREFIXES` and its mount in `src/app.ts` |
| 12 | Tests of §9 (unit, integration, RBAC, contract, concurrency, EXPLAIN, grants); the redaction test row |
| 13 | Manual QA (§9.5) |
| 14 | Docs of §13, INDEX, service card |

Step 0a comes first because the controller and the app wiring use both helpers; each lib step lands with its regression
tests and leaves typecheck, lint, unit, and integration green on the Docker test stack.

---

## 15. As-built notes (2026-10-29, version 0.2.0)

The module is built, tested (unit and integration), manually QA'd (365 pass, 0 fail; [manual-qa.md](./manual-qa.md)) and code-reviewed clean. Sections 1 to 14 above are the design as specified and are not rewritten; where the code differs, this section is authoritative. The contract (`contracts/openapi.yaml`) was changed only by C1 to C5 and matches the code; no other contract change was needed.

**Intentional deviations from the text above (no behaviour or contract effect):**
1. **`decodeKindedTimestampCursor` returns the bare timestamp.** It returns `{ sortValue: <µs timestamp>, id }` with the kind prefix already stripped (§3.7 describes it as validating the prefixed value). The service passes the position to the repository unchanged and re-adds the prefix only when it builds the next cursor (`${kind}:${sortCursor}`). The shared timestamp rule was extracted from `decodeTimestampCursor` into `assertTimestampCursorValue` with no behaviour change.
2. **`listHelpArticles` returns `HelpArticleListEntry[]`** (`{ summary: HelpArticleSummary, sortCursor }`, in `types.ts`), not `HelpArticleSummaryRow[]` (§3.3): the private `toSummary` mapper stays in the repository and the `HelpArticleSummary` entity carries no DB-shaped field. `HelpArticleSummaryRow` still exists and carries `sort_cursor`.
3. **Four extra `COMMENT ON COLUMN` statements** beyond the `COMMENT ON TABLE` of §2.2: `body` ("Markdown, stored and returned verbatim; never logged"), `published_at` (set on the first publish and kept), `created_by` and `updated_by` ("Identity user id (admin); no FK"). The migration is `src/migrations/20261029120000_create_help_articles.ts`; its function body avoids the question-mark character because `knex.raw` reads a bare one as a binding.
4. **`audienceOf(role)` throws `Forbidden`** for any role other than patient or doctor. It is unreachable (`authorize` admits only the three roles and admins take the admin branch); it exists so the switch is exhaustive.
5. **Contract tag sentence (fix-review).** The `help-articles` tag description in the contract now states that every response under `/api/help-articles`, error responses and the `DELETE` `204` included, carries `Cache-Control: private, no-cache`, regardless of the `no-store` header declared on the shared response components. This closes the "accepted, documented difference" of C5 (the shared error responses still declare `CacheControlNoStore`; Care sends `private, no-cache` under this prefix, and the integration tests pin it for the `200`, `201`, `204`, `400`, `401`, `403`, `404`, `409`, `429`, malformed-JSON and `500` cases).

**Shared-code changes made by this module (they affect other modules):**
6. **Verification router `noStore()` scoping (commit `50f6e6e`).** `src/app/verification/routes.ts` called a pathless `router.use(noStore())`, so every request that fell through to a router mounted after it, help-articles among them, received `Cache-Control: no-store`, overriding the `private, no-cache` prefix header (HA-D7, HA-R21). The call is now two scoped calls, `/doctors/me/documents` and `/admin/applications`. No verification response changed: the admin prefix is also in `NO_STORE_PREFIXES`, and the doctors router stamps `no-store` on `/doctors/me` (so the doctor presigned-URL route `POST /doctors/me/documents/{documentId}/download-url` gets its header from the doctors router's `router.use("/doctors/me", noStore())`, with the verification router's scoped middleware as a second layer).
7. **Year-0000 cursor fix (fix-review).** `assertTimestampCursorValue` in `src/lib/http/pagination/cursor.ts` now also rejects a year below 0001, so a forged `0000-...` timestamp cursor is `400 ValidationFailed` (`cursor: is invalid`) instead of a Postgres out-of-range `500`. The function is shared, so `GET /api/consultations` and the patient record list are fixed too.

**Behaviours worth stating (all verified in code and by tests):**
- Every response under `/api/help-articles` carries `Cache-Control: private, no-cache`, set by the `PRIVATE_NO_CACHE_PREFIXES` middleware in `src/app.ts` before body parsing, so parser-level `400`s and guard `401`s carry it too.
- Rate limits: one named bucket `help-articles-read-user` (120/min per user) for the two reads; one `help-articles-write` bucket (20/min per user) for the three writes. The limiter runs after `authorize`, so a non-admin write is `403` before the id is parsed and before the limiter; a non-numeric `{id}` is `404`.
- `Idempotency-Key` is optional on `POST` only (`idempotency({ required: false })`); `PATCH` and `DELETE` take none. A no-op `PATCH` answers `200` with the current article and writes no audit row; a repeated `DELETE` is `404` (HA-D4).
- `GET /internal/help-articles` is **not built** (ADR 0028, owner decision O5).

**Open for the owner (not changed here):** the `CLAUDE.md` status block still lists `help-articles` as unbuilt; add it to the built list after merge.
