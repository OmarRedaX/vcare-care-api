# /system-design session checkpoint — ✅ COMPLETE (2026-09-15)

Nothing to resume from this session. All 4 topics decided, written, and verified
(placement grep empty, hub check-freshness OK, docs-sync hook passes after the care card sync).

## What was decided
- Care ADRs 0005–0012: 99.9 % availability (async replica) · Redis Tier 2 + live/ready health · log-derived metrics ·
  separate care-worker · audit_logs monthly partitions · next-available lazy cache + worker refresh ·
  notification outbox + reminder scan · admin doctor reinstatement (Case 4).
- Hub ADRs 0009 (reinstatement via Care, amends 0006) and 0010 (Identity contacts lookup, Case 5).

## ▶ NEXT WORK (not started — pick up here)
1. identity-service (provider first): allow `suspended → active` on internal status route; add
   `GET /internal/users/contacts?ids=` + scope `users:contact:read` (hub TODO → "Follow-ups from care-service").
2. care contract changes via `/construct-spec` + `/develop`: health live/ready, `PATCH /api/admin/doctors/{id}/reinstate`,
   audit-logs time range (list in docs/architecture/deployment.md §6).
3. Re-sync hub after contracts land; hub glossary terms (care-worker, notification outbox, Case 4/5).
4. Nothing was committed — hub and care working trees have uncommitted changes (some pre-dating this session).

Delete this file once the next agent has read it.
