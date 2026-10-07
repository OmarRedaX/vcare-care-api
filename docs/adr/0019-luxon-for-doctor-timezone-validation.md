---
title: ADR 0019 — Luxon for doctor timezone validation
owner: care-team
service: care-service
module: doctors
status: accepted
diataxis: explanation
last_verified: 2026-10-07
tags: [adr, doctors, timezone, dependencies]
related: [doctors-spec, adr-0016-foundation-runtime-dependencies]
---

# ADR 0019 — Luxon for doctor timezone validation

## Context

The doctors module accepts an IANA timezone for a doctor's profile. The locked stack in `CLAUDE.md → Tech stack (locked)` names `luxon`, and ADR 0016 deferred installation until a module needed it. `luxon` is not yet a dependency.

## Decision

Add a pinned `luxon` runtime dependency and its TypeScript declarations for the doctors module. Use `IANAZone.isValidZone` for request validation. Canonicalize valid input with `Intl.DateTimeFormat(undefined, { timeZone }).resolvedOptions().timeZone` before storing it, as resolved in the doctors spec's O1.

## Consequences

Timezone validation uses the locked library consistently with later scheduling and slot computation. The pinned packages were installed from cached npm tarballs because the registry was unavailable in this environment.
