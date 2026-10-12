---
title: notifications — Tasks
owner: care-team
service: care-service
module: notifications
status: tests-green
last_verified: 2026-10-12
tags: [tasks, notifications, outbox, worker]
related: [notifications-spec, notifications-brainstorm, adr-0011-notification-outbox-and-reminders]
---

# notifications — Tasks

Source: [spec.md](./spec.md) (ready, v0.1.0). Branch `feature/notifications`. No HTTP surface.

## Legend
- [ ] todo · [~] in progress · [x] done

## Tasks
- [x] (contract) verify no change needed (spec 3.11)
- [x] (migration) 20261012120000_notification_outbox_delivery (kind CHECK, shape CHECKs, claim/purge indexes, column UPDATE + DELETE grants)
- [x] (migration) 20261012120100_consultations_reminder_index
- [x] (enums-errors-types) notifications enums.ts (DoctorSuspended, OutboxErrorCode), constants.ts, types.ts
- [x] (enums-errors-types) lib/async/backoff.ts exponentialBackoffMs extraction
- [x] (enums-errors-types) lib/email port + LogEmailAdapter
- [x] (enums-errors-types) lib/identity-client getContacts + contact DTOs + second token cache
- [x] (enums-errors-types) env vars (env.ts, types.ts, .env.example)
- [x] (service) template registry + format-time
- [x] (repository) notification-outbox repo (claimDue, lag, finishRows, purge) + consultations repo functions (delivery contexts, reminder candidates, stamps, newly_flagged)
- [x] (service) ConsultationReminderService
- [x] (service) OutboxDeliveryService, ReminderScanService, OutboxPurgeService
- [x] (service) doctor_suspended producer in ConsultationSuspensionImpactProvider
- [x] (mount) worker loops + worker-loops.ts registration + pool max 6
- [x] (tests) unit tests per piece
- [x] (tests) integration smoke: migrations, claim, reminder scan, purge, producer
- [x] (tests) full integration/concurrency/EXPLAIN/log hygiene suite (tests/integration/notifications-delivery.test.ts, tests/unit/app/notifications/templates.matrix.test.ts)
- [ ] (manual-qa) <- /manual-qa
- [ ] (docs) architecture refresh <- /update-docs
