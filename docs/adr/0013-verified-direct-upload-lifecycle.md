---
title: "ADR 0013: Direct-to-S3 uploads through a temporary intent, verified at complete"
owner: care-team
service: care-service
status: accepted
date: 2026-09-15
diataxis: explanation
last_verified: 2026-09-15
tags: [adr, decision, uploads, object-storage, security, clinical, verification]
related: [file-handling, data-model, clinical-records, api, rbac, adr-0014-on-demand-download-urls, adr-0015-aws-sdk-storage-adapter, hub-adr-0011-object-storage-host]
---

# ADR 0013 — Direct-to-S3 uploads through a temporary intent, verified at complete

- **Status:** Accepted • **Date:** 2026-09-15 • **Deciders:** care-team (decisions D1, D2, D4 of the file-handling `/system-design`)

## Context
Verification documents (license, id, degree) and record attachments are PDF, JPEG, or PNG files up to 10 MB,
about 5 k uploads/day (≈ 5.6 GB/day, [capacity.md](../architecture/capacity.md)). The contract modelled them as
`multipart/form-data` through `care-api`, which puts upload bytes and slow client connections on the tasks that
carry the search (< 400 ms) and slot (< 300 ms) budgets. Clinical files must never be trusted by their name or by a
declared content type, and a half-uploaded or unverified object must never become a document or attachment.

## Decision
1. **Pattern:** browsers upload **directly to the private bucket** with a presigned POST; `care-api` never proxies
   upload bytes.
2. **Lifecycle — intent → upload → complete:**
   - `POST …/uploads` authorizes the caller, creates a temporary **upload intent**, and returns a presigned POST for
     a random `quarantine/<uuid>` key (policy: exact key, `content-length-range` 1–10 485 760, server-side
     encryption, 5-minute validity). Rate limit 20 intents/hour per user.
   - The browser POSTs the file to S3.
   - `POST …/uploads/{uploadId}/complete` verifies the **stored object itself** and only then creates the real
     `verification_documents` / `record_attachments` row.
3. **Verification at complete** (in order, all inside the request): lock the intent (`FOR UPDATE`; owner = caller,
   unconsumed, unexpired) → re-check the original authorization (application `draft`/`rejected`; assigned doctor,
   active, not suspended) → `HEAD` size within 1 B–10 MB → read bytes 0–15 and match a magic number (`%PDF-`,
   `FF D8 FF`, `89 50 4E 47 0D 0A 1A 0A`) → copy to the final key (`verification-documents/<uuid>` or
   `record-attachments/<uuid>`), delete the quarantine object → one transaction: insert the row with
   `file_type` = **detected** type, the audit row (`verification.document_uploaded` / `attachment.added`), and
   `consumed_at` + `result_id` on the intent. **The filename and any client- or S3-declared `Content-Type` are
   ignored.**
4. **Failure:** a verification failure deletes the quarantine object, closes the intent (`consumed_at`, no
   `result_id`), emits `upload_verification_failed{reason}`, and returns `400 ValidationFailed` (`field: file`). An
   expired intent → `410 UploadIntentExpired`; a closed intent → `409 Conflict`; replaying `complete` on an intent
   that produced a row → `200` with that row; another user's intent → `404 NotFound`. A storage error leaves the
   intent open so `complete` can be retried until expiry.
5. **Intent storage:** Postgres table `upload_intents` (15-minute expiry, single-use), separate from the real tables;
   not Redis, because Redis is Tier 2 ([ADR 0006](./0006-health-split-redis-tier-2.md)). `care-worker` purges expired
   intents and their quarantine objects; an S3 lifecycle rule expires `quarantine/*` after 24 h as a backstop.
6. **Deeper scanning later** (antivirus, PDF structure) runs in `care-worker` against final objects and soft-deletes
   plus audits a bad file — it adds a check, it does not change this lifecycle.

## Consequences
- ➕ No upload bytes or slow connections on `care-api`; verification costs one `HEAD`, a 16-byte ranged `GET`, a
  `COPY`, and a `DELETE`.
- ➕ A document or attachment row always points at a verified object; no pending state leaks into reviews or records.
- ➕ Size is enforced by S3 before bytes land (POST policy) and again by Care.
- ➖ Two client round trips plus the S3 POST instead of one multipart call.
- ➖ One more table and worker loop; bucket CORS for POST (hub ADR 0011).
- ➖ Magic-number checks prove type, not safety — deeper scanning is a later worker addition.

## Alternatives considered
- **Multipart through Care** (previous contract) — simplest client, but upload bytes hit the latency-budgeted API
  tasks. Rejected in favour of direct upload.
- **Async verification in `care-worker` with a `pending_verification` row** — lighter API, but a pending state in
  the real tables and client polling. Rejected: the real row must exist only after verification.
- **Presigned PUT without a policy** — S3 cannot enforce size before upload. Rejected.
- **Intent in Redis (TTL) or a stateless signed intent token** — lost on Redis failover, or no single-use and no
  cleanup list. Rejected.
