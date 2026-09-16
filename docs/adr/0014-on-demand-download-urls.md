---
title: "ADR 0014: Download URLs are issued on demand as 60-second presigned GETs"
owner: care-team
service: care-service
status: accepted
date: 2026-09-15
diataxis: explanation
last_verified: 2026-09-15
tags: [adr, decision, downloads, object-storage, audit, privacy, clinical]
related: [file-handling, clinical-records, rbac, api, adr-0013-verified-direct-upload-lifecycle, hub-adr-0011-object-storage-host]
---

# ADR 0014 — Download URLs are issued on demand as 60-second presigned GETs

- **Status:** Accepted • **Date:** 2026-09-15 • **Deciders:** care-team (decision D3 of the file-handling `/system-design`)

## Context
The previous design embedded a `downloadUrl` in every record and application read: an HMAC-signed URL over
`(objectKey, viewerUserId, expiresAt)` from `lib/signed-url`, TTL ≤ 10 min. No route in the contract served or
verified that URL, and S3 cannot verify a Care HMAC. With files in a private bucket (ADR 0013) the browser must
download through an S3 presigned URL, which is a bearer credential — anyone holding it can use it until it expires.
Issuing a URL for a clinical file is an audited clinical read, and admins never see clinical files.

## Decision
- **Read DTOs carry no URLs.** `VerificationDocument` and `RecordAttachment` expose metadata only (`id`, `fileType`,
  `sizeBytes`, `description`/`type`, timestamps); `downloadUrl` and `downloadUrlExpiresAt` are removed.
- **One file, one explicit request.** The client calls a `download-url` endpoint for the file the user opens:
  - `POST /api/records/{id}/attachments/{attachmentId}/download-url` — the record's read policy (owning patient,
    author, doctor who consulted the patient; admins never) → audit `attachment.url_issued` (clinical-read);
  - `POST /api/doctors/me/documents/{documentId}/download-url` — doctor, self → audit
    `verification.document_url_issued`;
  - `POST /api/admin/applications/{id}/documents/{documentId}/download-url` — admin → audit
    `verification.document_url_issued` (admin-action).
- Care runs guard → `authorize(policy)` → the audit insert (**if it fails, the request fails**) → returns
  `200 { url, expiresAt }`: an S3 presigned GET valid **60 s** (`DOWNLOAD_URL_TTL_SECONDS`), with
  `ResponseContentDisposition=attachment` and `ResponseContentType` = the verified `file_type`.
- The response is JSON, not a `302`: bearer tokens cannot ride a plain browser navigation. The client navigates to
  the URL, which needs no CORS.
- "Bound to the viewer" becomes **authorized and audited at the moment of issue, usable for 60 s**. URLs are never
  logged, stored, or cached (`Cache-Control: no-store`).
- `lib/signed-url` and `SIGNED_URL_SECRET` are retired.

## Consequences
- ➕ Every issued URL corresponds to a real open by an authorized viewer — the audit trail is precise, and reads of
  a record do not mass-issue URLs for files never opened.
- ➕ The bearer window shrinks from ≤ 10 min to 60 s, and URLs never sit in JSON payloads or client caches.
- ➕ No HMAC secret to rotate; access is revocable at the next click (a suspended doctor gets `403`).
- ➖ One extra round trip per file open.
- ➖ A URL copied within its 60 s could be used by someone else — accepted and documented; forced download and
  no-store limit exposure.

## Alternatives considered
- **Presigned URLs inline in read responses** — fewer calls, but a URL issued and audited per file per read and
  bearer links living up to 10 min in payloads. Rejected.
- **Stream bytes through Care** — strict per-request binding, but download bytes and connection time on `care-api`,
  undoing the direct pattern. Rejected.
- **Keep Care HMAC URLs with a Care redirect route** — needs a Care download route streaming or re-presigning anyway;
  adds a secret for no extra guarantee. Rejected.
