---
title: verification — Brainstorm
owner: care-team
service: care-service
module: verification
status: draft
diataxis: explanation
last_verified: 2026-10-07
tags: [brainstorm, verification, documents, uploads, case-1, identity-client, storage, worker]
related: [doctors-spec, file-handling, data-model, integration, resilience, adr-0004, adr-0008, adr-0013, adr-0014, adr-0015]
---

# verification — Brainstorm

Issue: OmarRedaX/vcare-care-api#27. Branch `feature/verification`, cut from `feature/doctors` (PR #26 not yet merged).

## Problem & purpose
`doctors` ships the profile and a *dormant* `submit`. Nothing can yet make a doctor bookable: no documents exist, nobody
reviews, and Care never tells Identity to activate the account. `verification` closes the loop: a doctor uploads
credentials, submits, an admin approves or rejects, and **Integration Case 1** moves the Identity account to
`active`/`rejected`. A doctor is bookable only when `verification_status='approved'` **and** `identity_sync_status='synced'`.

## Actors
- **Doctor** (token status `pending`/`active`/`rejected`): uploads documents, submits, resubmits after rejection.
- **Admin**: reads the queue, opens an application, downloads a document, approves, rejects, re-opens.
- **care-worker**: delivers pending Identity status changes; purges abandoned upload intents.
- **Identity** (provider): `PATCH /internal/users/:id/status`, `GET /internal/users?ids=`.

## In scope (this iteration)
1. **Submission** — `POST /doctors/apply` with `submit=true` becomes live: `draft → submitted` (no Identity call) and
   `rejected → submitted` (Case 1, Identity → `pending`). Profile edits (`apply`, `PATCH /me`) are **locked while `submitted`**
   (doctors spec O4) with the existing `ApplicationNotEditable` `409`.
2. **Documents** (ADRs 0013–0015): `POST /doctors/me/documents/uploads` (intent + presigned POST to `quarantine/<uuid>`),
   `…/uploads/{uploadId}/complete` (HEAD size, 16-byte magic check, copy to the final key, row + audit in one transaction),
   `POST /doctors/me/documents/{documentId}/download-url`, soft-delete of an own document while `draft`/`rejected`.
3. **Admin review**: `GET /admin/applications` (queue, keyset), `GET /admin/applications/{id}`,
   `POST /admin/applications/{id}/documents/{documentId}/download-url`, `PATCH …/approve`, `…/reject`, `…/reopen`.
4. **Case 1** end to end: one transaction (decision, `identity_sync_status='pending'`, audit, `identity_sync_jobs` row) →
   inline Identity call, 3 attempts → `200` synced, or `202 identitySync:"pending"` and the worker retries; Identity
   `409 InvalidStatusTransition` → `failed`, `202 identitySync:"failed"`, alert.
5. **New libs** (they do not exist yet): `lib/identity-client` (service-token cache + single-flight + 401 refresh,
   `setUserStatus`, `getUsersBatch` with the `identity:user:<id>` Redis read-through cache, degrade policy),
   `lib/storage` (port + AWS SDK v3 S3 adapter; presigned POST/GET, head, range read, copy, delete).
6. **Worker**: `identity-sync` retry loop (`SKIP LOCKED`, backoff capped at 60 s, alert after 15 min unsynced) and the
   `upload-intent-purge` loop, both registered in `src/worker-loops.ts`.
7. **Tables**: `upload_intents`, `verification_documents`, `identity_sync_jobs`; the verification-queue partial index
   deferred by `doctors`.
8. **Infra for tests and QA**: MinIO in the dev and test compose stacks; runtime deps `@aws-sdk/client-s3`,
   `@aws-sdk/s3-presigned-post`, `@aws-sdk/s3-request-presigner` (ADR 0015 already covers them — no new ADR).

## Out of scope
- Suspension (Case 3) and reinstatement (Case 4), though they reuse `identity_sync_jobs` and the client → `admin`/`doctors` follow-up modules.
- Record attachments (`/records/*/attachments*`) — same storage lib, built with `records`.
- Doctor search, `next_available_at`, slot cache and **their invalidation** → `availability`. Decision (user, 2026-10-07):
  no cache code here; the spec lists the events availability must invalidate on (approve, reject, reopen, sync success).
- Antivirus / deep PDF scan (later `care-worker` loop per file-handling §4).
- Notification emails for decisions (outbox is a later module); the decision is visible via `GET /doctors/me/application`.

## Key entities & relationships
- `doctor_profiles` (exists): holds `verification_status`, `reviewed_by`, `review_note`, `decided_at`, `submitted_at`, `identity_sync_status`.
- `verification_documents` N:1 `doctor_profiles` — `type` license/id/degree, `object_key` (final key, never a URL), `file_type` = detected type, `size_bytes`, `status` uploaded/accepted/rejected, soft delete.
- `upload_intents` — temporary, owner-bound, single-use, 15 min; never exposed.
- `identity_sync_jobs` N:1 `doctor_profiles` — at most one open (`pending`) job per doctor; a newer decision supersedes the older.

## Primary flows / endpoints (roles + ownership)
| Route | Role | Ownership |
|---|---|---|
| `POST /doctors/apply` (`submit=true`) | doctor | self |
| `POST /doctors/me/documents/uploads` · `…/{uploadId}/complete` · `…/{documentId}/download-url` · `DELETE …/{documentId}` | doctor | self (intent owner) |
| `GET /admin/applications` · `GET /admin/applications/{id}` | admin | none |
| `POST /admin/applications/{id}/documents/{documentId}/download-url` | admin | none (audited) |
| `PATCH /admin/applications/{id}/approve` · `/reject` · `/reopen` | admin | none |

The application id is the doctor profile id.

## Business rules & state transitions
`draft → submitted → approved | rejected`, `rejected → submitted` (doctor resubmit or admin reopen). Only `submitted` is
reviewable (`409 ApplicationNotReviewable`). Submit needs ≥ 1 live `license` and ≥ 1 live `id` document. Documents change
only in `draft`/`rejected`. Approved + synced + not suspended + accepting + a consultation type ⇒ bookable (rule 6; the type
term stays `false` until `schedules`). A newer decision supersedes an open sync job in the same transaction.

## Cross-service touchpoints
- **Case 1** (Care → Identity, retry-report-pending): above. Identity's contract already allows `pending→active|rejected`
  and `rejected→pending`; **no Identity contract gap for this module** (provider-first check done 2026-10-07).
- **Case 2** (admin queue/detail): one batched `GET /internal/users?ids=`, cached 300 s, degrade to
  `displayName:null`, `avatarUrl:null`, `profileHydrated:false`.
- **Storage**: S3 (MinIO locally), calls outside any DB transaction, 2 s timeouts (10 s copy).

## Privacy & audit
Documents are identity credentials: object keys, URLs, POST fields never logged or returned by read DTOs. Audit rows (same
transaction): `verification.submitted`, `verification.document_uploaded`, `verification.document_url_issued`,
`verification.document_deleted`, `verification.approved|rejected|reopened`, `identity_sync.synced|pending|failed`; metadata =
ids/statuses/reason, never text beyond the admin reason. Admins may open verification documents (audited); they never see
clinical data (none exists here).

## Constraints & guideline notes
- No conflict with CLAUDE.md found. `GET /admin/applications*` and decisions have no `Idempotency-Key` requirement (optional); decisions are naturally guarded by `submitted`-only.
- The Redis cache in Case 2 is Tier 2: Redis down ⇒ straight to Identity, never an error.
- Docker Desktop and the test compose stack are needed for integration tests; Codex sandbox cannot run Docker (earlier sessions) — the lead runs integration.

## Contract changes expected
Provider is Care; contract first (`/construct-spec` + `/develop` step 0): replace the multipart `POST /doctors/me/documents`
with the uploads / complete / download-url trio; add the admin document `download-url`; add `DELETE …/{documentId}`; drop
`downloadUrl`/`downloadUrlExpiresAt` from `VerificationDocument`; add `UploadIntent`, `DownloadUrl`; add `UploadIntentExpired`
(410); `x-audit-actions` per route; `GET /admin/applications/{id}` description (no inline signed URLs). The identity contract is unchanged.

## Open questions
1. Document **delete**: contract has none; brainstorm default adds `DELETE /doctors/me/documents/{id}` (draft/rejected only) because replacing a wrong upload is otherwise impossible — confirm in spec.
2. Admin approve body `ApplicationApprove` (`note?`) — keep optional note, `reviewNote` stored.
3. Rate limits: intent creation 20/h per user (CLAUDE.md); admin routes 120/min per user (default, spec to confirm).
4. Hub deltas (same session): `landscape.md` Case 1 status (implemented), `deployment.md`/`capacity.md` MinIO + worker loops, `glossary.md` terms, `catalog` card sync via script.
5. Identity docs say reinstatement (`suspended→active`) is not propagated to Care while Care ADR 0012 needs it on the internal route — unrelated to this module, flagged for the reinstatement work.

## Success criteria
- A doctor can upload license + id, submit, and an admin approves; with Identity up the response is `200` and the doctor is `synced`; with Identity down it is `202 pending` and the worker converges once Identity returns.
- Identity `409` ⇒ `failed`, `202 failed`, alert log, doctor stays unbookable.
- A file with a `.pdf` name and non-PDF bytes is rejected at `complete` and creates no row; another user's / expired / closed intent cannot be completed; replay returns the same row.
- Every download-url writes one audit row; no read DTO contains a URL or key.
- Typecheck, lint, unit, integration green; contract conformance for every new operation.
