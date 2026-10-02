---
name: rbac-ownership-guard
description: Use when adding or changing any HTTP route in a vcare service, writing a route policy, deciding who may read or change a resource, handling clinical data access, or reviewing authorization. Covers deny-by-default role + ownership policies on every endpoint, the platform permissions matrix, service-token guards for /internal routes, admin-never-sees-clinical rules, clinical-access auditing, and the tests every route needs.
---

# RBAC + Ownership Guard (vcare)

## Overview

**Every endpoint answers two questions before any business logic runs:**
1. **Role** — may a caller with this role use this capability at all?
2. **Ownership** — is *this* resource theirs (or related to them in the allowed way)?

Both must pass. The default is **deny**. A route without a declared policy fails closed and is a Critical review finding.

**Identity of the caller comes only from a verified token** — `req.auth` set by the user-guard (user JWT) or service-guard (service JWT). Never from `X-User-Id`, `X-Role`, a body field, or a path param.

## The policy contract

Care's as-built shape (`src/lib/rbac/types.ts`, care `docs/access/spec.md` §3.4). Identity's `authorize` has no
ownership resolver or checks; its policy shape differs where its rules differ.

```ts
// lib/rbac/types.ts (care)
export type OwnershipDecision = "allow" | "deny-not-found" | "deny-forbidden";

/** Resolvers and checks see ONLY the verified principal and the path params — never the body. */
export interface AccessContext { auth: AuthContext; params: Readonly<Record<string, string>> }
export type OwnershipResolver = (ctx: AccessContext) => Promise<OwnershipDecision>;

export type OwnershipRule =
    | { kind: "none" }                                                  // role check is sufficient (x-ownership: none)
    | { kind: "self" }                                                  // /me routes: the service acts only on auth.userId
    | { kind: "resolver"; name: string; resolve: OwnershipResolver };   // DB-backed predicate (x-ownership: <name>)

export interface AccessCheck {                                          // extra DB-backed condition
    name: string;                                                       // snake_case; logged as reason check:<name>
    appliesTo: readonly Role[];                                         // non-empty subset of roles
    run: (ctx: AccessContext) => Promise<"allow" | "deny-forbidden">;
}

export interface UserPolicy {
    kind: "user";
    roles: readonly Role[];                                             // explicit; no wildcard
    owner: OwnershipRule;                                               // mandatory, even { kind: "none" }
    accountState?: {
        statuses?: Partial<Record<Role, readonly AccountStatus[]>>;    // default ["active"] per role; never "suspended"
        emailVerified?: boolean;                                        // true → ev=false gets 403 EmailNotVerified
    };
    checks?: readonly AccessCheck[];                                    // e.g. doctors' doctor_not_suspended
    audit?: "clinical-read" | "clinical-write" | "admin-action";        // declarative; the service writes the rows
}
export type Policy = UserPolicy;   // the doctors module adds { kind: "service"; scope } with serviceGuard
```

**`authorize(policy)` step order** (each denial logs `access_denied { reason, route }`, never ids):

| # | Step | Denial |
|---|---|---|
| 1 | `req.auth` present (a guard ran) | `401 Unauthorized` |
| 2 | `auth.role ∈ policy.roles` | `403 Forbidden` |
| 3 | `auth.status ∈ statuses[auth.role] ?? ["active"]` — a `suspended` token always lands here | `403 Forbidden` |
| 4 | `accountState.emailVerified` → `auth.emailVerified` | `403 EmailNotVerified` |
| 5 | each check whose `appliesTo` contains the role, in order | `403 Forbidden` |
| 6 | ownership: `none`/`self` allow; the resolver decides | `deny-not-found` → `404 NotFound`; `deny-forbidden` (or anything unexpected) → `403 Forbidden` |

Status, email, and checks run **before** ownership, so a caller who may not act at all cannot probe whether a private
id exists. A resolver or check that throws → `500` through the error handler. At construction (boot) `authorize`
throws `route_without_policy` for `undefined` and `policy_invalid: …` for an invalid shape (empty, duplicate, or
unknown roles; a `statuses` key not in `roles`; an empty list; **any list containing `suspended`**; a check whose
`appliesTo` is empty or not ⊆ `roles`; duplicate or non-snake_case names). The app calls
`assertRoutesAuthorized(app.router)` at boot: every route needs `authorize`, preceded by a guard
(`route_without_policy` / `route_without_guard`); health is exempt by `markProbeExempt`.

**Route composition** (every module `routes.ts` returns `sealRouter(router)`):
```ts
router.<verb>(path,
    rateLimit({ …, subject: byIp })?,   // optional: sheds floods before signature verification
    userGuard(),                        // authentication only: sets req.auth
    authorize(policy),                  // roles → account state → email → checks → ownership
    rateLimit({ …, subject: byUser })?,
    idempotency({ required })?,
    controller.method);
```

**Rules**
- Ownership resolvers **query the database** (e.g. `consultations.patient_user_id = auth.userId`). They never trust ids from the body.
- Use `deny-not-found` for private per-user resources (consultations, records, patient profiles) so non-owners can't probe existence; use `deny-forbidden` when the capability itself is visible (admin screens).
- Services **re-check** invariants that depend on data loaded inside the transaction (e.g. "assigned doctor" on record write) — the guard is the first line, not the only one.
- Response DTOs are **viewer-aware**: the same resource renders fewer fields for an admin than for its clinical owner.

## Platform permissions matrix (PRD §9)

| Capability | Patient | Doctor | Admin |
|---|:--:|:--:|:--:|
| Search doctors | ✅ | — | ✅ |
| Book own consultation | ✅ | — | — |
| Reschedule / cancel on behalf | — | — | ✅ |
| Manage own schedule & pricing | — | ✅ | — |
| Join session | ✅ own | ✅ own | — |
| Write medical record | — | ✅ own (assigned) | — |
| Read clinical records | own | ✅ consulted | — |
| Approve / reject doctor applications | — | — | ✅ |
| Suspend accounts | — | — | ✅ |
| Manage specialties & help articles | — | — | ✅ |

**Access rules (PRD §8):** patients access only their own consultations, records, and profile · doctors access their own schedule and the records of patients they have consulted · admins manage verification, suspension, bookings, and help content — **never clinical notes**.

## Identity service — route policies

| Route | Roles | Ownership | Notes |
|---|---|---|---|
| `POST /auth/register/start`, `/auth/register/complete`, `/auth/login`, `/auth/forgot-password`, `/auth/reset-password` | public (no guard) | — | rate-limited; no `authorize` needed because no principal — register them with an explicit `publicRoute()` marker so the "no policy" check still passes deliberately; login accepts `pending`, `active`, `rejected` (never `suspended`) |
| `POST /auth/refresh`, `/auth/logout` | refresh cookie | family of the presented token | `publicRoute()` + cookie validation in the service |
| `GET /auth/me`, `PATCH /auth/me`, `POST /auth/change-password` | patient, doctor, admin | self | `PATCH /auth/me` cannot touch email/role/status |
| `GET /users`, `GET /users/:id` | admin | none | |
| `PATCH /users/:id/status` | admin | none + service check: not self, target not admin, **target not doctor** (`403 Forbidden`; doctor status only via Care) | writes status history; patients only |
| `GET /users/:id/sessions`, `DELETE /users/:id/sessions` | admin | none | |
| `GET /internal/users` | service | scope `users:read` | |
| `PATCH /internal/users/:id/status` | service | scope `users:status:write` | |
| `POST /internal/auth/token` | client credentials | — | `publicRoute()` on the internal listener; secret verified in service |

Policies list roles **explicitly** — never an "any authenticated user" wildcard — so a role added later gets no
access until a policy names it. Guards authenticate (set `req.auth`); `authorize(policy)` only authorizes.
Self routes (`/auth/me`, `/auth/change-password`) accept `rejected` accounts.

## Care service — route policies

| Route | Roles | Ownership | Audit |
|---|---|---|---|
| `GET /specialties` | patient, doctor, admin | none | — |
| `POST /specialties`, `PATCH /specialties/:id` | admin | none | admin-action |
| `POST /doctors/apply`, `GET/PATCH /doctors/me`, `POST /doctors/me/documents`, `GET /doctors/me/application` | doctor (status `pending`, `active`, or `rejected` — rejected doctors can fix and resubmit) | self (profile by `auth.userId`) | documents: admin-action on review only |
| `GET /doctors`, `GET /doctors/:id`, `GET /doctors/:id/slots` | patient, admin | none (only bookable doctors visible to patients) | — |
| `GET/PUT /doctors/me/working-hours`, `GET/POST /doctors/me/exceptions`, `DELETE /doctors/me/exceptions/:id`, `GET/POST /doctors/me/consultation-types`, `PATCH /doctors/me/consultation-types/:id` | doctor (`active`, not locally suspended) | self; `:id` must belong to the caller's profile → else `deny-not-found` | schedule blocks with conflicts: admin-action |
| `GET /admin/applications`, `GET /admin/applications/:id` | admin | none | — (document URLs issued → admin-action) |
| `PATCH /admin/applications/:id/approve`, `/reject`, `/reopen` | admin | none | admin-action (reopen also returns the Identity account to `pending` via Case 1) |
| `PATCH /admin/doctors/:id/suspend` | admin | none | admin-action |
| `GET /patients/me`, `PATCH /patients/me` | patient | self | clinical-read / clinical-write (allergies, conditions) |
| `GET /patients/:id` | patient (self), doctor | patient: `:id` is self; doctor: has a consultation with the patient → else `deny-not-found` | clinical-read |
| `GET /patients/:id/records` | patient (self), doctor | as above | clinical-read |
| `POST /consultations` | patient (`active`, `emailVerified`) | patient_user_id := `auth.userId` (never from body) | — |
| `GET /consultations` | patient, doctor, admin | patient: own; doctor: own; admin: all (DTO without clinical fields) | — |
| `GET /consultations/:id` | patient, doctor, admin | participant, or admin → admin DTO omits `complaintText` | clinical-read for participants |
| `PATCH /consultations/:id/reschedule` | patient, admin | patient: own + outside policy window; admin: reason required | admin-action for admin |
| `PATCH /consultations/:id/cancel` | patient, doctor, admin | participant; doctor/admin reason required | admin-action for admin |
| `PATCH /consultations/:id/join` | patient, doctor | participant, inside session window | — |
| `PATCH /consultations/:id/start`, `/complete` | doctor | assigned doctor | — |
| `PATCH /consultations/:id/no-show` | doctor, admin | assigned doctor, or admin | admin-action for admin |
| `GET /consultations/waiting-room`, `GET /consultations/calendar` | doctor | own | — |
| `POST /consultations/:id/record` | doctor | assigned doctor + consultation `completed` | clinical-write |
| `GET /records/:id` | patient, doctor | patient: own; doctor: author or has consulted the patient | clinical-read |
| `PATCH /records/:id` | doctor | author (assigned doctor) | clinical-write (amendment after lock) |
| `POST /records/:id/attachments`, `DELETE /records/:id/attachments/:aid` | doctor | author; delete only before lock | clinical-write |
| `GET/POST/PATCH/DELETE /help-articles*` | GET: patient, doctor, admin (published, audience-filtered; admin sees drafts); writes: admin | none | admin-action for writes |
| `GET /audit-logs` | admin | none (metadata only) | — |
| `GET /internal/doctors/:userId/summary` | service | scope `doctors:read` | — |

**Admin + clinical:** admins are **absent** from every record route's `roles` and receive admin DTOs without clinical fields elsewhere. Adding `admin` to a clinical route is a Critical finding.

## Clinical-access auditing
- Policies with `audit: "clinical-read" | "clinical-write"` require the service to write an `audit_logs` row: `actor_user_id, actor_role, action (e.g. record.read), entity_type, entity_id, request_id, metadata (ids/statuses only), created_at`.
- Writes: audit row in the **same transaction** as the change. Reads: audit row written **before** the response is sent; if the audit insert fails, the read fails (`500`) — no unaudited clinical read.
- Issuing a download URL for a document/attachment is itself an audited clinical read: issued on demand per file by a `download-url` route after `authorize(policy)`, never embedded in read DTOs; admins never get record attachment URLs.
- `metadata` never contains clinical text or PII.

## Tests every route needs
```
- [ ] unauthenticated → 401 Unauthorized
- [ ] each role NOT in policy.roles → 403 Forbidden
- [ ] allowed role, non-owner → 404 NotFound (private resources) or 403 Forbidden
- [ ] allowed role, owner → success
- [ ] account-state requirement violated → the specific error (Care: `Forbidden` for a disallowed status incl. `suspended`, `EmailNotVerified`; Identity: `AccountSuspended`; booking: `DoctorNotBookable`…)
- [ ] /internal route with a user token (incl. admin) → 401 ServiceTokenRequired; missing scope → 403 InsufficientScope
- [ ] clinical routes: admin → denied; admin DTOs contain no clinical fields
- [ ] audited routes: exactly one audit row with the right action and no clinical text
- [ ] body/header spoofing (X-User-Id, patientUserId in body) has no effect
```

## Review checklist
- Every `router.<verb>` line has a guard and `authorize(policy)` (or an explicit `publicRoute()`).
- Every policy's roles match `x-roles` and ownership matches `x-ownership` in `contracts/openapi.yaml`.
- Ownership resolvers query by the caller's id from `req.auth`.
- No identity header is read anywhere (`grep -rn "x-user-id" src/` → nothing).
- Viewer-aware DTOs for any resource with clinical fields.
