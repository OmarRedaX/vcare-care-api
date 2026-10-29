---
title: "ADR 0028: the Phase-2 AI service reads help articles through an internal endpoint"
owner: care-team
service: care-service
status: accepted
date: 2026-10-29
diataxis: explanation
last_verified: 2026-10-29
tags: [adr, decision, help-articles, phase-2, rag, service-auth]
related: [help-articles, integration, future, hub-adr-0003-service-token-s2s-auth, adr-0027-help-articles-shape-and-access, hub-data-ownership, hub-landscape]
---

# ADR 0028 — the Phase-2 AI service reads help articles through an internal endpoint

- **Status:** Accepted • **Date:** 2026-10-29 • **Deciders:** care-team

## Context
Hub `architecture/data-ownership.md` said the AI service reads the help corpus "through Care's API". The only help
route is `GET /api/help-articles`, which accepts user tokens only and filters by the viewer's audience; the AI service
has neither. Service tokens reach only `/internal/*` (hub ADR 0003).

## Decision
- **Designed now, built with Phase 2, not in the MVP:** `GET /internal/help-articles?updatedSince=&cursor=&limit=` on
  the internal listener, guarded by a service token (`typ=service`, `aud` ∋ `vcare-care`) with the new scope
  **`help:read`**. A user token gets `401 ServiceTokenRequired`; a token without the scope gets `403 InsufficientScope`.
- It returns published, live articles for both audiences with their body, ordered by `(updated_at, id)` for incremental
  indexing, and (proposed, confirmed in the spec) tombstones for articles unpublished or deleted since `updatedSince`.
- The MVP builds only the five user-token routes. The route joins `contracts/openapi.yaml` with the AI service.
- Hub `data-ownership.md` and `landscape.md` name the endpoint; hub `TODO.md` tracks provisioning `help:read` on the AI
  service client in Identity (provider first).
- Help articles are not clinical data, so the draft-confirm AI boundary does not apply to reading them; the assistant's
  answers stay grounded with citations and escalate to an admin when nothing relevant is found (PRD 12).

## Consequences
- ➕ The ownership doc stops pointing at an access path that cannot work; the service-token rule stays uniform.
- ➕ No MVP code and no new Identity work until the AI service exists.
- ➖ The route is only designed, so it can drift before it is built; the contract change is the check.
- ➖ Tombstones add a small read path (`is_published = false OR deleted_at IS NOT NULL`) that needs an index review when built.

## Alternatives considered
- **Reuse the public route with a service token:** rejected; mixes user and service guards on one route and needs an
  audience special case.
- **Decide in Phase 2:** rejected; leaves the platform ownership doc wrong in the meantime.
- **Push events to the AI service:** rejected; no message bus in the MVP.
