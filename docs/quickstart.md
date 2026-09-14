---
title: Care Service — Quickstart
owner: care-team
service: care-service
status: draft
diataxis: tutorial
last_verified: 2026-09-14
tags: [tutorial, getting-started, care]
related: [infrastructure, api, integration, scheduling-slots]
---

# Quickstart (tutorial)

From zero to a booked consultation on your machine.

> Application code does not exist yet. Commands marked `(planned)` show the intended shape once modules are
> built through the workflow. All ids and text below are synthetic.

## 1. Prerequisites
- Node.js 24 LTS
- PostgreSQL 16 with the `btree_gist` extension available (`CREATE EXTENSION btree_gist;` must succeed)
- Redis 7
- A running identity-service on `3000` (public, JWKS) and `3100` (internal), or a local fake built from
  `../vcare-hub/contracts/identity-service.openapi.yaml` that serves JWKS, `/internal/auth/token`,
  `/internal/users`, and `/internal/users/:id/status`
- A service client registered in Identity for Care with scopes `users:read users:status:write`

## 2. Configure
```bash
cp .env.example .env    # (planned)
```
Minimum values (full list in [architecture/infrastructure.md](./architecture/infrastructure.md)):
```bash
PORT=3001
INTERNAL_PORT=3101
DATABASE_URL=postgres://care:care@localhost:5432/care
REDIS_URL=redis://localhost:6379
IDENTITY_JWKS_URL=http://localhost:3000/.well-known/jwks.json
IDENTITY_INTERNAL_URL=http://localhost:3100
SERVICE_CLIENT_ID=care-service
SERVICE_CLIENT_SECRET=<from Identity, never committed>
SIGNED_URL_SECRET=<32+ random bytes, never committed>
```

## 3. Install, migrate, run
```bash
npm install          # (planned)
npm run migrate      # (planned) creates btree_gist, all tables, the exclusion constraint
npm run dev          # (planned) public listener :3001, internal listener :3101
curl -s http://localhost:3001/api/health
```
Expect `{"status":"ok","service":"care-service","checks":{"postgres":"up","redis":"up",...}}`.

## 4. Get tokens
Log in through Identity (tokens come from Identity, never from Care):
```bash
PATIENT=$(curl -s -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"patient1@example.test","password":"<synthetic>"}' | jq -r .data.accessToken)
ADMIN=$(curl -s -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin1@example.test","password":"<synthetic>"}' | jq -r .data.accessToken)
```
The patient must have a verified email (`ev=true`) to book.

## 5. Admin approves a doctor (Integration Case 1)
A seeded doctor (user id `204`) has submitted an application (profile id `12`):
```bash
curl -s -X PATCH http://localhost:3001/api/admin/applications/12/approve \
  -H "Authorization: Bearer $ADMIN" -H "Content-Type: application/json" \
  -H "X-Request-Id: 5b3c1e8a-2f4d-4a61-9e0b-7c2d1a3f4e55" \
  -d '{"note":"Documents verified"}'
```
- `200` → Identity confirmed the account is `active`; the doctor becomes bookable once they have hours and a type.
- `202` with `identitySync: "pending"` → Identity was unreachable; the decision is kept and a retry job runs.
  The doctor stays **unbookable** until synced. Stop your Identity fake to see this path.

## 6. Search doctors
```bash
curl -s "http://localhost:3001/api/doctors?specialty=dermatology&language=ar&sort=earliest_availability&limit=10" \
  -H "Authorization: Bearer $PATIENT"
```
If Identity is down, results still arrive with `displayName: null` and `profileHydrated: false`.

## 7. See slots in your timezone
```bash
curl -s "http://localhost:3001/api/doctors/204/slots?typeId=31&from=2026-09-21T00:00:00Z&to=2026-09-28T00:00:00Z&timezone=America/New_York" \
  -H "Authorization: Bearer $PATIENT"
```
Each slot has `startsAt`/`endsAt` in UTC and `startsAtLocal`/`endsAtLocal` rendered in `America/New_York`.
A doctor's Monday morning in `Africa/Cairo` may show as your Sunday night.

## 8. Book with an Idempotency-Key
```bash
KEY=$(uuidgen)
curl -s -X POST http://localhost:3001/api/consultations \
  -H "Authorization: Bearer $PATIENT" -H "Content-Type: application/json" \
  -H "Idempotency-Key: $KEY" \
  -d '{"doctorId":204,"typeId":31,"startsAt":"2026-09-21T06:00:00Z","complaintText":"Synthetic example complaint","patientTimezone":"America/New_York"}'
```
Expect `201` with `status: "booked"`. Run the **same** command again: you get the same consultation back, not a
second booking. Change the body but keep the key: `422 IdempotencyConflict`. Book the same slot with a new key:
`409 SlotUnavailable`.

## 9. List your consultations
```bash
curl -s "http://localhost:3001/api/consultations?scope=upcoming" -H "Authorization: Bearer $PATIENT"
```

## Next
- Routes, roles, and error codes → [architecture/api.md](./architecture/api.md) and [the contract](../contracts/openapi.yaml)
- How slots are computed → [architecture/scheduling-slots.md](./architecture/scheduling-slots.md)
- What happens when Identity is down → [architecture/integration.md](./architecture/integration.md)
