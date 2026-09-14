---
title: Future Work
owner: care-team
service: care-service
status: draft
diataxis: explanation
last_verified: 2026-09-14
tags: [future, roadmap, events, ai, out-of-scope]
related: [integration, clinical-records, resilience, system-design]
---

# Future Work — care-service

Deferred on purpose. Each item becomes a `/system-design` topic (and ADR) before any code.

## 1. Events and a message bus
MVP is HTTP-only; there is no AsyncAPI contract. Reserved event names (listed as `x-future-events` in the
contract): `consultation.booked`, `consultation.rescheduled`, `consultation.cancelled`, `doctor.verified`,
`doctor.suspended`.

- **Candidate transport:** RabbitMQ (topic exchange per service, durable queues, publisher confirms), adopted only
  by an ADR — adding the client is a new runtime dependency.
- **Publishing pattern:** a transactional outbox in Care's database so an event is emitted iff the business write
  commits; a relay publishes with at-least-once delivery; consumers dedupe by event id.
- **First consumers:** notifications (replacing the MVP async email mechanism), analytics for utilization and
  no-show rates, the Phase-2 AI service.
- The HTTP integration cases stay: events add propagation, they do not replace Case 3's synchronous confirmation.

## 2. Closing the Identity-originated doctor-status gap
Today a doctor status change made directly in Identity is not pushed to Care; mitigations are process (suspend
through Care) and Case 2 status filtering in search ([integration.md](./integration.md)). Options for
`/system-design`:

| Option | Trade-off |
|---|---|
| Identity emits `user.status_changed`; Care consumes and applies local suspension/unsuspension | cleanest; needs the bus and an Identity contract change |
| Identity refuses doctor status changes on its public admin route and directs them to Care | no new infra; relies on Identity knowing doctor semantics |
| Periodic reconciliation job in Care comparing doctor profiles to batch lookups | no contract change; bounded staleness and extra load |

Related deferred scope: **reinstating a suspended doctor** (no Care endpoint in MVP; would be the reverse of Case 3
with Identity `active`, a clear-flags decision for the follow-up queue, and its own audit action).

Other first topics named in CLAUDE.md: notification delivery mechanism; availability caching and search ranking;
file storage and signed URLs; the durable retry job design for Case 3; doctor-initiated follow-up booking.

## 3. Phase-2 AI & Retrieval service
A **separate service** with its own dependencies (vector store, model providers) and cost profile. It
authenticates through Identity's client-credentials flow with its own scopes and calls Care's internal APIs; it
never reads Care's database.

| Capability | How it touches Care |
|---|---|
| Complaint parsing (LLM) | reads `complaintText` at booking time through a scoped internal endpoint; writes a **draft** structured complaint and suggested specialty for the doctor to confirm |
| Pre-consultation summary (LLM) | reads the patient timeline through a scoped internal endpoint; produces a draft brief shown to the assigned doctor only |
| Diagnosis → ICD-10 (embeddings retrieval) | suggests real codes from retrieval for the doctor's diagnosis text; the doctor picks and confirms; only confirmed codes land in `medical_records.diagnosis_code` |
| Help assistant (RAG over `help_articles`) | indexes published articles (by audience and category), answers with citations, escalates to an admin when nothing relevant is found |
| Booking agent (tool calling) | tools `searchDoctors`, `getAvailableSlots`, `bookConsultation`, `rescheduleConsultation`, `requestInfo`, `escalateUrgent` map to Care's existing rules — bookings still pass Domain rules 1–8, `Idempotency-Key`, and the exclusion constraint; acting for a patient requires that patient's explicit confirmation |

**Boundary (non-negotiable):** AI never diagnoses, never prescribes, never decides treatment. Red-flag symptoms
escalate to a human immediately. Every AI-produced clinical artifact is a **draft the doctor confirms**. Admins
still never see clinical content, including AI drafts. Required Care work: draft storage with provenance and
confirmation audit, internal read endpoints with minimal fields and new scopes, and provisioning a service client
for `doctors:read` and those scopes.

## 4. Scale and operations
- Read replicas for discovery reads (search, profile, slots); booking always on the primary.
- Precomputed `next-available` refresh worker if lazy computation stops meeting the search budget at scale.
- Partitioning `audit_logs` by month once volume warrants it; retention policy per data class.
- Per-doctor and per-patient no-show and utilization reporting (PRD business goals).

## 5. Out of scope for MVP (PRD §13)
Payments, payouts, and refunds · insurance claims · prescriptions and e-pharmacy · lab orders and results · the
video infrastructure itself (a third-party room provider is assumed) · chat between consultations · ratings and
reviews · SMS and WhatsApp channels · group practices and clinic accounts · mobile apps · waiting lists for fully
booked doctors. Also out of scope in Care: account, credential, or token management (Identity), and reinstating a
suspended doctor.
