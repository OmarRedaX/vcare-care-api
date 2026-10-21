# Resume checkpoint — availability system design (updated 2026-10-21)

record-attachments is merged (care PR #45, hub PR #25). New work branches: care `feature/availability-design`, hub `docs/availability-design` (both from updated main, NOT committed or pushed yet).

## Done (/system-design availability, 2026-10-21)
Decisions D1–D5 made and written: ADR 0024 (Redis rank index `next-available:index` + `free-map:*` 15-min bitmap, remove-on-change + refresh + 120 s sweep, versioned `slots:` keys; supersedes 0010), ADR 0025 (derived `name-index`), ADR 0026 (Redis-down degradation, `meta.degraded`).
Shard: docs/architecture/availability.md. Updated: scheduling-slots, capacity (§9, 10x rows, triggers), deployment, resilience, overview, system-design router, INDEX, service-card, ADR 0010 (superseded).
Hub: data-ownership (2 rows), capacity (name-index refresh line), deployment (worker loops), glossary. check-freshness OK; no `service: platform` doc under care docs/.
Not changed: contracts/openapi.yaml (changes listed in availability.md "Contract changes"), CLAUDE.md (slots key `<ver>`, status; for /update-docs), Identity docs (+7 % on its ~100 k/day figure, within rounding).

## ▶ NEXT STEP
1. Owner reviews and commits both doc branches (care + hub), opens PRs.
2. `/brainstorm availability` -> `/construct-spec availability` (3 build slices: slots+listeners, index+search, name index) -> `/develop` ...
3. Help-articles module is independent and can run in parallel after the spec.
