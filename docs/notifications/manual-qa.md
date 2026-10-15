---
title: notifications — Manual QA (CURL)
owner: care-team
service: care-service
module: notifications
status: passed
diataxis: how-to
last_verified: 2026-10-15
tags: [manual-qa, notifications, outbox, reminders, worker]
related: [notifications-spec, notifications-tasks, adr-0011-notification-outbox-and-reminders]
---

# notifications — Manual QA (CURL)

_Run: 2026-10-14, rerun 2026-10-15 after the `runOnce` shutdown fix • Server: http://127.0.0.1:3044 (care-api), fake Identity http://127.0.0.1:3024, `node dist/worker.js --once <loop>` • Result: 156 pass / 0 fail (rerun; the 2026-10-14 run was 155 pass / 1 fail, case 154)_

The module has no HTTP surface for delivery. Producers (booking, reschedule, cancel, schedule block, suspend/reinstate) are driven with CURL against care-api; delivery, reminder scan and purge are driven with `node dist/worker.js --once <loop>` (plus one long-running worker for the recovery case); results are read from the database and the captured worker output. Method `check` rows are database / log / worker assertions. All data is synthetic (patients 501-599, doctors 601-699); the Identity fake serves synthetic contacts and no address, name, token or complaint/reason text is recorded here or in any captured output (section 8 greps for them).

## Environment
- Disposable database `vcare_care_notif_qa` created on the local native Postgres (localhost:5432), migrated (24 migrations) as owner, `ensure-app-login` run; care-api and worker connect as `care_app`. Redis `localhost:6379` db index 9 (flushed by the script). Dev database `vcare_care` untouched. Docker not used; ports 5434/6381 (docker-compose.test.yml) were not up.
- `npm run build`; `node scripts/notifications-qa-fake-identity.mjs` (port 3024); `npx tsx src/server.ts` (PORT 3044, INTERNAL_PORT 3144); worker env exported (DATABASE_URL as care_app, IDENTITY_* to the fake, LOG_LEVEL=info, SERVICE_CLIENT_*, STORAGE_* placeholders).
- Run: `CARE_OWNER_DATABASE_URL=… SERVER_LOG=… QA_REPORT=… bash scripts/curl-test-notifications.sh` (about 4 min including the 750k-row purge plan). Everything started was stopped afterwards and the QA database dropped.
- Windows (git-bash) host, Node 24.11.

## Cases
| # | Method | Path | Role | Scenario | Expected | Got | Result |
|---|--------|------|------|----------|----------|-----|--------|
| 1 | POST | /api/consultations | patient | booking: book (queues booking_confirmed x2) | 201 | 201 | PASS |
| 2 | check | outbox | owner | booking queues booking_confirmed for patient and doctor only [N-R1] | booking_confirmed:501:pending,booking_confirmed:611:pending | booking_confirmed:501:pending,booking_confirmed:611:pending | PASS |
| 3 | check | worker | owner | [CLI] node dist/worker.js --once notification-outbox exits 0 | 0 | 0 | PASS |
| 4 | check | outbox | owner | both booking rows sent after one tick | booking_confirmed:501:sent,booking_confirmed:611:sent | booking_confirmed:501:sent,booking_confirmed:611:sent | PASS |
| 5 | check | log | owner | exactly one email_log_adapter_send per booking row (2 rows -> 2 lines) | 2 | 2 | PASS |
| 6 | check | log | owner | adapter line carries only outboxId/kind/recipientUserId (no address, subject, body) | kind,outboxId,recipientUserId | kind,outboxId,recipientUserId | PASS |
| 7 | check | db | owner | sent rows: attempts=1 (claim number), sent_at set, last_error_code null [N-D2] | 2 1 0 | 2 1 0 | PASS |
| 8 | check | fake | owner | contacts: ONE batched call for the 2 recipients, with the contact token only | 1 501,611 contact | 1 501,611 contact | PASS |
| 9 | check | fake | owner | token requests so far: the worker asked EXACTLY users:contact:read, and no request merges it with other scopes | users:contact:read | users:contact:read | PASS |
| 10 | check | fake | owner | contacts call forwarded an X-Request-Id (uuid) | 1 | 1 | PASS |
| 11 | PATCH | /api/consultations/31/reschedule | patient | reschedule: patient reschedules (queues rescheduled x2) | 200 | 200 | PASS |
| 12 | check | outbox | owner | reschedule queues rescheduled for patient and doctor, once each | booking_confirmed:501:sent,booking_confirmed:611:sent,rescheduled:501:pending,rescheduled:611:pending | booking_confirmed:501:sent,booking_confirmed:611:sent,rescheduled:501:pending,rescheduled:611:pending | PASS |
| 13 | check | outbox | owner | rescheduled rows sent | 501:sent,611:sent | 501:sent,611:sent | PASS |
| 14 | PATCH | /api/consultations/31/cancel | patient | cancel: patient cancels (queues cancelled x2) | 200 | 200 | PASS |
| 15 | check | outbox | owner | cancel queues cancelled for patient and doctor, once each | 501:pending,611:pending | 501:pending,611:pending | PASS |
| 16 | check | outbox | owner | cancelled rows sent | 501:sent,611:sent | 501:sent,611:sent | PASS |
| 17 | check | log | owner | one adapter line per row for the whole booking/reschedule/cancel lifecycle (6 rows -> 6 lines) | 6 | 6 | PASS |
| 18 | check | outbox | owner | lifecycle total: 6 rows, none duplicated | 6 | 6 | PASS |
| 19 | POST | /api/consultations | patient | schedule block: setup booking | 201 | 201 | PASS |
| 20 | POST | /api/doctors/me/exceptions | doctor | schedule block: day off over a booking WITHOUT confirmConflicts | 409 ScheduleConflictsUnconfirmed | 409 ScheduleConflictsUnconfirmed | PASS |
| 21 | check | outbox | owner | unconfirmed block queues nothing [N-R1] | booking_confirmed:502:pending,booking_confirmed:612:pending | booking_confirmed:502:pending,booking_confirmed:612:pending | PASS |
| 22 | POST | /api/doctors/me/exceptions | doctor | schedule block: day off with confirmConflicts=true | 201 | 201 | PASS |
| 23 | check | outbox | owner | confirmed block queues schedule_blocked for the PATIENT only (not the doctor) | 502:pending | 502:pending | PASS |
| 24 | check | outbox | owner | schedule_blocked sent; booking_confirmed x2 sent too | booking_confirmed:502:sent,booking_confirmed:612:sent,schedule_blocked:502:sent | booking_confirmed:502:sent,booking_confirmed:612:sent,schedule_blocked:502:sent | PASS |
| 25 | POST | /api/consultations | patient | suspension: setup booking 1 | 201 | 201 | PASS |
| 26 | POST | /api/consultations | patient | suspension: setup booking 2 | 201 | 201 | PASS |
| 27 | PATCH | /api/admin/doctors/613/suspend | admin | suspension: admin suspends doctor 613 (Identity healthy) | 200 | 200 | PASS |
| 28 | check | outbox | owner | suspension queues doctor_suspended for each affected PATIENT, none for the doctor [N-R17] | 503:pending;504:pending | 503:pending;504:pending | PASS |
| 29 | check | fake | owner | every token request is EXACTLY one of the two scope sets (contact alone / status alone): never merged [Case 5 separation] | 0 | 0 | PASS |
| 30 | check | fake | owner | the status PATCH used the status token, the contacts GET only the contact token | 0 0 | 0 0 | PASS |
| 31 | check | outbox | owner | suspension queued exactly 2 doctor_suspended rows in total | 2 | 2 | PASS |
| 32 | check | outbox | owner | no doctor_suspended row addressed to doctor 613 | 0 | 0 | PASS |
| 33 | check | outbox | owner | doctor_suspended rows sent | 503:sent;504:sent | 503:sent;504:sent | PASS |
| 34 | PATCH | /api/admin/doctors/613/reinstate | admin | suspension: reinstate 613 | 200 | 200 | PASS |
| 35 | PATCH | /api/admin/doctors/613/suspend | admin | suspension: re-suspend 613 (same flag still set) | 200 | 200 | PASS |
| 36 | check | outbox | owner | RE-suspend enqueues NOTHING (flag-once) [N-R17] | 2 | 2 | PASS |
| 37 | PATCH | /api/admin/doctors/613/suspend | admin | suspension: suspend an already-suspended synced doctor (200 no-op) | 200 | 200 | PASS |
| 38 | check | outbox | owner | no-op suspend enqueues nothing | 2 | 2 | PASS |
| 39 | PATCH | /api/admin/doctors/612/suspend | admin | suspension: doctor 612 whose booking was flagged schedule_blocked (different reason) | 200 | 200 | PASS |
| 40 | check | outbox | owner | a row flagged schedule_blocked IS notified when the suspension reason differs | 502:pending | 502:pending | PASS |
| 41 | check | outbox | owner | that doctor_suspended row is sent, with the earlier schedule_blocked row untouched | 502:sent | 502:sent | PASS |
| 42 | POST | /api/consultations | patient | outage[down]: booking still succeeds while Identity is down | 201 | 201 | PASS |
| 43 | check | worker | owner | outage[down]: worker tick exits 0 (a contacts failure is not a tick failure) | 0 | 0 | PASS |
| 44 | check | outbox | owner | [down] rows stay pending, attempts NOT consumed, last_error_code=contacts_unavailable | 2 pending 0 contacts_unavailable | 2 pending 0 contacts_unavailable | PASS |
| 45 | check | outbox | owner | [down] backoff set to ~30 s (22..36 s ahead: 24..36 minus a couple of seconds of tick time) [N-D1] | /^(2[2-9];3[0-6])$/ | 25 | PASS |
| 46 | check | log | owner | outage[down]: notification_contacts_unavailable logged with a fixed error code, not a body | 1 | 1 | PASS |
| 47 | POST | /api/consultations | patient | outage[hang]: booking still succeeds while Identity hangs | 201 | 201 | PASS |
| 48 | check | worker | owner | outage[hang]: worker tick exits 0 and returns after the 2 s client timeout (not hung) | 0 ok | 0 ok | PASS |
| 49 | check | outbox | owner | [hang] rows stay pending, attempts NOT consumed, last_error_code=contacts_unavailable | 4 pending 0 contacts_unavailable | 4 pending 0 contacts_unavailable | PASS |
| 50 | check | outbox | owner | [hang] backoff set to ~30 s (22..36 s ahead: 24..36 minus a couple of seconds of tick time) [N-D1] | /^(2[2-9];3[0-6])$/ | 24 | PASS |
| 51 | check | worker | owner | outage[403]: worker tick exits 0 | 0 | 0 | PASS |
| 52 | check | outbox | owner | [403] rows stay pending, attempts NOT consumed, last_error_code=contacts_unavailable | 4 pending 0 contacts_unavailable | 4 pending 0 contacts_unavailable | PASS |
| 53 | check | outbox | owner | [403] backoff set to ~30 s (22..36 s ahead: 24..36 minus a couple of seconds of tick time) [N-D1] | /^(2[2-9];3[0-6])$/ | 26 | PASS |
| 54 | check | fake | owner | outage[403]: the contacts route WAS reached with the contact token (InsufficientScope, not a token failure) | 1 | 1 | PASS |
| 55 | check | worker | owner | outage[no-scope grant]: worker tick exits 0 | 0 | 0 | PASS |
| 56 | check | outbox | owner | [client lacks users:contact:read] rows stay pending, attempts NOT consumed, last_error_code=contacts_unavailable | 4 pending 0 contacts_unavailable | 4 pending 0 contacts_unavailable | PASS |
| 57 | check | outbox | owner | [client lacks users:contact:read] backoff set to ~30 s (22..36 s ahead: 24..36 minus a couple of seconds of tick time) [N-D1] | /^(2[2-9];3[0-6])$/ | 33 | PASS |
| 58 | check | fake | owner | outage[no-scope grant]: the token request asked exactly users:contact:read | 1 | 1 | PASS |
| 59 | check | outbox | owner | no outage left a row dead or skipped; sends so far unaffected | 0 | 0 | PASS |
| 60 | check | log | owner | no email_log_adapter_send happened for any outage row (nothing sent while Identity was unavailable) | 0 | 0 | PASS |
| 61 | check | worker | owner | long-running worker: worker_started lists the three notification loops | 1 | 1 | PASS |
| 62 | check | outbox | owner | consecutive Identity failures grow the delay 30 s -> 60 s -> 120 s (+-20% jitter, minus <=4 s elapsed) [N-D1] | /^(2[0-9];3[0-6]) (4[4-9];5[0-9];6[0-9];7[0-2]) (9[2-9];1[0-3][0-9];14[0-4]) $/ | 28 58 139  | PASS |
| 63 | check | outbox | owner | after 3 failed ticks the attempts are still 0 | 0 | 0 | PASS |
| 64 | check | outbox | owner | recovery: the running loop delivers all 4 outage rows once Identity is healthy | 4 1 | 4 1 | PASS |
| 65 | check | log | owner | recovery: exactly one adapter line per outage row (no duplicate email) | 4 | 4 | PASS |
| 66 | check | worker | owner | long-running worker graceful SIGTERM (Windows git-bash kill cannot deliver SIGTERM to a native node process) | worker_stopping | not verifiable here (SKIP) | PASS |
| 67 | POST | /api/consultations | patient | skip: booking by a patient absent from Identity | 201 | 201 | PASS |
| 68 | POST | /api/consultations | patient | skip: booking by a patient whose Identity status is suspended | 201 | 201 | PASS |
| 69 | POST | /api/consultations | patient | skip: booking by a patient whose Identity status is pending | 201 | 201 | PASS |
| 70 | POST | /api/consultations | patient | skip: booking by a patient whose Identity status is rejected | 201 | 201 | PASS |
| 71 | check | worker | owner | skip: worker tick exits 0 | 0 | 0 | PASS |
| 72 | check | outbox | owner | unknown recipient -> skipped/recipient_unknown; doctor row still sent | booking_confirmed:589:skipped:recipient_unknown,booking_confirmed:611:sent | booking_confirmed:589:skipped:recipient_unknown,booking_confirmed:611:sent | PASS |
| 73 | check | outbox | owner | suspended recipient -> skipped/recipient_inactive | booking_confirmed:590:skipped:recipient_inactive,booking_confirmed:611:sent | booking_confirmed:590:skipped:recipient_inactive,booking_confirmed:611:sent | PASS |
| 74 | check | outbox | owner | pending recipient -> skipped/recipient_inactive | booking_confirmed:591:skipped:recipient_inactive,booking_confirmed:611:sent | booking_confirmed:591:skipped:recipient_inactive,booking_confirmed:611:sent | PASS |
| 75 | check | outbox | owner | rejected recipient -> skipped/recipient_inactive | booking_confirmed:592:skipped:recipient_inactive,booking_confirmed:611:sent | booking_confirmed:592:skipped:recipient_inactive,booking_confirmed:611:sent | PASS |
| 76 | check | log | owner | skipped rows produced no adapter line (4 doctor rows only) | 4 | 4 | PASS |
| 77 | check | log | owner | skipped rows logged notification_skipped with a fixed reason (4) | 4 | 4 | PASS |
| 78 | check | outbox | owner | skipped rows have attempts=1 and sent_at NULL, never retried | 4 0 | 4 0 | PASS |
| 79 | check | worker | owner | skip: a second tick does not touch skipped rows | 4 | 4 | PASS |
| 80 | check | backoff | owner | transient send failure: attempt/status/last_error_code per tick, dead at attempt 8 [N-R6] | 1:pending:email_error 2:pending:email_error 3:pending:email_error 4:pending:email_error 5:pending:email_error 6:pending:email_error 7:pending:email_error 8:dead:email_error | 1:pending:email_error 2:pending:email_error 3:pending:email_error 4:pending:email_error 5:pending:email_error 6:pending:email_error 7:pending:email_error 8:dead:email_error | PASS |
| 81 | check | backoff | owner | delays 30,60,120,240,480,960,1800 s (jitter pinned to 1.0, cap 30 min) [N-R6] | 30 60 120 240 480 960 1800 | 30 60 120 240 480 960 1800 | PASS |
| 82 | check | backoff | owner | provider-specific error text is mapped into the fixed vocabulary (no provider code stored) | 0 | 0 | PASS |
| 83 | check | log | owner | notification_dead logged once for the dead row; the dead row is surfaced (error level) | 1 | 1 | PASS |
| 84 | check | backoff | owner | thrown send error: email_error, dead at 8, the thrown message is never stored [N-R14] | dead:email_error:8 | dead:email_error:8 | PASS |
| 85 | check | backoff | owner | permanent provider answer: dead at attempt 1 with email_rejected, no retry [N-R9] | 1 dead email_rejected | 1 dead email_rejected | PASS |
| 86 | check | backoff | owner | send that never answers: bounded at 5 s -> email_timeout, retry in 30 s, dead at the (configured) max [N-R20] | 1:pending:email_timeout:30 2:dead:email_timeout:null | 1:pending:email_timeout:30 2:dead:email_timeout:null | PASS |
| 87 | check | backoff | owner | each hung send was cut at ~5 s (2 attempts took 9..20 s wall clock) | /^(9;1[0-9];20)$/ | 13 | PASS |
| 88 | check | outbox | owner | driver rows never touched real consultations or sent real mail | 4 | 4 | PASS |
| 89 | POST | /api/consultations | patient | render: booking (patient zone Europe/Berlin, doctor zone Europe/London) | 201 | 201 | PASS |
| 90 | PATCH | /api/consultations/41/reschedule | patient | render: patient reschedules | 200 | 200 | PASS |
| 91 | PATCH | /api/consultations/41/cancel | admin | render: admin cancels with a reason | 200 | 200 | PASS |
| 92 | check | outbox | owner | render fixtures: 2 booking_confirmed + 2 rescheduled + 2 cancelled pending | 6 | 6 | PASS |
| 93 | check | render | owner | six messages captured, one per row | 6 | 6 | PASS |
| 94 | check | render | owner | every message: addressed to its recipient fixture, greets by name, name only in body, no address in body, recipient zone shown, signed, no reason text | 6 | 6 | PASS |
| 95 | check | render | owner | roles resolved from the database: 3 patient + 3 doctor messages | 3 3 | 3 3 | PASS |
| 96 | check | outbox | owner | render rows marked sent by the capturing run | 6 | 6 | PASS |
| 97 | check | worker | owner | [CLI] node dist/worker.js --once consultation-reminders exits 0 | 0 | 0 | PASS |
| 98 | check | reminder | owner | R1 (+20h, booked 3 days ago): reminder_24h to patient AND doctor | reminder_24h:521:pending,reminder_24h:614:pending | reminder_24h:521:pending,reminder_24h:614:pending | PASS |
| 99 | check | reminder | owner | R2 (+50m): ONLY reminder_1h to both; the 24h reminder is superseded and stamped without a message [N-D6] | reminder_1h:522:pending,reminder_1h:614:pending;1;1 | reminder_1h:522:pending,reminder_1h:614:pending;1;1 | PASS |
| 100 | check | reminder | owner | R3 (+21h, booked inside the 24h window): no message, 24h stamped, 1h not yet [N-R12] | ;1;0 | ;1;0 | PASS |
| 101 | check | reminder | owner | R3C (+40m, booked inside the 1h window): no message, both stamped [N-R12] | ;1;1 | ;1;1 | PASS |
| 102 | check | reminder | owner | R4 (needs_admin_followup=true): reminder_24h to both recipients [N-R22] | reminder_24h:524:pending,reminder_24h:615:pending | reminder_24h:524:pending,reminder_24h:615:pending | PASS |
| 103 | check | reminder | owner | R5 (cancelled): no reminder, nothing stamped | ;0;0 | ;0;0 | PASS |
| 104 | check | reminder | owner | first scan queued 10 reminder rows (R1, R2, R4, R6, R7: two recipients each) | 10 | 10 | PASS |
| 105 | check | reminder | owner | two more scans queue nothing: each (consultation, recipient, kind) exactly once [N-R11] | 10 | 10 | PASS |
| 106 | check | reminder | owner | no duplicate (consultation, recipient, kind) after 3 scans | 0 | 0 | PASS |
| 107 | check | reminder | owner | two scans started simultaneously: still one reminder_24h per recipient [N-R11] | reminder_24h:529:pending,reminder_24h:619:pending | reminder_24h:529:pending,reminder_24h:619:pending | PASS |
| 108 | check | reminder | owner | R6 before reschedule: reminder_24h x2 queued, 24h column stamped | reminder_24h:527:pending,reminder_24h:617:pending;1 | reminder_24h:527:pending,reminder_24h:617:pending;1 | PASS |
| 109 | PATCH | /api/consultations/48/reschedule | patient | reminder: patient reschedules R6 to ~10 h from now | 200 | 200 | PASS |
| 110 | check | reminder | owner | reschedule resets BOTH reminder columns [N-R13] | 0 0 | 0 0 | PASS |
| 111 | PATCH | /api/consultations/49/cancel | patient | reminder: patient cancels R7 after its reminders were queued | 200 | 200 | PASS |
| 112 | check | worker | owner | deliver: outbox tick exits 0 | 0 | 0 | PASS |
| 113 | check | reminder | owner | R1 delivered: reminder_24h sent to both | reminder_24h:521:sent,reminder_24h:614:sent | reminder_24h:521:sent,reminder_24h:614:sent | PASS |
| 114 | check | reminder | owner | R2 delivered: reminder_1h sent to both | reminder_1h:522:sent,reminder_1h:614:sent | reminder_1h:522:sent,reminder_1h:614:sent | PASS |
| 115 | check | reminder | owner | R4 delivered: followup-flagged consultation still reminded, both recipients [N-R22] | reminder_24h:524:sent,reminder_24h:615:sent | reminder_24h:524:sent,reminder_24h:615:sent | PASS |
| 116 | check | reminder | owner | R6: stale reminder_24h (queued for the old start) dropped at claim; rescheduled sent [N-R10] | reminder_24h:527:skipped:consultation_changed,reminder_24h:617:skipped:consultation_changed,rescheduled:527:sent,rescheduled:617:sent | reminder_24h:527:skipped:consultation_changed,reminder_24h:617:skipped:consultation_changed,rescheduled:527:sent,rescheduled:617:sent | PASS |
| 117 | check | reminder | owner | R7: queued reminders dropped after the cancel; cancelled sent [N-R10] | cancelled:528:sent,cancelled:618:sent,reminder_24h:528:skipped:consultation_changed,reminder_24h:618:skipped:consultation_changed | cancelled:528:sent,cancelled:618:sent,reminder_24h:528:skipped:consultation_changed,reminder_24h:618:skipped:consultation_changed | PASS |
| 118 | check | reminder | owner | RC (concurrent scans) delivered once per recipient | reminder_24h:529:sent,reminder_24h:619:sent | reminder_24h:529:sent,reminder_24h:619:sent | PASS |
| 119 | check | reminder | owner | R6 re-armed after the reschedule: the next scan queues a NEW reminder_24h x2 (new start within 24 h) [N-R13, N-D9] | reminder_24h:527:pending,reminder_24h:527:skipped:consultation_changed,reminder_24h:617:pending,reminder_24h:617:skipped:consultation_changed | reminder_24h:527:pending,reminder_24h:527:skipped:consultation_changed,reminder_24h:617:pending,reminder_24h:617:skipped:consultation_changed | PASS |
| 120 | check | reminder | owner | the new reminder payload carries the NEW start instant | 2 | 2 | PASS |
| 121 | check | reminder | owner | R6 re-armed reminders delivered to both | reminder_24h:527:sent,reminder_24h:617:sent | reminder_24h:527:sent,reminder_24h:617:sent | PASS |
| 122 | check | reminder | owner | reminder payload keys within the allowlist | 0 | 0 | PASS |
| 123 | check | reminder | owner | final: no dead row anywhere in the functional sections | 0 | 0 | PASS |
| 124 | check | purge | owner | fixture: 12001 sent rows older than the retention (12000 + the 30d2m boundary row) | 12001 | 12001 | PASS |
| 125 | check | worker | owner | [CLI] node dist/worker.js --once notification-outbox-purge exits 0 | 0 | 0 | PASS |
| 126 | check | purge | owner | outbox_purged logged deleted=12001 (>5000 per statement, so >= 3 batches) | 1 | 1 | PASS |
| 127 | check | purge | owner | no sent row older than 30 days remains | 0 | 0 | PASS |
| 128 | check | purge | owner | sent rows inside the retention survive (100 at 29d + boundary 29d23h58m + this run recents) | 1 | 1 | PASS |
| 129 | check | purge | owner | pending/dead/skipped rows older than 30 days are never deleted [N-R18] | 50 20 30 | 50 20 30 | PASS |
| 130 | check | purge | owner | a second purge tick is a no-op (deleted=0) | 1 | 1 | PASS |
| 131 | check | purge | owner | app role: UPDATE payload is denied (42501), payload/kind immutable | 42501 | 42501 | PASS |
| 132 | check | hygiene | owner | captured output is non-trivial (worker log has the delivery lines) | 1 | 1 | PASS |
| 133 | check | hygiene | owner | no captured worker/api/driver output contains: @example.invalid | 0 | 0 | PASS |
| 134 | check | hygiene | owner | no captured worker/api/driver output contains: qa-fixture- | 0 | 0 | PASS |
| 135 | check | hygiene | owner | no captured worker/api/driver output contains: QA Fixture Person | 0 | 0 | PASS |
| 136 | check | hygiene | owner | no captured worker/api/driver output contains: Hello QA | 0 | 0 | PASS |
| 137 | check | hygiene | owner | no captured worker/api/driver output contains: The Vcare team | 0 | 0 | PASS |
| 138 | check | hygiene | owner | no captured worker/api/driver output contains: Your consultation is booked | 0 | 0 | PASS |
| 139 | check | hygiene | owner | no captured worker/api/driver output contains: was rescheduled | 0 | 0 | PASS |
| 140 | check | hygiene | owner | no captured worker/api/driver output contains: was cancelled | 0 | 0 | PASS |
| 141 | check | hygiene | owner | no captured worker/api/driver output contains: needs follow-up | 0 | 0 | PASS |
| 142 | check | hygiene | owner | no captured worker/api/driver output contains: We need to follow up | 0 | 0 | PASS |
| 143 | check | hygiene | owner | no captured worker/api/driver output contains: Reminder:  | 0 | 0 | PASS |
| 144 | check | hygiene | owner | no captured worker/api/driver output contains: has not been cancelled | 0 | 0 | PASS |
| 145 | check | hygiene | owner | no captured worker/api/driver output contains: Please be ready | 0 | 0 | PASS |
| 146 | check | hygiene | owner | no captured worker/api/driver output contains: Vcare support | 0 | 0 | PASS |
| 147 | check | hygiene | owner | no captured worker/api/driver output contains: QA-COMPLAINT-MARKER-7731 | 0 | 0 | PASS |
| 148 | check | hygiene | owner | no captured worker/api/driver output contains: QA-REASON-MARKER-4410 | 0 | 0 | PASS |
| 149 | check | hygiene | owner | no captured worker/api/driver output contains: QA-SECRET-PROVIDER-MESSAGE | 0 | 0 | PASS |
| 150 | check | hygiene | owner | no captured worker/api/driver output contains: fake-contact-token | 0 | 0 | PASS |
| 151 | check | hygiene | owner | no captured worker/api/driver output contains: fake-status-token | 0 | 0 | PASS |
| 152 | check | hygiene | owner | no captured worker/api/driver output contains: Bearer  | 0 | 0 | PASS |
| 153 | check | hygiene | owner | no captured worker/api/driver output contains: qa-synthetic-secret | 0 | 0 | PASS |
| 154 | check | worker | owner | every --once process shut down cleanly: no runtime abort (libuv assertion) in the captured output | 0 | 0 | PASS (2026-10-14: got 10, FAIL) |
| 155 | check | hygiene | owner | last_error_code only ever holds the fixed vocabulary | 0 | 0 | PASS |
| 156 | check | hygiene | owner | no audit row written by delivery (N-R21): no audit action mentions notification | 0 | 0 | PASS |

## Failures / notes
- Case 154 (worker clean shutdown) — RESOLVED, verified 2026-10-15 on Windows (Node 24.11). 2026-10-14: 10 `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file srcwinasync.c` lines right after `worker_once_completed` of `--once notification-outbox` ticks that sent mail, from `runOnce` (`src/worker.ts`) calling `process.exit(code)` straight after `closeAll()` while undici sockets were still closing. Fix in `src/worker.ts` `runOnce`: it sets `process.exitCode`, lets the event loop drain, and keeps an unref'd 5 s fallback `process.exit` (`ONCE_DRAIN_TIMEOUT_MS`). Linux was not run.
- Rerun evidence (fresh disposable database `vcare_care_notif_qa`, 24 migrations, dropped afterwards; care-api and the fake Identity stopped): (1) full script run twice, both 156 pass / 0 fail; case 154 got 0 assertion lines with 28 `worker_once_completed` lines in the first run. (2) Stress: `node dist/worker.js --once notification-outbox` x 120 sequential runs, each with 2 freshly seeded due `booking_confirmed` rows (240 mails sent, 242 `sent` rows in total with the earlier fixture pair): 0 libuv assertion aborts, 0 non-zero exit codes, 0 hangs (wall clock 2.71 s min / 2.82 s avg / 3.14 s max, including about 2.5 s process start and Identity contacts; none near the 5 s fallback), every run logged exactly 2 `email_log_adapter_send`. (3) Failure exit codes still correct: unknown loop name (`no-such-loop`) x 5 exits 1 (`worker_loop_unknown`), a throwing tick (database port unreachable) x 5 exits 1 (`worker_tick_failed`), none with an assertion, each about 2.5 s. The script's `wrun` still masks the exit code via `worker_once_completed`; the stress loop above used the raw exit code.
- Script bugs fixed during this run (not product failures): (1) outage[403] backoff window lower bound 24 s ignored tick time, now 22..36 s; (2) the thrown-error case had a literal newline inside its `node -e` split; (3) the "second purge tick deleted=0" check counted earlier zero-delete ticks of the long-running worker, now a delta; (4) the send-timeout driver resolved `sent` on abort and so raced the service's own bound, now a provider that never answers (with a keep-alive timer cleared in `finally`).
- Observed behaviours confirmed: exactly one email per recipient per event; unconfirmed schedule block queues nothing; flag-once suspension notice (re-suspend and no-op suspend enqueue nothing; a row flagged for a different reason is notified); Identity down / hanging / 403 / missing scope delays rows ~30 s without consuming attempts and grows 30/60/120 s; unknown or non-active recipients are `skipped` with fixed reason codes and never retried; backoff 30..1800 s then `dead` at attempt 8, permanent answer dead at attempt 1, hung send cut at 5 s as `email_timeout`; reminders 24h/1h dedupe across 3 scans and two concurrent scans, supersede and window rules, reschedule resets and re-arms, cancel drops stale reminders; log and output hygiene (no address, name, subject/body text, token, complaint or reason marker); `last_error_code` only from the fixed vocabulary; no audit rows written by delivery.

## Purge and claim EXPLAIN findings (750k-row outbox, 675k sent, 338k older than 30 days, 109 MB table + 36 MB indexes)
- Purge DELETE as issued by the code, backlog state (338k eligible): 157 ms per 5000-row batch (generic prepared plan identical, 157 ms). The inner `SELECT … ORDER BY sent_at LIMIT 5000 FOR UPDATE SKIP LOCKED` uses `idx_notification_outbox_sent_at` (13 ms, 5023 buffers), but the planner joins it to the outer table with a Hash Semi Join over a **sequential scan of all 750k rows** (14k buffers, ~81 ms), so each batch costs about 150 ms regardless of batch size. Acceptable for the backlog drain (real ticks: 100k, 100k, 100k, 38k, 0 rows deleted in 5.6 s, 5.3 s, 5.0 s, 3.6 s, 2.8 s including ~1 s process start), not a defect. Watch item only: if the backlog drain ever needs to be faster, rewrite as `DELETE … USING (subquery)` or add `RETURNING` batches so the outer relation is not scanned.
- Steady state (backlog drained, 1500 newly expired rows, stale statistics): bitmap scan on `idx_notification_outbox_sent_at` + primary-key probes, 6.4 ms; nothing eligible (the hourly tick): 0.15 ms, 58 buffers.
- Claim statement (20 of 375 due rows): `idx_notification_outbox_pending_next_attempt_at_id` index scan with LockRows, 0.87 ms. Lag query: index-only scan, 0.03 ms. `finishRows` guarded UPDATE: primary-key probe, 0.10 ms. No sequential scan on any hot-path (claim/lag/finish) statement.
