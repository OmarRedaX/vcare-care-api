---
title: help-articles — Brainstorm
owner: care-team
service: care-service
module: help-articles
status: draft
diataxis: explanation
last_verified: 2026-10-29
tags: [brainstorm, help-articles, help-center, rag]
related: [system-design, help-articles, data-model, api, rbac, adr-0027-help-articles-shape-and-access, adr-0028-help-corpus-read-path-for-phase-2]
---

# help-articles — Brainstorm

Scope brief for the last unbuilt Care module. The architecture was settled in `/system-design` on 2026-10-29
([architecture/help-articles.md](../architecture/help-articles.md), ADRs [0027](../adr/0027-help-articles-shape-and-access.md)
and [0028](../adr/0028-help-corpus-read-path-for-phase-2.md)); this brief fixes the iteration scope and what the spec
must still decide. Decisions marked **(owner)** were made by the user in the brainstorm; **(call)** are the author's
calls for the spec to confirm.

## Problem & purpose
Patients need to know how the platform works, how to prepare for a consultation, the cancellation policy and the
platform rules; doctors need the platform rules and how consultations run. Admins need to publish that content
without a deployment (PRD 7.10). The same rows are the Phase-2 help-assistant corpus (PRD 12).

## Actors
- **Admin:** creates, edits, publishes, unpublishes, deletes (soft) articles; sees drafts.
- **Patient:** reads published `patient` articles.
- **Doctor:** reads published `doctor` articles, including while `pending` or `rejected` (onboarding).
- **Phase-2 AI service:** reads the corpus later through an internal endpoint (not this iteration).

## In scope (this iteration)
- Migration for `help_articles` as in [data-model.md](../architecture/data-model.md), granted explicitly to `vcare_app` (`SELECT, INSERT, UPDATE`; soft delete only).
- The five operations in `contracts/openapi.yaml`: list, get, create, patch (edit and publish/unpublish), delete (soft).
- The contract change: `HelpArticleSummary` for list items, Markdown and rendering note on `body`, the allowed statuses per role.
- Admin-action audit rows in the write transaction; keyset pagination; unique live title per audience → `409 Conflict`.
- Tests: unit, integration, RBAC, contract conformance; manual QA with CURL; docs.
- **Start empty (owner):** no seed rows or seed migration; the QA script creates synthetic fixtures only.

## Out of scope
- `GET /internal/help-articles` and the `help:read` scope (designed in ADR 0028, built with the AI service).
- Revision history, localisation, article search, an unauthenticated public page, attachments or images in articles.
- Rendering or sanitising Markdown (clients do it).
- A new audience value: **two audiences, duplicate rows for content that applies to both (owner)**.
- Admin-managed categories: the four categories stay a `CHECK`-guarded enum (call).

## Key entities & relationships
`help_articles` only: `id, title, body, category, audience, is_published, published_at, created_by, updated_by`,
timestamps, `deleted_at`. `created_by`/`updated_by` are Identity admin user ids (no FK). No relationships to other
Care tables. Unique live `(audience, title)`.

## Primary flows / endpoints (with roles + ownership)
| Operation | Roles | Ownership | Audit |
|---|---|---|---|
| `GET /api/help-articles` (summaries) | patient, doctor, admin | none; non-admins: published + own audience | — |
| `GET /api/help-articles/{id}` (full) | patient, doctor, admin | none; hidden → `404` | — |
| `POST /api/help-articles` | admin | none | `help_article.created` |
| `PATCH /api/help-articles/{id}` | admin | none | `help_article.updated` |
| `DELETE /api/help-articles/{id}` | admin | none | `help_article.deleted` |

## Business rules & state transitions
- Publishing sets `published_at` on the first publish and keeps it afterwards; unpublishing keeps it. `CHECK (NOT is_published OR published_at IS NOT NULL)`.
- Edits are in place; no revision table (ADR 0027). A deleted article is `404` for everyone, admins included (call).
- Admin may change `category`, `audience`, `title` and `body` of an existing article (call); a title clash in the audience is `409 Conflict`.
- Non-admins never learn that an unpublished, other-audience or deleted article exists (`404`).
- Read access by status: doctors `pending`/`active`/`rejected`; patients and admins `active` (ADR 0027). No `suspended_at` check.

## Cross-service touchpoints (case, direction, failure policy)
None in this iteration: no Identity call, no hydration, no storage, no video. The Phase-2 AI read path is
designed in ADR 0028 and is not built here.

## Privacy & audit
Not clinical data. Admin writes are audited in the same transaction; `metadata` holds the article id, changed field
names and `isPublished` before and after, never `title` or `body`. Reads are not audited. Logs carry no article text.

## Constraints & guideline notes
- No new runtime dependency (Markdown stays verbatim). Raw SQL migration, repository functions, DTO classes, `authorize(...)` on every route, `types.ts` for interfaces.
- The list never returns `body`; no Redis cache; `Cache-Control: private, no-cache`.
- Nothing in `CLAUDE.md` is in conflict. The module slug and the `help_articles` table name are already fixed.

## Contract changes expected
1. `HelpArticleSummary` as the list item; `getHelpArticle` keeps `HelpArticle`.
2. `body` description: Markdown, clients must not render raw HTML; `Cache-Control: private, no-cache`.
3. Allowed account statuses per role; admin list sort and the cursor's sort kind.
4. Error codes used: `ValidationFailed`, `Unauthorized`, `Forbidden`, `NotFound`, `Conflict`, `IdempotencyConflict`, `RateLimited`, `InternalError` (all existing; no new code).

## Open questions
- Admin list ordering and the admin write rate limit (proposed `(updated_at DESC, id DESC)`, 20/min per user) — confirm in the spec.
- Whether `PATCH` accepts `audience` and `category` changes on a published article without unpublishing first (call: yes).
- Whether the module needs a `Logger` redaction entry for `body` (call: yes, as defence in depth, since article text should never reach logs).

## Success criteria
- Admin creates, publishes, edits, unpublishes and deletes an article; a patient and a doctor see exactly the published articles of their audience, and nothing else.
- An onboarding doctor (`pending`, `rejected`) can read; a patient or admin who is not `active` cannot.
- Every admin write has one audit row without text; a duplicate title in an audience is `409`.
- List p95 well inside the 200 ms read budget with an `EXPLAIN` showing the partial index; contract conformance passes.
