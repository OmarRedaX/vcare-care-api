---
title: "ADR 0027: help articles are verbatim Markdown, edited in place, listed as summaries"
owner: care-team
service: care-service
status: accepted
date: 2026-10-29
diataxis: explanation
last_verified: 2026-10-29
tags: [adr, decision, help-articles, rbac, api]
related: [help-articles, data-model, api, rbac, adr-0028-help-corpus-read-path-for-phase-2]
---

# ADR 0027 — help articles are verbatim Markdown, edited in place, listed as summaries

- **Status:** Accepted • **Date:** 2026-10-29 • **Deciders:** care-team

## Context
`help-articles` is the last unbuilt module. Its table, indexes and five operations were already specified, but four
things were open: the body format, what an edit of a published article does, whether the list returns bodies, and which
account statuses may read.

## Decision
- **Body:** Markdown stored verbatim in `body TEXT` (contract cap 50,000 characters). Care never renders or rewrites
  it; clients sanitise and do not render raw HTML. No new dependency.
- **Edits:** in place. `PATCH` updates the row and `updated_at`; `published_at` is set on the first publish and kept
  afterwards. No revision table. Each write is audited (`help_article.created|updated|deleted`) with ids, changed field
  names and `isPublished` before and after — never the title or body.
- **List shape:** `GET /api/help-articles` returns `HelpArticleSummary` items without `body`; `GET /api/help-articles/{id}`
  returns the full `HelpArticle`. No Redis cache; `Cache-Control: private, no-cache`.
- **Read access:** patients and admins `status=active`; doctors `pending`, `active` or `rejected` (like
  `GET /specialties`). Non-admins see only published articles for their own audience (`404` otherwise). Care's
  `suspended_at` is not checked.

## Consequences
- ➕ No new dependency, no XSS surface in Care, small payloads, and a pending or rejected doctor can read the platform rules.
- ➕ The Phase-2 indexer gets heading-structured text and an `updated_at` change signal.
- ➖ The contract changes (`HelpArticleSummary`; documented rendering rule); done before code through `/construct-spec`.
- ➖ No edit history: an overwritten article cannot be recovered or cited by revision. Acceptable for a few short pages;
  `help_article_revisions` can be added later without an API change.

## Alternatives considered
- **Server-sanitised HTML:** rejected; needs a sanitiser dependency (ADR) and enlarges the XSS surface.
- **Plain text only:** rejected; policy and preparation articles need headings and lists.
- **Revision table now / draft-copy-then-publish:** rejected as heavier than the content needs; revisions are additive later.
- **Full body in the list (the earlier contract):** rejected; a page can reach about 1 MB.
- **`active` only for everyone / public unauthenticated reads:** rejected; the first blocks onboarding doctors, the second
  changes the contract and adds a public endpoint the PRD does not ask for.
