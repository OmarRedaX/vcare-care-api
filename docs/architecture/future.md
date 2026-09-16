---
title: Future Work
owner: care-team
service: care-service
status: draft
diataxis: explanation
last_verified: 2026-09-15
tags: [future, roadmap, events, ai, out-of-scope]
related: [integration, clinical-records, resilience, system-design]
---

# Future Work — care-service

Deferred on purpose. Each item becomes a `/system-design` topic (and ADR) before any code.

## 1. Events and a message bus
MVP is HTTP-only; there is no AsyncAPI contract. Reserved event names (listed as `x-future-events` in the
contract): `consultation.booked`, `consultation.rescheduled`, `consultation.cancelled`, `doctor.verified`,
`doctor.suspended`.

- **Transport:** a platform decision recorded as a hub ADR (candidate named by Care: RabbitMQ — tracked in hub
  `TODO.md` → Events); adopting its client in Care is then a new runtime dependency needing a Care ADR.
- **Publishing pattern:** a transactional outbox in Care's database so an event is emitted iff the business write
  commits; a relay publishes with at-least-once delivery; consumers dedupe by event id.
- **First consumers:** notifications (replacing the MVP async email mechanism), analytics for utilization and
  no-show rates, the Phase-2 AI service.
- The HTTP integration cases stay: events add propagation, they do not replace Case 3's synchronous confirmation.

## 2. Doctor-status gap and reinstatement — resolved
**Resolved 2026-09-15** by hub ADR 0006: Identity refuses doctor status changes on its public admin route, so
Care is the only initiator of a doctor's account-status change ([integration.md](./integration.md)).
**Reinstatement designed 2026-09-15** as Case 4 ([ADR 0012](../adr/0012-doctor-reinstatement.md), hub ADR 0009):
admin endpoint in Care, Case-1 failure policy, flags stay; needs Identity's internal route to allow
`suspended → active` first.

Also decided 2026-09-15: notification delivery ([ADR 0011](../adr/0011-notification-outbox-and-reminders.md)),
search ranking cache ([ADR 0010](../adr/0010-next-available-lazy-cache-worker-refresh.md)). Remaining topic:
doctor-initiated follow-up booking. File storage was decided in [ADR 0013](../adr/0013-verified-direct-upload-lifecycle.md)–[0015](../adr/0015-aws-sdk-storage-adapter.md).

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
- Synchronous database standby (99.95 %) superseding [ADR 0005](../adr/0005-availability-and-recovery-targets.md) when data-loss tolerance requires it.
- Archiving detached `audit_logs` partitions to object storage (partitioning itself ships from day one, ADR 0009); retention policy per data class.
- Per-doctor and per-patient no-show and utilization reporting (PRD business goals).

## 5. Out of scope for MVP (PRD §13)
Payments, payouts, and refunds · insurance claims · prescriptions and e-pharmacy · lab orders and results · the
video infrastructure itself (a third-party room provider is assumed) · chat between consultations · ratings and
reviews · SMS and WhatsApp channels · group practices and clinic accounts · mobile apps · waiting lists for fully
booked doctors. Also out of scope in Care: account, credential, or token management (Identity).
