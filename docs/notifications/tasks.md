---
title: notifications — Tasks
owner: care-team
service: care-service
module: notifications
status: done
last_verified: 2026-10-15
tags: [tasks, notifications, outbox, worker]
related: [notifications-spec, notifications-manual-qa, notifications-brainstorm, adr-0011-notification-outbox-and-reminders]
---

# notifications — Tasks

Source: [spec.md](./spec.md) (implemented, v0.2.0). Branch `feature/notifications`. No HTTP surface.

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
- [x] (manual-qa) <- /manual-qa  (2026-10-14: 155 pass / 1 fail; rerun 2026-10-15 after the `runOnce` shutdown fix: 156 pass / 0 fail, 120 stress `--once` runs clean; see manual-qa.md)
- [x] (migration) 20261015120000_notification_outbox_pending_created_at_index (review Medium 2/6: stale-pending gauge index)
- [x] (migration) 20261015120100_notification_outbox_delete_sent_only (review Low 8: BEFORE DELETE trigger, sent rows only)
- [x] (service) review Medium 1: contacts failure ends the tick, one backoff step per tick (OutboxDeliveryService)
- [x] (service) review Medium 2/6: notification_outbox_oldest_pending_age_seconds gauge, notification_contacts_forbidden signal, alerts OutboxPendingStale / NotificationContactsForbidden (spec N-D11, deployment.md, runbook.md)
- [x] (service) review Low 3: per-entry contact validation (identity-client getContacts)
- [x] (enums-errors-types) review Low 4: OUTBOX_BATCH_SIZE max 59 (env.ts, .env.example, spec N-D12)
- [x] (service) review Low 5: release claimed rows without consuming an attempt on a post-claim infrastructure error (spec N-D10)
- [x] (service) review Low 7: greeting-name sanitiser (bidi, zero-width, BOM, separators, URLs)
- [x] (service) review Low 11: reminder dedupe at enqueue (spec N-D13)
- [x] (tests) review fixes: unit (delivery, scan, templates, identity-client, env, lease invariant) and integration (tick backoff, pending-age, release, reminder dedupe, trigger, EXPLAIN)
- [x] (docs) review docs findings: data-model reminder index, INDEX tasks row, brainstorm status
- [ ] (decision) review Low 9 and Low 10 deferred: product decisions for the owner (spec 3.4 step 4, 3.7)
- [x] (docs) architecture refresh <- /update-docs (2026-10-14: spec as-built section 14, data-model, infrastructure, integration, resilience, deployment, capacity, overview, runbook, service card, INDEX; hub landscape, deployment, capacity, data-ownership rows)

## Open items
- Watch item: purge hash semi join over a sequential scan (about 150 ms per 5 000-row batch while draining a large backlog); see spec section 14.
