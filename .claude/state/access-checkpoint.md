# /brainstorm access (then specialties) — checkpoint (care)

Started 2026-10-02. Branch `feature/access` (renamed from feature/specialties) (from main @ 99efa12, PR #18 merged). No GitHub issue yet — create one
once the brief fixes scope (user workflow: issue → branch → PR).

## Context found
- Contract already defines listSpecialties (GET, all roles, `includeInactive` admin-only, cursor, sorted by name),
  createSpecialty (POST, admin, optional Idempotency-Key, audit `specialty.created`, 409 Conflict),
  updateSpecialty (PATCH /{id}, admin, audit `specialty.updated`, 404/409). Schemas Specialty/SpecialtyCreate/SpecialtyUpdate.
- data-model.md: `specialties` table (no soft delete — deactivate via is_active; uq slug, uq name, chk slug format).
- FIRST business module → nothing of lib/auth, lib/rbac, lib/audit exists. `jose` needs no new ADR (ADR 0016).
  audit_logs is month-partitioned from the first migration (ADR 0009) + worker pre-creates partitions.
- Foundation latent issues due with the first module: #5 (:param URIError), #6 (route prefix), #7 (cursor µs),
  #8 (implicit bool conversion — includeInactive!), #9 (rate-limit member), #10 (Redis breaker), #11 (idem record crash),
  #15 (router-level limiter label) if applicable.
- Identity has lib/auth (jwks.ts, user-guard.ts) and lib/rbac (authorize.ts, assert-routes-authorized.ts) to mirror for parity.

## Decisions
- Q1 2026-10-02: SEPARATE `access` unit first (lib/auth, lib/rbac, lib/audit + audit_logs + worker partition loop, foundation #5 #6 #10 #11), no business routes. specialties follows as a thin module (+ #7 #8 #9).
- Q2: Owner + app role — migrations as owner `care`; migration creates NOLOGIN `vcare_app` + grants; API/worker log in as `care_app` (MIGRATION_DATABASE_URL vs DATABASE_URL). Hub deployment secrets list = platform delta (open question).

## ▶ NEXT STEP
Next: /develop access in a NEW session (contract C1/C2 first). Care docs committed on feature/access; hub + identity edits still uncommitted.
- Q3: worker `audit-partitions` loop NOW (worker gets Postgres wiring).
- Q4: user guard only; service guard lands with doctors.
- Q5: readiness gets informational `checks.identityJwks: up|down` (contract change, never fails readiness).
- Q6: manual QA uses REAL local Identity (feature/auth), not a fake script; edge tokens via integration fake JWKS.
- WROTE docs/access/brainstorm.md + INDEX row (2026-10-02).
- Open questions resolved by user 2026-10-02: hub deployment one-liner (owner cred = migrations, app cred = API/worker) → queued for /system-design;
  explicit grants per table migration; suspended_at check inside authorize policy + booking checks target doctor; JWKS max age 1 h / clockTolerance 30 s / fetch timeout 2 s;
  dev DB migrated in place, test DBs reset. Brief updated.
- JWKS: 5-min refresh cadence (Identity max-age=300, emergency rotation ≤5 min) + 1 h stale-if-error cap — recorded in brief.
- GitHub issues: #19 access, #20 specialties (2026-10-02).
- Hub branch `docs/care-access-deltas` (from origin/main, UNCOMMITTED): deployment.md release step 3 owner vs app credential;
  landscape.md JWKS 5-min refresh + 1 h stale cap. check-freshness OK.
- Identity feature/auth (UNCOMMITTED, alongside the old CLAUDE.md edit): docs/architecture/deployment.md JWKS row (> 1 h, not > 5 min).
- /construct-spec access: 2 Explore recon agents running (foundation spec digest; identity auth parity digest). Then dispatch flow-spec-author.
- Recon DONE (both digests; notes in session scratchpad access-recon/). flow-spec-author DISPATCHED for docs/access/spec.md
  with both digests + 5 conflicts (readiness parity, role split/login provisioning, explicit grants + write-migration skill, worker PG + partition loop, boot-assert exemptions).
- Identity (UNCOMMITTED on feature/auth): docs/auth/spec.md §5 keys.ts drift fixed (createPrivateKey/createPublicKey + toCryptoKey, not importJWK).
- Spec v0.1.0 draft written. User answers: Q1 defer audit_logs read indexes to `audit` module; P1 care-migrate runs latest + ensure-app-login (owner needs CREATEROLE);
  CLAUDE.md updated NOW (Authentication JWKS wording + "Two database roles" bullet) — care CLAUDE.md UNCOMMITTED on feature/access.
  Hub (docs/care-access-deltas, uncommitted): + deployment ensure-app-login/CREATEROLE, + data-ownership JWKS row. check-freshness OK.
  NOTE: care AGENTS.md (untracked, belongs to PR #1 chore/codex-setup) still has the old JWKS wording — mirror when PR #1 is updated.
- Spec author RESUMED to fold answers → status ready v1.0.0. Contract C1 (identityJwks) + C2 (bearerUser JWKS wording) applied in /develop step 0.
- SPEC READY: docs/access/spec.md v1.0.0 (1129 lines; §11 none, §12 foundation fixes, §13 follow-ups, §14 decisions/C1/C2/applied platform changes).
