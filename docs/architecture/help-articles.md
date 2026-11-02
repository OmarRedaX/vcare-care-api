---
title: Help Articles — Design
owner: care-team
service: care-service
status: accepted
diataxis: explanation
last_verified: 2026-10-29
tags: [architecture, help-articles, help-center, rag, rbac]
related: [data-model, api, rbac, future, capacity, system-design, adr-0027-help-articles-shape-and-access, adr-0028-help-corpus-read-path-for-phase-2, hub-data-ownership]
---

# Help Articles — Design

The help center: admin-authored articles that patients and doctors read, and the Phase-2 RAG corpus.
Service-scope (hub ADR 0008). Decided in `/system-design` on 2026-10-29 (ADRs
[0027](../adr/0027-help-articles-shape-and-access.md) and [0028](../adr/0028-help-corpus-read-path-for-phase-2.md)).
The module is **not built yet**; it is the last unbuilt module and goes through `/brainstorm` → `/update-docs`.
Table DDL stays in [data-model.md](./data-model.md) (`help_articles`); routes in [api.md](./api.md) and the contract.

## 1. Context
- PRD 7.10: an admin publishes articles by category and audience (how the platform works, preparing for a
  consultation, cancellation policy, platform rules). PRD 12: the same rows are the Phase-2 help-assistant corpus.
- The table, indexes and the five operations were already specified; this shard fixes what was still open: body
  format, edit semantics, the list shape, who may read, and how the AI service will read the corpus.
- Help articles are admin-authored product content. They are **not clinical data**: no PII, no logging redaction
  beyond the standard rules, no `no-store` requirement.

## 2. Decisions
| # | Decision | Why |
|---|---|---|
| D1 | `body` is **Markdown stored verbatim** (`TEXT`, the contract's 50,000-character cap). Care never renders it; clients render it with a sanitising renderer that does not render raw HTML. No new dependency. | An HTML sanitiser would be a new runtime dependency (ADR required) and an XSS surface; plain text loses headings and lists. Headings give the Phase-2 indexer natural chunk and citation boundaries. |
| D2 | **In-place edit, no revision table.** `PATCH` updates the row and bumps `updated_at`. `published_at` is set on the **first** publish and kept on unpublish and re-publish, so list order is stable. Soft delete sets `deleted_at`. | A handful of short pages; revisions can be added later without an API change. The Phase-2 indexer re-embeds when `updated_at` changes. |
| D3 | The **list returns summaries** (`HelpArticleSummary`: `id, title, category, audience, isPublished, publishedAt, updatedAt`); `GET /api/help-articles/{id}` returns the full article with `body`. **No Redis cache**; responses carry `Cache-Control: private, no-cache`. | A 20-row page of 50 KB bodies is up to about 1 MB. Help is a small share of the 300 k/day "other reads" and is one indexed statement. |
| D4 | **Read access by account status:** patients and admins need `status=active`; doctors may be `pending`, `active` or `rejected` (as for `GET /specialties`). Non-admins see only published articles for their own audience; anything else is `404 NotFound`. Care's `suspended_at` is not checked. | A doctor applying, or fixing a rejected application, needs the platform rules. Reading reference content is not a practising action. |
| D5 | The **Phase-2 AI service reads the corpus through a future internal endpoint**, not the public route (ADR 0028). Designed here, not built in the MVP. | Service tokens only reach `/internal/*`; the public route's audience filter assumes a human viewer. |

## 3. Behaviour
**Roles and routes** (the contract is the source; all routes sit behind `userGuard` and `authorize(policy)`):

| Operation | Roles | Notes |
|---|---|---|
| `GET /api/help-articles` | patient, doctor, admin | keyset list of summaries; non-admins: published + own audience only; admins: drafts too and may filter `audience`, `isPublished`; optional `category` |
| `GET /api/help-articles/{id}` | patient, doctor, admin | full article; unpublished, other-audience or deleted → `404` for non-admins |
| `POST /api/help-articles` | admin | create; `isPublished=true` sets `published_at = now()`; duplicate live title in the audience → `409 Conflict` |
| `PATCH /api/help-articles/{id}` | admin | partial update and publish/unpublish; `published_at` set on the first publish only; title clash → `409 Conflict`; deleted → `404` |
| `DELETE /api/help-articles/{id}` | admin | soft delete → `204` |

**Audit** (`admin-action`, written in the same transaction as the write): `help_article.created`,
`help_article.updated`, `help_article.deleted`. `metadata` holds the article id, the **names** of the changed fields and
`isPublished` before and after; never `title` or `body`. Reads are not audited.

**Proposed defaults (not decisions; `/construct-spec` confirms or changes them):**

- **Pagination:** keyset on `(published_at DESC, id DESC)` for non-admins (the partial index in the DDL); admins list
drafts too, ordered by `(updated_at DESC, id DESC)`; a cursor encodes the sort kind.

- **Rate limits:** the platform default for authenticated reads; admin writes 20/min per user (as other admin writes).

## 4. Failure handling
- Only Postgres is involved. No Identity call, no Redis, no storage, no video: nothing here can return a dependency 5xx
  except Postgres being down.
- The audit insert and the write are one transaction; an audit failure rolls the write back.
- Idempotency: `Idempotency-Key` is optional on `POST` (already in the contract); `PATCH` and `DELETE` are naturally idempotent.

## 5. Security and privacy
- Deny by default: every route has `authorize(...)`; writes are admin-only.
- Admin DTOs and the logger need no clinical redaction here, but the standard rules (no tokens, no request bodies of
  clinical routes) still apply. Article text is never put in audit metadata or logs, so a later move to richer
  content cannot leak through them.
- Markdown is untrusted for rendering purposes even though only admins author it: the contract states that clients must
  sanitise and must not render raw HTML.

## 6. Phase-2 corpus read path (designed, not built; ADR 0028)
`GET /internal/help-articles?updatedSince=<ISO>&cursor=&limit=` on the **internal listener**:
- service token: `typ=service`, `aud` ∋ `vcare-care`, scope **`help:read`**; a user token → `401 ServiceTokenRequired`,
  a token without the scope → `403 InsufficientScope`;
- returns **published, live** articles for **both** audiences with `id, title, body, category, audience, publishedAt,
  updatedAt`, ordered `(updated_at, id)` ascending so an indexer can resume from its last `updatedAt`;
- (proposed) also returns, with `deleted: true` and no body, the ids of articles unpublished or deleted since `updatedSince`, so
  the index can drop them (implemented as a tombstone read over `is_published = false OR deleted_at IS NOT NULL`);
- keyset pagination like every list. The AI service's client in Identity is provisioned with `help:read` first
  (provider first; hub `TODO.md`).
Not part of the MVP contract: it lands with the AI service through `/construct-spec` and `/develop`.

## 7. Performance and capacity
No budget of its own: one indexed query per list or detail read, well inside the 200 ms read budget. The traffic is
inside the 300 k/day "other reads" line ([capacity.md](./capacity.md) section 2); storage is negligible. No change to the
headlines.

## 8. Contract changes required (provider: Care)
Land through `/construct-spec help-articles` + `/develop`, contract first:
1. Add the `HelpArticleSummary` schema; `listHelpArticles` returns an array of it. `getHelpArticle` keeps `HelpArticle`.
2. Document in the `body` description that it is Markdown and clients must not render raw HTML.
3. Document the account statuses allowed per role (D4) and `Cache-Control: private, no-cache`.
4. State the keyset sort for the admin list and that a cursor carries its sort kind.
5. **Not now:** `GET /internal/help-articles` (section 6) joins the contract with the AI service.

## 9. Deferred
- Revision history and citations pinned to a revision (add `help_article_revisions` when the assistant needs it).
- Localised articles (one row per language) and article search; the PRD has neither.
- An unauthenticated public help page.
