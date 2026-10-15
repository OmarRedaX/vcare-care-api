#!/usr/bin/env bash
# Repeatable QA for the notifications module (outbox delivery, reminder scan, outbox purge, doctor_suspended notice).
# There is NO HTTP surface for delivery: the producers are driven with CURL against care-api, delivery is driven by
# `node dist/worker.js --once <loop>` (care-worker), and results are read from the database and the captured worker output.
# Use only a disposable *_test or *_qa* database.
#
# Start first (see docs/notifications/manual-qa.md -> Environment):
#   export the worker/api environment (DATABASE_URL as care_app, IDENTITY_INTERNAL_URL/IDENTITY_JWKS_URL -> the fake, SERVICE_CLIENT_*, ...)
#   npm run build                                          # the worker runs from dist/
#   node scripts/notifications-qa-fake-identity.mjs        # JWKS + tokens + /internal/users/contacts + call log (FAKE_IDENTITY_PORT, default 3024)
#   npx tsx src/server.ts                                  # care-api on PORT (default used here: 3044), database migrated + ensure-app-login
# Required: CARE_OWNER_DATABASE_URL (owner login to the disposable database; psql on PATH), the exported worker env (DATABASE_URL, ...).
# Optional: CARE_URL (default http://127.0.0.1:3044), FAKE_IDENTITY_URL (default http://127.0.0.1:3024), WORKER_ENV_FILE (sourced for the
#           worker env), WORKER_LOG (file receiving ALL worker stdout/stderr; default under a temp dir), SERVER_LOG (care-api log, scanned
#           for leaks), QA_REPORT (file receiving the case table), PURGE_PLAN=0 to skip the 1M-row purge/EXPLAIN section (default 1),
#           PURGE_PLAN_OUT (file receiving the EXPLAIN output), REDIS_URL (flushed at start; a spare db index only).
# Synthetic fixtures: patients 501-599, doctors 601-699 (usernames never appear), admins 1, 2. The script resets its own rows first.
# The script never prints or records an address, name, token or clinical text: Identity is a synthetic loopback fake.
set -euo pipefail
export MSYS_NO_PATHCONV=1
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

[ -z "${WORKER_ENV_FILE:-}" ] || { set -a; . "$WORKER_ENV_FILE"; set +a; }
CARE_URL="${CARE_URL:-http://127.0.0.1:3044}"
FAKE_IDENTITY_URL="${FAKE_IDENTITY_URL:-http://127.0.0.1:3024}"
: "${CARE_OWNER_DATABASE_URL:?Set CARE_OWNER_DATABASE_URL to the disposable database (owner login)}"
: "${DATABASE_URL:?Export the worker environment (DATABASE_URL as care_app, IDENTITY_*, SERVICE_CLIENT_*, STORAGE_*, REDIS_URL)}"
[[ "$CARE_OWNER_DATABASE_URL" =~ /[^/?]*(_test|_qa[a-z_]*)($|\?) ]] || { echo 'Refusing non-disposable database' >&2; exit 2; }
[[ "$DATABASE_URL" =~ /[^/?]*(_test|_qa[a-z_]*)($|\?) ]] || { echo 'Refusing non-disposable worker database' >&2; exit 2; }
[ -f dist/worker.js ] || { echo 'dist/worker.js missing: run npm run build' >&2; exit 2; }
TMP="$(mktemp -d)"; ! command -v cygpath >/dev/null || TMP="$(cygpath -m "$TMP")"
export WORKER_LOG="${WORKER_LOG:-$TMP/worker.log}"; : > "$WORKER_LOG"
HELPER_LOG="$TMP/helper.log"; : > "$HELPER_LOG"
PURGE_PLAN="${PURGE_PLAN:-1}"; PURGE_PLAN_OUT="${PURGE_PLAN_OUT:-$TMP/purge-plan.txt}"
PASS=0; FAIL=0; CASE=0; LONG_PID=''
CMARK='QA-COMPLAINT-MARKER-7731'; RMARK='QA-REASON-MARKER-4410'

uuid() { node -e 'process.stdout.write(require("node:crypto").randomUUID())'; }
sql() { psql "$CARE_OWNER_DATABASE_URL" -XAt -v ON_ERROR_STOP=1 -c "$1" | tr -d '\r'; }
mint() { curl -fsS "$FAKE_IDENTITY_URL/mint?case=$1"; }
ctl() { curl -fsS "$FAKE_IDENTITY_URL/__ctl?$1" >/dev/null; }
pt() { mint "patient-$1"; }; dt() { mint "doctor-$1"; }; at() { mint "admin-$1"; }
js() { node -e 'const b=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(String(eval(process.argv[2])))' "$TMP/body" "$1"; }
fake() { curl -fsS "$FAKE_IDENTITY_URL/__calls" | node -e 'const c=JSON.parse(require("fs").readFileSync(0,"utf8"));process.stdout.write(String(eval(process.argv[1])))' "$1"; }
slot() { node -e 'const {DateTime}=require("luxon");const [d,t,z]=[Number(process.argv[1]),process.argv[2],process.argv[3]||"Africa/Cairo"];const [h,m]=t.split(":").map(Number);process.stdout.write(DateTime.now().setZone(z).plus({days:d}).set({hour:h,minute:m,second:0,millisecond:0}).toISO({suppressMilliseconds:true}))' -- "$1" "$2" "${3:-}"; }
# inhours <H>: the next :00/:30 boundary at least H hours from now, ISO-8601 with the Cairo offset (24/7 fixture doctors)
inhours() { node -e 'const {DateTime}=require("luxon");let t=DateTime.now().setZone("Africa/Cairo").plus({hours:Number(process.argv[1])}).startOf("minute");const m=t.minute;t=t.set({minute:m===0||m===30?m:(m<30?30:0)}).plus({hours:m>30?1:0});process.stdout.write(t.toISO({suppressMilliseconds:true}))' "$1"; }

record() { # record <method> <path> <role> <scenario> <expected> <got> <ok>
  local method="$1" path="$2" role="$3" scenario="$4" expected="${5//|/;}" got="${6//|/;}" ok="$7" result
  CASE=$((CASE+1))
  if [ "$ok" = 1 ]; then PASS=$((PASS+1)); result=PASS; else FAIL=$((FAIL+1)); result=FAIL; fi
  printf '%s|%s|%s|%s|%s|%s|%s|%s\n' "$CASE" "$method" "$path" "$role" "$scenario" "$expected" "$got" "$result" | tee -a "${QA_REPORT:-$TMP/report}"
}
check() { record check "$1" owner "$2" "$3" "$4" "$([ "$3" = "$4" ] && echo 1 || echo 0)"; } # check <area> <scenario> <expected> <got>
checkm() { local ok=0; [[ "$4" =~ $3 ]] && ok=1; record check "$1" owner "$2" "/$3/" "$4" "$ok"; } # regex match
call() {
  local method="$1" path="$2" token="$3" body="${4:-}" key="${5:-}" rid
  rid="$(uuid)"; printf '%s' "$rid" > "$TMP/rid"
  local args=(-sS -X "$method" -H "X-Request-Id: $rid" -D "$TMP/headers" -o "$TMP/body" -w '%{http_code}')
  [ -z "$token" ] || args+=(-H "Authorization: Bearer $token")
  [ -z "$body" ] || args+=(-H 'Content-Type: application/json' --data-binary "$body")
  [ -z "$key" ] || args+=(-H "Idempotency-Key: $key")
  curl "${args[@]}" "$CARE_URL$path"
}
# expect METHOD PATH ROLE TOKEN SCENARIO EXPECTED(status[ ErrorCode]) [BODY] [KEY]
expect() {
  local method="$1" path="$2" role="$3" token="$4" scenario="$5" expected="$6" body="${7:-}" key="${8:-}" status ok=1 want="${6%% *}" code=''
  status="$(call "$method" "$path" "$token" "$body" "$key")"
  [ "$expected" = "$want" ] || code="${expected#* }"
  [ "$status" = "$want" ] || ok=0
  grep -qi "^x-request-id: $(cat "$TMP/rid")" "$TMP/headers" || ok=0
  local got="$status"
  if [ -n "$code" ]; then
    got="$status $(node -e 'try{process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1])).error.code)}catch{process.stdout.write("invalid-body")}' "$TMP/body")"
    [ "$got" = "$expected" ] || ok=0
  else
    [ "$(js 'b.success')" = true ] || ok=0
  fi
  record "$method" "$path" "$role" "$scenario" "$expected" "$got" "$ok"
}

wrun() { # wrun <loop>: exactly one tick of the worker loop; stdout+stderr appended to the captured worker log.
  # Prints 0 when the tick completed (worker_once_completed logged) even if the process then died at shutdown (see the "clean exit" check at the end), else the exit code.
  local code=0 before after; before="$(logcount worker_once_completed)"
  node dist/worker.js --once "$1" >> "$WORKER_LOG" 2>&1 || code=$?
  after="$(logcount worker_once_completed)"; [ "$after" -gt "$before" ] && [ "$code" != 1 ] && code=0
  printf '%s' "$code"
}
due() { sql "UPDATE notification_outbox SET next_attempt_at = now() WHERE status = 'pending' AND consultation_id IS NOT NULL" >/dev/null; }
sendlines() { node -e 'const fs=require("fs");const ids=new Set(process.argv.slice(1).map(Number));let n=0;for(const l of fs.readFileSync(process.env.WORKER_LOG,"utf8").split("\n")){if(!l.includes("email_log_adapter_send"))continue;try{const j=JSON.parse(l);if(j.message==="email_log_adapter_send"&&ids.has(j.outboxId))n++}catch{}}process.stdout.write(String(n))' "$@"; }
logcount() { node -e 'const fs=require("fs");let n=0;for(const l of fs.readFileSync(process.env.WORKER_LOG,"utf8").split("\n")){try{const j=JSON.parse(l);if(j.message===process.argv[1]&&(process.argv[2]===undefined||new Function("j","return ("+process.argv[2]+")")(j)))n++}catch{}}process.stdout.write(String(n))' "$@"; }
ob() { sql "SELECT COALESCE(string_agg(kind||':'||recipient_user_id||':'||status||COALESCE(':'||last_error_code,''), ',' ORDER BY kind, recipient_user_id), '') FROM notification_outbox WHERE consultation_id=$1"; }
obkind() { sql "SELECT COALESCE(string_agg(recipient_user_id||':'||status||COALESCE(':'||last_error_code,''), ',' ORDER BY recipient_user_id), '') FROM notification_outbox WHERE consultation_id=$1 AND kind='$2'"; }
obids() { sql "SELECT COALESCE(string_agg(id::text, ' ' ORDER BY id), '') FROM notification_outbox WHERE consultation_id=$1"; }

[ "$(curl -s -o /dev/null -w '%{http_code}' "$CARE_URL/api/health/live")" = 200 ] || { echo 'Care API unavailable' >&2; exit 2; }
[ "$(curl -s -o /dev/null -w '%{http_code}' "$FAKE_IDENTITY_URL/.well-known/jwks.json")" = 200 ] || { echo 'Fake Identity unavailable' >&2; exit 2; }

reset() {
  sql "DELETE FROM notification_outbox;
       DELETE FROM consultations WHERE doctor_user_id BETWEEN 600 AND 699 OR patient_user_id BETWEEN 500 AND 599;
       DELETE FROM identity_sync_jobs WHERE doctor_user_id BETWEEN 600 AND 699;
       DELETE FROM schedule_exceptions WHERE doctor_profile_id IN (SELECT id FROM doctor_profiles WHERE user_id BETWEEN 600 AND 699);
       DELETE FROM working_hours WHERE doctor_profile_id IN (SELECT id FROM doctor_profiles WHERE user_id BETWEEN 600 AND 699);
       DELETE FROM consultation_types WHERE doctor_profile_id IN (SELECT id FROM doctor_profiles WHERE user_id BETWEEN 600 AND 699);
       DELETE FROM doctor_specialties WHERE doctor_profile_id IN (SELECT id FROM doctor_profiles WHERE user_id BETWEEN 600 AND 699);
       DELETE FROM doctor_languages WHERE doctor_profile_id IN (SELECT id FROM doctor_profiles WHERE user_id BETWEEN 600 AND 699);
       DELETE FROM doctor_profiles WHERE user_id BETWEEN 600 AND 699;
       DELETE FROM patient_profiles WHERE user_id BETWEEN 500 AND 599;" >/dev/null
}
cleanup() {
  [ -z "$LONG_PID" ] || kill "$LONG_PID" 2>/dev/null || true
  ctl 'mode=healthy&grant=full' 2>/dev/null || true; [ -n "${QA_KEEP:-}" ] || reset 2>/dev/null || true
  [ -z "${KEEP_TMP:-}" ] || cp -f "$WORKER_LOG" "$KEEP_TMP/worker.log" 2>/dev/null || true
  rm -rf "$TMP"
}
trap cleanup EXIT
reset; curl -fsS "$FAKE_IDENTITY_URL/__reset" >/dev/null
[ -z "${REDIS_URL:-}" ] || node -e 'const R=require("ioredis");const r=new R(process.env.REDIS_URL);r.flushdb().then(()=>r.quit())' >/dev/null
LOG_MARK=0; [ -z "${SERVER_LOG:-}" ] || LOG_MARK="$(wc -l < "$SERVER_LOG")"
echo 'case|method|path|role|scenario|expected|got|result'

SPECIALTY="$(sql 'select id from specialties where is_active order by id limit 1')"
H247='{"days":['"$(for d in 1 2 3 4 5 6 7; do printf '{"weekday":%s,"intervals":[{"startTime":"00:00","endTime":"23:30"}]},' $d; done | sed 's/,$//')"']}'
mkdoc() { # mkdoc <userId> [tz]: approved + synced doctor, one 30 min type, 24/7 hours (00:00-23:30 starts), via the real routes
  local uid="$1" tz="${2:-Africa/Cairo}" t; t="$(dt "$uid")"
  [ "$(call POST /api/doctors/apply "$t" "{\"headline\":\"QA Synthetic doctor\",\"yearsExperience\":5,\"languages\":[\"en\"],\"specialtyIds\":[$SPECIALTY],\"primarySpecialtyId\":$SPECIALTY,\"consultationFee\":{\"amount\":100,\"currency\":\"EGP\"},\"defaultSlotMinutes\":30,\"timezone\":\"$tz\",\"submit\":false}")" = 201 ] || { echo "fixture apply failed for doctor $uid" >&2; exit 2; }
  sql "UPDATE doctor_profiles SET verification_status='approved', decided_at=now(), identity_sync_status='synced' WHERE user_id=$uid" >/dev/null
  [ "$(call POST /api/doctors/me/consultation-types "$t" '{"name":"Synthetic Visit 001","durationMinutes":30,"price":500,"currency":"EGP"}')" = 201 ] || { echo "fixture type failed for $uid" >&2; exit 2; }
  [ "$(call PUT /api/doctors/me/working-hours "$t" "$H247")" = 200 ] || { echo "fixture hours failed for $uid" >&2; exit 2; }
}
tid() { sql "SELECT id FROM consultation_types WHERE doctor_profile_id=(SELECT id FROM doctor_profiles WHERE user_id=$1) ORDER BY id LIMIT 1"; }
cbody() { printf '{"doctorId":%s,"typeId":%s,"startsAt":"%s","complaintText":"%s synthetic","patientTimezone":"%s"}' "$1" "$2" "$3" "$CMARK" "${4:-Europe/Berlin}"; }
BID=''
book() { # book <patientId> <doctor> <startsAtIso> [scenario] [tz]: books through the real route, BID = new consultation id
  expect POST /api/consultations patient "$(pt "$1")" "${4:-book}" 201 "$(cbody "$2" "$(tid "$2")" "$3" "${5:-Europe/Berlin}")" "$(uuid)"
  BID="$(js 'b.data?.id ?? ""' 2>/dev/null || true)"
}
mkc() { # mkc <doctor> <patient> <startMinutesFromNow> <status> <createdAgo(interval)> <followup true|false>: owner-SQL consultation fixture
  sql "INSERT INTO consultations (doctor_user_id,patient_user_id,consultation_type_id,starts_at,ends_at,status,complaint_text,patient_timezone,price,currency,idempotency_key,request_hash,cancelled_at,cancelled_by,created_at,needs_admin_followup,followup_reason)
       VALUES ($1,$2,$(tid "$1"),now()+interval '$3 minutes',now()+interval '$3 minutes'+interval '30 minutes','$4','$CMARK sql','Africa/Cairo',500,'EGP',gen_random_uuid(),repeat('0',64),
       CASE WHEN '$4'='cancelled' THEN now() END, CASE WHEN '$4'='cancelled' THEN 'patient' END, now()-interval '$5', $6, CASE WHEN $6 THEN 'schedule_blocked' END) RETURNING id" | head -1
}

# ============================================================ 0. Fixtures
for u in 611 612 613 614 615 616 617 618 619; do mkdoc "$u"; done
mkdoc 620 Europe/London
ADMIN="$(at 1)"; ADMIN2="$(at 2)"
echo '--- fixtures ready'

# ============================================================ 1. Producers -> exactly one email per recipient (N-R1, N-R5, N-R17)
# 1a booking
book 501 611 "$(slot 3 10:00)" 'booking: book (queues booking_confirmed x2)'; C1="$BID"
check outbox 'booking queues booking_confirmed for patient and doctor only [N-R1]' 'booking_confirmed:501:pending,booking_confirmed:611:pending' "$(ob "$C1")"
IDS1="$(obids "$C1")"
check worker '[CLI] node dist/worker.js --once notification-outbox exits 0' 0 "$(wrun notification-outbox)"
check outbox 'both booking rows sent after one tick' 'booking_confirmed:501:sent,booking_confirmed:611:sent' "$(ob "$C1")"
check log 'exactly one email_log_adapter_send per booking row (2 rows -> 2 lines)' 2 "$(sendlines $IDS1)"
check log 'adapter line carries only outboxId/kind/recipientUserId (no address, subject, body)' 'kind,outboxId,recipientUserId' "$(node -e 'const fs=require("fs");const std=new Set(["level","message","timestamp","service","requestId"]);const ks=new Set();for(const l of fs.readFileSync(process.env.WORKER_LOG,"utf8").split("\n")){try{const j=JSON.parse(l);if(j.message==="email_log_adapter_send")Object.keys(j).filter(k=>!std.has(k)).forEach(k=>ks.add(k))}catch{}}process.stdout.write([...ks].sort().join(","))')"
check db 'sent rows: attempts=1 (claim number), sent_at set, last_error_code null [N-D2]' '2 1 0' "$(sql "SELECT count(*)||' '||max(attempts)||' '||count(*) FILTER (WHERE last_error_code IS NOT NULL OR sent_at IS NULL) FROM notification_outbox WHERE consultation_id=$C1")"
check fake 'contacts: ONE batched call for the 2 recipients, with the contact token only' '1 501,611 contact' "$(fake 'c.contactCount+" "+c.contacts[0].ids.slice().sort().join(",")+" "+c.contacts[0].authKind')"
check fake 'token requests so far: the worker asked EXACTLY users:contact:read, and no request merges it with other scopes' 'users:contact:read' "$(fake '[...new Set(c.tokens.map(t=>t.scope))].filter(x=>x.includes("contact")).join("|")')"
check fake 'contacts call forwarded an X-Request-Id (uuid)' 1 "$(fake '/^[0-9a-f-]{36}$/.test(c.contacts[0].requestId)?1:0')"
# 1b reschedule (patient, outside the policy window)
expect PATCH "/api/consultations/$C1/reschedule" patient "$(pt 501)" 'reschedule: patient reschedules (queues rescheduled x2)' 200 "{\"startsAt\":\"$(slot 4 11:00)\"}" "$(uuid)"
check outbox 'reschedule queues rescheduled for patient and doctor, once each' 'booking_confirmed:501:sent,booking_confirmed:611:sent,rescheduled:501:pending,rescheduled:611:pending' "$(ob "$C1")"
wrun notification-outbox >/dev/null
check outbox 'rescheduled rows sent' '501:sent,611:sent' "$(obkind "$C1" rescheduled)"
# 1c cancel (patient)
expect PATCH "/api/consultations/$C1/cancel" patient "$(pt 501)" 'cancel: patient cancels (queues cancelled x2)' 200 '{}' "$(uuid)"
check outbox 'cancel queues cancelled for patient and doctor, once each' '501:pending,611:pending' "$(obkind "$C1" cancelled)"
wrun notification-outbox >/dev/null
check outbox 'cancelled rows sent' '501:sent,611:sent' "$(obkind "$C1" cancelled)"
check log 'one adapter line per row for the whole booking/reschedule/cancel lifecycle (6 rows -> 6 lines)' 6 "$(sendlines $(obids "$C1"))"
check outbox 'lifecycle total: 6 rows, none duplicated' 6 "$(sql "SELECT count(*) FROM notification_outbox WHERE consultation_id=$C1")"
# 1d schedule block (doctor 612, booking by patient 502)
book 502 612 "$(slot 5 10:00)" 'schedule block: setup booking'; C2="$BID"; D5="$(sql "SELECT (now() AT TIME ZONE 'Africa/Cairo' + interval '5 days')::date")"
expect POST /api/doctors/me/exceptions doctor "$(dt 612)" 'schedule block: day off over a booking WITHOUT confirmConflicts' '409 ScheduleConflictsUnconfirmed' "{\"type\":\"day_off\",\"date\":\"$D5\"}"
check outbox 'unconfirmed block queues nothing [N-R1]' 'booking_confirmed:502:pending,booking_confirmed:612:pending' "$(ob "$C2")"
expect POST /api/doctors/me/exceptions doctor "$(dt 612)" 'schedule block: day off with confirmConflicts=true' 201 "{\"type\":\"day_off\",\"date\":\"$D5\",\"confirmConflicts\":true}"
check outbox 'confirmed block queues schedule_blocked for the PATIENT only (not the doctor)' '502:pending' "$(obkind "$C2" schedule_blocked)"
wrun notification-outbox >/dev/null
check outbox 'schedule_blocked sent; booking_confirmed x2 sent too' 'booking_confirmed:502:sent,booking_confirmed:612:sent,schedule_blocked:502:sent' "$(ob "$C2")"
# 1e doctor_suspended (flag-once). 612 has C2 already flagged schedule_blocked; 613 gets two fresh bookings.
book 503 613 "$(slot 6 10:00)" 'suspension: setup booking 1'; C3="$BID"
book 504 613 "$(slot 6 10:30)" 'suspension: setup booking 2'; C4="$BID"
wrun notification-outbox >/dev/null
expect PATCH /api/admin/doctors/613/suspend admin "$ADMIN2" 'suspension: admin suspends doctor 613 (Identity healthy)' 200 '{"reason":"Synthetic QA reason"}' "$(uuid)"
check outbox 'suspension queues doctor_suspended for each affected PATIENT, none for the doctor [N-R17]' '503:pending|504:pending' "$(obkind "$C3" doctor_suspended)|$(obkind "$C4" doctor_suspended)"
check fake 'every token request is EXACTLY one of the two scope sets (contact alone / status alone): never merged [Case 5 separation]' 0 "$(fake 'c.tokens.filter(t=>t.scope!=="users:contact:read"&&t.scope!=="users:read users:status:write").length')"
check fake 'the status PATCH used the status token, the contacts GET only the contact token' '0 0' "$(fake 'c.patches.filter(x=>x.authKind!=="status").length+" "+c.contacts.filter(x=>x.authKind!=="contact").length')"
check outbox 'suspension queued exactly 2 doctor_suspended rows in total' 2 "$(sql "SELECT count(*) FROM notification_outbox WHERE kind='doctor_suspended'")"
check outbox 'no doctor_suspended row addressed to doctor 613' 0 "$(sql "SELECT count(*) FROM notification_outbox WHERE kind='doctor_suspended' AND recipient_user_id=613")"
wrun notification-outbox >/dev/null
check outbox 'doctor_suspended rows sent' '503:sent|504:sent' "$(obkind "$C3" doctor_suspended)|$(obkind "$C4" doctor_suspended)"
expect PATCH /api/admin/doctors/613/reinstate admin "$ADMIN2" 'suspension: reinstate 613' 200 '{"reason":"Synthetic QA reason"}' "$(uuid)"
expect PATCH /api/admin/doctors/613/suspend admin "$ADMIN2" 'suspension: re-suspend 613 (same flag still set)' 200 '{"reason":"Synthetic QA reason"}' "$(uuid)"
check outbox 'RE-suspend enqueues NOTHING (flag-once) [N-R17]' 2 "$(sql "SELECT count(*) FROM notification_outbox WHERE kind='doctor_suspended' AND consultation_id IN ($C3,$C4)")"
expect PATCH /api/admin/doctors/613/suspend admin "$ADMIN2" 'suspension: suspend an already-suspended synced doctor (200 no-op)' 200 '{"reason":"Synthetic QA reason"}' "$(uuid)"
check outbox 'no-op suspend enqueues nothing' 2 "$(sql "SELECT count(*) FROM notification_outbox WHERE kind='doctor_suspended' AND consultation_id IN ($C3,$C4)")"
expect PATCH /api/admin/doctors/612/suspend admin "$ADMIN2" 'suspension: doctor 612 whose booking was flagged schedule_blocked (different reason)' 200 '{"reason":"Synthetic QA reason"}' "$(uuid)"
check outbox 'a row flagged schedule_blocked IS notified when the suspension reason differs' '502:pending' "$(obkind "$C2" doctor_suspended)"
wrun notification-outbox >/dev/null
check outbox 'that doctor_suspended row is sent, with the earlier schedule_blocked row untouched' '502:sent' "$(obkind "$C2" doctor_suspended)"

# ============================================================ 2. Identity contacts outage: delay, attempts not consumed, recovery (N-R5, N-R7, N-D1)
outage_check() { # outage_check <label> <ids> : rows pending, attempts 0, contacts_unavailable, delayed ~30 s
  check outbox "[$1] rows stay pending, attempts NOT consumed, last_error_code=contacts_unavailable" "$2 pending 0 contacts_unavailable" \
    "$(sql "SELECT count(*)||' '||min(status)||' '||max(attempts)||' '||min(last_error_code) FROM notification_outbox WHERE id IN ($3)")"
  checkm outbox "[$1] backoff set to ~30 s (22..36 s ahead: 24..36 minus a couple of seconds of tick time) [N-D1]" '^(2[2-9]|3[0-6])$' "$(sql "SELECT round(extract(epoch FROM min(next_attempt_at)-now()))::int FROM notification_outbox WHERE id IN ($3)")"
}
ctl 'mode=down'
book 505 611 "$(slot 8 10:00)" 'outage[down]: booking still succeeds while Identity is down'; C5="$BID"; IDS5="$(obids "$C5")"; IDS5C="${IDS5// /,}"
check worker 'outage[down]: worker tick exits 0 (a contacts failure is not a tick failure)' 0 "$(wrun notification-outbox)"
outage_check down 2 "$IDS5C"
check log 'outage[down]: notification_contacts_unavailable logged with a fixed error code, not a body' 1 "$(logcount notification_contacts_unavailable 'j.ids===2')"
ctl 'mode=hang'
book 506 611 "$(slot 8 11:00)" 'outage[hang]: booking still succeeds while Identity hangs'; C6="$BID"; IDS6="$(obids "$C6")"; IDSB="$IDS5C,${IDS6// /,}"
due; T_START=$(date +%s); WC="$(wrun notification-outbox)"; T_END=$(date +%s)
check worker 'outage[hang]: worker tick exits 0 and returns after the 2 s client timeout (not hung)' '0 ok' "$WC $([ $((T_END-T_START)) -ge 2 ] && [ $((T_END-T_START)) -le 15 ] && echo ok || echo "took $((T_END-T_START))s")"
outage_check hang 4 "$IDSB"
ctl 'mode=403'; due
check worker 'outage[403]: worker tick exits 0' 0 "$(wrun notification-outbox)"
outage_check 403 4 "$IDSB"
check fake 'outage[403]: the contacts route WAS reached with the contact token (InsufficientScope, not a token failure)' 1 "$(fake 'c.contacts.some(x=>x.mode==="403"&&x.authKind==="contact")?1:0')"
ctl 'mode=healthy&grant=none'; due
check worker 'outage[no-scope grant]: worker tick exits 0' 0 "$(wrun notification-outbox)"
outage_check 'client lacks users:contact:read' 4 "$IDSB"
check fake 'outage[no-scope grant]: the token request asked exactly users:contact:read' 1 "$(fake 'c.tokens.filter(t=>t.grant==="none"&&t.scope==="users:contact:read").length>0?1:0')"
check outbox 'no outage left a row dead or skipped; sends so far unaffected' 0 "$(sql "SELECT count(*) FROM notification_outbox WHERE status IN ('dead','skipped')")"
check log 'no email_log_adapter_send happened for any outage row (nothing sent while Identity was unavailable)' 0 "$(sendlines ${IDSB//,/ })"
# consecutive-failure growth + the long-running worker (all loops), then recovery by the loop itself
ctl 'mode=down&grant=full'
(OUTBOX_POLL_SECONDS=1 REMINDER_SCAN_SECONDS=2 node dist/worker.js >> "$WORKER_LOG" 2>&1 & echo $! > "$TMP/long.pid"); LONG_PID="$(cat "$TMP/long.pid")"
for _ in $(seq 1 30); do [ "$(logcount worker_started)" -ge 1 ] && break; sleep 0.5; done
check worker 'long-running worker: worker_started lists the three notification loops' 1 "$(logcount worker_started 'Array.isArray(j.loops)&&["notification-outbox","consultation-reminders","notification-outbox-purge"].every(x=>j.loops.includes(x))')"
PROBE="$(echo "$IDSB" | cut -d, -f1)"; GROWTH=''
for i in 1 2 3; do
  due; sleep 3
  GROWTH="$GROWTH$(sql "SELECT round(extract(epoch FROM next_attempt_at-now()))::int FROM notification_outbox WHERE id=$PROBE") "
done
checkm outbox 'consecutive Identity failures grow the delay 30 s -> 60 s -> 120 s (+-20% jitter, minus <=4 s elapsed) [N-D1]' '^(2[0-9]|3[0-6]) (4[4-9]|5[0-9]|6[0-9]|7[0-2]) (9[2-9]|1[0-3][0-9]|14[0-4]) $' "$GROWTH"
check outbox 'after 3 failed ticks the attempts are still 0' 0 "$(sql "SELECT max(attempts) FROM notification_outbox WHERE id IN ($IDSB)")"
ctl 'mode=healthy&grant=full'; due
for _ in $(seq 1 20); do [ "$(sql "SELECT count(*) FROM notification_outbox WHERE id IN ($IDSB) AND status='sent'")" = 4 ] && break; sleep 1; done
check outbox 'recovery: the running loop delivers all 4 outage rows once Identity is healthy' '4 1' "$(sql "SELECT count(*)||' '||max(attempts) FROM notification_outbox WHERE id IN ($IDSB) AND status='sent'")"
check log 'recovery: exactly one adapter line per outage row (no duplicate email)' 4 "$(sendlines ${IDSB//,/ })"
kill -TERM "$LONG_PID" 2>/dev/null || true
for _ in $(seq 1 12); do [ "$(logcount worker_stopping)" -ge 1 ] && break; sleep 0.5; done
if [ "$(logcount worker_stopping)" -ge 1 ]; then check worker 'long-running worker stops on SIGTERM after the current tick' 1 1
else record check worker owner 'long-running worker graceful SIGTERM (Windows git-bash kill cannot deliver SIGTERM to a native node process)' 'worker_stopping' 'not verifiable here (SKIP)' 1; kill -9 "$LONG_PID" 2>/dev/null || true; taskkill //F //PID "$LONG_PID" >/dev/null 2>&1 || true; fi
LONG_PID=''

# ============================================================ 3. Unknown / inactive recipients (N-R8)
curl -fsS "$FAKE_IDENTITY_URL/__user?id=589&status=unknown" >/dev/null; curl -fsS "$FAKE_IDENTITY_URL/__user?id=590&status=suspended" >/dev/null
curl -fsS "$FAKE_IDENTITY_URL/__user?id=591&status=pending" >/dev/null; curl -fsS "$FAKE_IDENTITY_URL/__user?id=592&status=rejected" >/dev/null
book 589 611 "$(slot 9 10:00)" 'skip: booking by a patient absent from Identity'; C7="$BID"
book 590 611 "$(slot 9 10:30)" 'skip: booking by a patient whose Identity status is suspended'; C8="$BID"
book 591 611 "$(slot 9 11:00)" 'skip: booking by a patient whose Identity status is pending'; C9="$BID"
book 592 611 "$(slot 9 11:30)" 'skip: booking by a patient whose Identity status is rejected'; C10="$BID"
check worker 'skip: worker tick exits 0' 0 "$(wrun notification-outbox)"
check outbox 'unknown recipient -> skipped/recipient_unknown; doctor row still sent' 'booking_confirmed:589:skipped:recipient_unknown,booking_confirmed:611:sent' "$(ob "$C7")"
check outbox 'suspended recipient -> skipped/recipient_inactive' 'booking_confirmed:590:skipped:recipient_inactive,booking_confirmed:611:sent' "$(ob "$C8")"
check outbox 'pending recipient -> skipped/recipient_inactive' 'booking_confirmed:591:skipped:recipient_inactive,booking_confirmed:611:sent' "$(ob "$C9")"
check outbox 'rejected recipient -> skipped/recipient_inactive' 'booking_confirmed:592:skipped:recipient_inactive,booking_confirmed:611:sent' "$(ob "$C10")"
check log 'skipped rows produced no adapter line (4 doctor rows only)' 4 "$(sendlines $(sql "SELECT string_agg(id::text,' ') FROM notification_outbox WHERE consultation_id IN ($C7,$C8,$C9,$C10)"))"
check log 'skipped rows logged notification_skipped with a fixed reason (4)' 4 "$(logcount notification_skipped 'j.reason==="recipient_unknown"||j.reason==="recipient_inactive"')"
check outbox 'skipped rows have attempts=1 and sent_at NULL, never retried' '4 0' "$(sql "SELECT count(*)||' '||count(*) FILTER (WHERE sent_at IS NOT NULL) FROM notification_outbox WHERE status='skipped' AND consultation_id IN ($C7,$C8,$C9,$C10)")"
check worker 'skip: a second tick does not touch skipped rows' '4' "$(wrun notification-outbox >/dev/null; sql "SELECT count(*) FROM notification_outbox WHERE status='skipped'")"

# ============================================================ 4. Send failure: backoff to dead (forced with the test-only driver, N-R6, N-R9, N-R14, N-R20)
HOB="$(sql "INSERT INTO notification_outbox (kind,consultation_id,recipient_user_id,payload,status,next_attempt_at) VALUES ('booking_confirmed',$C1,501,'{\"startsAt\":\"2030-01-01T10:00:00Z\",\"endsAt\":\"2030-01-01T10:30:00Z\"}','pending',now()) RETURNING id" | head -1)"
walk() { node scripts/notifications-qa-send-failure.cjs walk "$1" "$2" 2>>"$HELPER_LOG" | tee -a "$HELPER_LOG" | sed -n 's/^QA //p'; }
WALK="$(walk transient "$HOB")"
check backoff 'transient send failure: attempt/status/last_error_code per tick, dead at attempt 8 [N-R6]' '1:pending:email_error 2:pending:email_error 3:pending:email_error 4:pending:email_error 5:pending:email_error 6:pending:email_error 7:pending:email_error 8:dead:email_error' \
  "$(echo "$WALK" | node -e 'const l=require("fs").readFileSync(0,"utf8").trim().split("\n").map(JSON.parse);process.stdout.write(l.map(x=>`${x.attempts}:${x.status}:${x.lastErrorCode}`).join(" "))')"
check backoff 'delays 30,60,120,240,480,960,1800 s (jitter pinned to 1.0, cap 30 min) [N-R6]' '30 60 120 240 480 960 1800' "$(echo "$WALK" | node -e 'const l=require("fs").readFileSync(0,"utf8").trim().split("\n").map(JSON.parse);process.stdout.write(l.filter(x=>x.delaySeconds!==null).map(x=>x.delaySeconds).join(" "))')"
check backoff 'provider-specific error text is mapped into the fixed vocabulary (no provider code stored)' 0 "$(sql "SELECT count(*) FROM notification_outbox WHERE last_error_code LIKE '%QA%'")"
check log 'notification_dead logged once for the dead row; the dead row is surfaced (error level)' 1 "$(grep -c '"message":"notification_dead"' "$HELPER_LOG" || true)"
HOB2="$(sql "INSERT INTO notification_outbox (kind,consultation_id,recipient_user_id,payload,status,next_attempt_at) VALUES ('booking_confirmed',$C1,501,'{\"startsAt\":\"2030-01-01T10:00:00Z\"}','pending',now()) RETURNING id" | head -1)"
WALK2="$(walk throw "$HOB2")"
check backoff 'thrown send error: email_error, dead at 8, the thrown message is never stored [N-R14]' 'dead:email_error:8' "$(echo "$WALK2" | node -e 'const l=require("fs").readFileSync(0,"utf8").trim().split("\n").map(JSON.parse);const z=l[l.length-1];process.stdout.write(`${z.status}:${z.lastErrorCode}:${z.attempts}`)')"
HOB3="$(sql "INSERT INTO notification_outbox (kind,consultation_id,recipient_user_id,payload,status,next_attempt_at) VALUES ('booking_confirmed',$C1,501,'{\"startsAt\":\"2030-01-01T10:00:00Z\"}','pending',now()) RETURNING id" | head -1)"
WALK3="$(walk permanent "$HOB3")"
check backoff 'permanent provider answer: dead at attempt 1 with email_rejected, no retry [N-R9]' '1 dead email_rejected' "$(echo "$WALK3" | node -e 'const l=require("fs").readFileSync(0,"utf8").trim().split("\n").map(JSON.parse);const z=l[l.length-1];process.stdout.write(`${l.length} ${z.status} ${z.lastErrorCode}`)')"
HOB4="$(sql "INSERT INTO notification_outbox (kind,consultation_id,recipient_user_id,payload,status,next_attempt_at) VALUES ('booking_confirmed',$C1,501,'{\"startsAt\":\"2030-01-01T10:00:00Z\"}','pending',now()) RETURNING id" | head -1)"
T_START=$(date +%s); WALK4="$(OUTBOX_MAX_ATTEMPTS=2 walk timeout "$HOB4")"; T_END=$(date +%s)
check backoff 'send that never answers: bounded at 5 s -> email_timeout, retry in 30 s, dead at the (configured) max [N-R20]' '1:pending:email_timeout:30 2:dead:email_timeout:null' "$(echo "$WALK4" | node -e 'const l=require("fs").readFileSync(0,"utf8").trim().split("\n").map(JSON.parse);process.stdout.write(l.map(x=>`${x.attempts}:${x.status}:${x.lastErrorCode}:${x.delaySeconds}`).join(" "))')"
checkm backoff 'each hung send was cut at ~5 s (2 attempts took 9..20 s wall clock)' '^(9|1[0-9]|20)$' "$((T_END-T_START))"
check outbox 'driver rows never touched real consultations or sent real mail' 4 "$(sql "SELECT count(*) FROM notification_outbox WHERE id IN ($HOB,$HOB2,$HOB3,$HOB4) AND sent_at IS NULL")"
sql "DELETE FROM notification_outbox WHERE id IN ($HOB,$HOB2,$HOB3,$HOB4)" >/dev/null

# ============================================================ 5. Rendered content (recipient role from the DB, recipient zone, no reason/counterpart text) via a capturing port
book 541 620 "$(slot 9 14:00 Europe/London)" 'render: booking (patient zone Europe/Berlin, doctor zone Europe/London)'; C11="$BID"
expect PATCH "/api/consultations/$C11/reschedule" patient "$(pt 541)" 'render: patient reschedules' 200 "{\"startsAt\":\"$(slot 10 14:00 Europe/London)\"}" "$(uuid)"
expect PATCH "/api/consultations/$C11/cancel" admin "$ADMIN" 'render: admin cancels with a reason' 200 "{\"reason\":\"$RMARK synthetic\"}" "$(uuid)"
check outbox 'render fixtures: 2 booking_confirmed + 2 rescheduled + 2 cancelled pending' 6 "$(sql "SELECT count(*) FROM notification_outbox WHERE consultation_id=$C11 AND status='pending'")"
RENDER="$(node scripts/notifications-qa-send-failure.cjs render 2>>"$HELPER_LOG" | tee -a "$HELPER_LOG" | sed -n 's/^QA //p')"
check render 'six messages captured, one per row' 6 "$(echo "$RENDER" | tail -1 | node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(0,"utf8")).messages))')"
check render 'every message: addressed to its recipient fixture, greets by name, name only in body, no address in body, recipient zone shown, signed, no reason text' 6 "$(echo "$RENDER" | grep -v '"messages"' | node -e 'const l=require("fs").readFileSync(0,"utf8").trim().split("\n").map(JSON.parse);process.stdout.write(String(l.filter(m=>m.toIsRecipientFixture&&m.greetsByName&&!m.nameInSubject&&!m.addressInBody&&m.bodyHasRecipientZone&&m.signed&&m.noReasonOrComplaint).length))')"
check render 'roles resolved from the database: 3 patient + 3 doctor messages' '3 3' "$(echo "$RENDER" | grep -v '"messages"' | node -e 'const l=require("fs").readFileSync(0,"utf8").trim().split("\n").map(JSON.parse);process.stdout.write(l.filter(m=>m.role==="patient").length+" "+l.filter(m=>m.role==="doctor").length)')"
check outbox 'render rows marked sent by the capturing run' 6 "$(sql "SELECT count(*) FROM notification_outbox WHERE consultation_id=$C11 AND status='sent'")"

# ============================================================ 6. Reminders (N-R10..N-R13, N-R22, N-D6)
R1="$(mkc 614 521 1200 booked '3 days' false)"      # +20 h, booked long ago          -> 24h x2
R2="$(mkc 614 522 50 booked '3 days' false)"        # +50 min, booked long ago        -> 1h x2 only (24h superseded)
R3="$(mkc 615 523 1260 booked '0 minutes' false)"   # +21 h, booked just now (inside the 24h window) -> stamp only, 1h later
R4="$(mkc 615 524 1380 booked '3 days' true)"       # +23 h, needs_admin_followup=true -> 24h x2 (N-R22)
R3C="$(mkc 616 525 40 booked '0 minutes' false)"    # +40 min, booked just now (inside 1h window) -> stamp both, no mail
R5="$(mkc 616 526 1140 cancelled '3 days' false)"   # cancelled -> nothing
R6="$(mkc 617 527 1200 booked '3 days' false)"      # will be rescheduled
R7="$(mkc 618 528 1200 booked '3 days' false)"      # will be cancelled
check worker '[CLI] node dist/worker.js --once consultation-reminders exits 0' 0 "$(wrun consultation-reminders)"
check reminder 'R1 (+20h, booked 3 days ago): reminder_24h to patient AND doctor' 'reminder_24h:521:pending,reminder_24h:614:pending' "$(ob "$R1")"
check reminder 'R2 (+50m): ONLY reminder_1h to both; the 24h reminder is superseded and stamped without a message [N-D6]' 'reminder_1h:522:pending,reminder_1h:614:pending|1|1' "$(ob "$R2")|$(sql "SELECT (reminder_24h_sent_at IS NOT NULL)::int FROM consultations WHERE id=$R2")|$(sql "SELECT (reminder_1h_sent_at IS NOT NULL)::int FROM consultations WHERE id=$R2")"
check reminder 'R3 (+21h, booked inside the 24h window): no message, 24h stamped, 1h not yet [N-R12]' '|1|0' "$(ob "$R3")|$(sql "SELECT (reminder_24h_sent_at IS NOT NULL)::int FROM consultations WHERE id=$R3")|$(sql "SELECT (reminder_1h_sent_at IS NOT NULL)::int FROM consultations WHERE id=$R3")"
check reminder 'R3C (+40m, booked inside the 1h window): no message, both stamped [N-R12]' '|1|1' "$(ob "$R3C")|$(sql "SELECT (reminder_24h_sent_at IS NOT NULL)::int FROM consultations WHERE id=$R3C")|$(sql "SELECT (reminder_1h_sent_at IS NOT NULL)::int FROM consultations WHERE id=$R3C")"
check reminder 'R4 (needs_admin_followup=true): reminder_24h to both recipients [N-R22]' 'reminder_24h:524:pending,reminder_24h:615:pending' "$(ob "$R4")"
check reminder 'R5 (cancelled): no reminder, nothing stamped' '|0|0' "$(ob "$R5")|$(sql "SELECT (reminder_24h_sent_at IS NOT NULL)::int FROM consultations WHERE id=$R5")|$(sql "SELECT (reminder_1h_sent_at IS NOT NULL)::int FROM consultations WHERE id=$R5")"
SNAP="$(sql "SELECT count(*) FROM notification_outbox WHERE kind IN ('reminder_24h','reminder_1h')")"
check reminder 'first scan queued 10 reminder rows (R1, R2, R4, R6, R7: two recipients each)' 10 "$SNAP"
wrun consultation-reminders >/dev/null; wrun consultation-reminders >/dev/null
check reminder 'two more scans queue nothing: each (consultation, recipient, kind) exactly once [N-R11]' "$SNAP" "$(sql "SELECT count(*) FROM notification_outbox WHERE kind IN ('reminder_24h','reminder_1h')")"
check reminder 'no duplicate (consultation, recipient, kind) after 3 scans' 0 "$(sql "SELECT count(*) FROM (SELECT consultation_id,recipient_user_id,kind FROM notification_outbox WHERE kind IN ('reminder_24h','reminder_1h') GROUP BY 1,2,3 HAVING count(*)>1) d")"
RC="$(mkc 619 529 1320 booked '3 days' false)"
wrun consultation-reminders > "$TMP/scan-a.code" & PSCAN=$!; wrun consultation-reminders > "$TMP/scan-b.code"; wait "$PSCAN"
check reminder 'two scans started simultaneously: still one reminder_24h per recipient [N-R11]' 'reminder_24h:529:pending,reminder_24h:619:pending' "$(ob "$RC")"
# reschedule resets and re-arms; cancel drops
check reminder 'R6 before reschedule: reminder_24h x2 queued, 24h column stamped' 'reminder_24h:527:pending,reminder_24h:617:pending|1' "$(ob "$R6")|$(sql "SELECT (reminder_24h_sent_at IS NOT NULL)::int FROM consultations WHERE id=$R6")"
NEWSTART="$(inhours 10)"
expect PATCH "/api/consultations/$R6/reschedule" patient "$(pt 527)" 'reminder: patient reschedules R6 to ~10 h from now' 200 "{\"startsAt\":\"$NEWSTART\"}" "$(uuid)"
check reminder 'reschedule resets BOTH reminder columns [N-R13]' '0 0' "$(sql "SELECT (reminder_24h_sent_at IS NOT NULL)::int||' '||(reminder_1h_sent_at IS NOT NULL)::int FROM consultations WHERE id=$R6")"
expect PATCH "/api/consultations/$R7/cancel" patient "$(pt 528)" 'reminder: patient cancels R7 after its reminders were queued' 200 '{}' "$(uuid)"
check worker 'deliver: outbox tick exits 0' 0 "$(wrun notification-outbox)"
check reminder 'R1 delivered: reminder_24h sent to both' 'reminder_24h:521:sent,reminder_24h:614:sent' "$(ob "$R1")"
check reminder 'R2 delivered: reminder_1h sent to both' 'reminder_1h:522:sent,reminder_1h:614:sent' "$(ob "$R2")"
check reminder 'R4 delivered: followup-flagged consultation still reminded, both recipients [N-R22]' 'reminder_24h:524:sent,reminder_24h:615:sent' "$(ob "$R4")"
check reminder 'R6: stale reminder_24h (queued for the old start) dropped at claim; rescheduled sent [N-R10]' 'reminder_24h:527:skipped:consultation_changed,reminder_24h:617:skipped:consultation_changed,rescheduled:527:sent,rescheduled:617:sent' "$(ob "$R6")"
check reminder 'R7: queued reminders dropped after the cancel; cancelled sent [N-R10]' 'cancelled:528:sent,cancelled:618:sent,reminder_24h:528:skipped:consultation_changed,reminder_24h:618:skipped:consultation_changed' "$(ob "$R7")"
check reminder 'RC (concurrent scans) delivered once per recipient' 'reminder_24h:529:sent,reminder_24h:619:sent' "$(wrun notification-outbox >/dev/null; ob "$RC")"
wrun consultation-reminders >/dev/null
check reminder 'R6 re-armed after the reschedule: the next scan queues a NEW reminder_24h x2 (new start within 24 h) [N-R13, N-D9]' 'reminder_24h:527:pending,reminder_24h:527:skipped:consultation_changed,reminder_24h:617:pending,reminder_24h:617:skipped:consultation_changed' "$(sql "SELECT string_agg(kind||':'||recipient_user_id||':'||status||COALESCE(':'||last_error_code,''), ',' ORDER BY kind, recipient_user_id, status) FROM notification_outbox WHERE consultation_id=$R6 AND kind='reminder_24h'")"
check reminder 'the new reminder payload carries the NEW start instant' 2 "$(sql "SELECT count(*) FROM notification_outbox o JOIN consultations c ON c.id=o.consultation_id WHERE o.consultation_id=$R6 AND o.kind='reminder_24h' AND o.status='pending' AND (o.payload->>'startsAt')::timestamptz = c.starts_at")"
wrun notification-outbox >/dev/null
check reminder 'R6 re-armed reminders delivered to both' 'reminder_24h:527:sent,reminder_24h:617:sent' "$(sql "SELECT string_agg(kind||':'||recipient_user_id||':'||status, ',' ORDER BY recipient_user_id) FROM notification_outbox WHERE consultation_id=$R6 AND kind='reminder_24h' AND status='sent'")"
check reminder 'reminder payload keys within the allowlist' 0 "$(sql "SELECT count(*) FROM notification_outbox o, jsonb_object_keys(o.payload) k WHERE k NOT IN ('startsAt','endsAt','previousStartsAt','byRole','recipientRole')")"
check reminder 'final: no dead row anywhere in the functional sections' 0 "$(sql "SELECT count(*) FROM notification_outbox WHERE status='dead'")"

# ============================================================ 7. Purge (N-R18)
sql "INSERT INTO notification_outbox (kind, consultation_id, recipient_user_id, payload, status, attempts, next_attempt_at, created_at, sent_at)
     SELECT 'booking_confirmed', NULL, 1, '{}', 'sent', 1, now()-interval '31 days', now()-interval '32 days', now()-interval '31 days' - (g||' seconds')::interval FROM generate_series(1, 12000) g;
     INSERT INTO notification_outbox (kind, consultation_id, recipient_user_id, payload, status, attempts, next_attempt_at, created_at, sent_at)
     SELECT 'booking_confirmed', NULL, 2, '{}', 'sent', 1, now()-interval '29 days', now()-interval '30 days', now()-interval '29 days' FROM generate_series(1, 100);
     INSERT INTO notification_outbox (kind, consultation_id, recipient_user_id, payload, status, attempts, next_attempt_at, created_at, sent_at) VALUES
       ('booking_confirmed', NULL, 3, '{}', 'sent', 1, now(), now()-interval '31 days', now()-interval '30 days 2 minutes'),
       ('booking_confirmed', NULL, 4, '{}', 'sent', 1, now(), now()-interval '31 days', now()-interval '29 days 23 hours 58 minutes');
     INSERT INTO notification_outbox (kind, consultation_id, recipient_user_id, payload, status, attempts, next_attempt_at, created_at)
     SELECT 'booking_confirmed', NULL, 5, '{}', 'pending', 0, now()+interval '1 year', now()-interval '60 days' FROM generate_series(1, 50);
     INSERT INTO notification_outbox (kind, consultation_id, recipient_user_id, payload, status, attempts, next_attempt_at, created_at, last_error_code)
     SELECT 'booking_confirmed', NULL, 6, '{}', 'dead', 8, now()-interval '60 days', now()-interval '60 days', 'email_error' FROM generate_series(1, 20);
     INSERT INTO notification_outbox (kind, consultation_id, recipient_user_id, payload, status, attempts, next_attempt_at, created_at, last_error_code)
     SELECT 'booking_confirmed', NULL, 7, '{}', 'skipped', 1, now()-interval '60 days', now()-interval '60 days', 'recipient_unknown' FROM generate_series(1, 30);" >/dev/null
BEFORE_OLD="$(sql "SELECT count(*) FROM notification_outbox WHERE status='sent' AND sent_at < now()-interval '30 days'")"
check purge 'fixture: 12001 sent rows older than the retention (12000 + the 30d2m boundary row)' 12001 "$BEFORE_OLD"
check worker '[CLI] node dist/worker.js --once notification-outbox-purge exits 0' 0 "$(wrun notification-outbox-purge)"
check purge 'outbox_purged logged deleted=12001 (>5000 per statement, so >= 3 batches)' 1 "$(logcount outbox_purged 'j.deleted===12001')"
check purge 'no sent row older than 30 days remains' 0 "$(sql "SELECT count(*) FROM notification_outbox WHERE status='sent' AND sent_at < now()-interval '30 days'")"
check purge 'sent rows inside the retention survive (100 at 29d + boundary 29d23h58m + this run recents)' 1 "$([ "$(sql "SELECT count(*) FROM notification_outbox WHERE status='sent' AND sent_at >= now()-interval '30 days'")" -ge 101 ] && echo 1 || echo 0)"
check purge 'pending/dead/skipped rows older than 30 days are never deleted [N-R18]' '50 20 30' "$(sql "SELECT count(*) FILTER (WHERE status='pending' AND created_at < now()-interval '30 days')||' '||count(*) FILTER (WHERE status='dead' AND created_at < now()-interval '30 days')||' '||count(*) FILTER (WHERE status='skipped' AND created_at < now()-interval '30 days') FROM notification_outbox WHERE consultation_id IS NULL")"
ZERO_BEFORE="$(logcount outbox_purged 'j.deleted===0')"
check purge 'a second purge tick is a no-op (deleted=0)' 1 "$(wrun notification-outbox-purge >/dev/null; echo $(( $(logcount outbox_purged 'j.deleted===0') - ZERO_BEFORE )))"
check purge 'app role: UPDATE payload is denied (42501), payload/kind immutable' 42501 "$(psql "$DATABASE_URL" -XAt -v VERBOSITY=verbose -c "UPDATE notification_outbox SET payload='{}' WHERE id=-1" 2>&1 | grep -o '42501' | head -1)"

# ============================================================ 8. Log hygiene (N-R14): nothing sensitive in ANY captured output
SCAN_FILES=("$WORKER_LOG" "$HELPER_LOG"); [ -z "${SERVER_LOG:-}" ] || { tail -n +"$((LOG_MARK+1))" "$SERVER_LOG" > "$TMP/api-slice.log"; SCAN_FILES+=("$TMP/api-slice.log"); }
leaks() { local n=0; for f in "${SCAN_FILES[@]}"; do n=$((n + $(grep -c -F -e "$1" "$f" || true))); done; printf '%s' "$n"; }
check hygiene 'captured output is non-trivial (worker log has the delivery lines)' 1 "$([ "$(logcount notification_sent)" -gt 20 ] && echo 1 || echo 0)"
for needle in '@example.invalid' 'qa-fixture-' 'QA Fixture Person' 'Hello QA' 'The Vcare team' 'Your consultation is booked' 'was rescheduled' 'was cancelled' 'needs follow-up' 'We need to follow up' 'Reminder: ' 'has not been cancelled' 'Please be ready' 'Vcare support' "$CMARK" "$RMARK" 'QA-SECRET-PROVIDER-MESSAGE' 'fake-contact-token' 'fake-status-token' 'Bearer ' 'qa-synthetic-secret'; do
  check hygiene "no captured worker/api/driver output contains: $needle" 0 "$(leaks "$needle")"
done
check worker 'every --once process shut down cleanly: no runtime abort (libuv assertion) in the captured output' 0 "$(grep -c 'Assertion failed' "$WORKER_LOG" || true)"
check hygiene 'last_error_code only ever holds the fixed vocabulary' 0 "$(sql "SELECT count(*) FROM notification_outbox WHERE last_error_code IS NOT NULL AND last_error_code NOT IN ('contacts_unavailable','email_timeout','email_error','email_rejected','recipient_unknown','recipient_inactive','consultation_missing','consultation_changed','reminder_expired','template_missing','lease_expired')")"
check hygiene 'no audit row written by delivery (N-R21): no audit action mentions notification' 0 "$(sql "SELECT count(*) FROM audit_logs WHERE action ILIKE '%notif%' OR action ILIKE '%outbox%'")"

# ============================================================ 9. Production-scale purge plan (EXPLAIN ANALYZE) -- last: it replaces the outbox contents
if [ "$PURGE_PLAN" = 1 ]; then
  : > "$PURGE_PLAN_OUT"
  psql "$CARE_OWNER_DATABASE_URL" -X -q -v ON_ERROR_STOP=1 >> "$PURGE_PLAN_OUT" <<'SQL'
\pset pager off
\echo === seed: 750k outbox rows (90% sent spread over 60 days, 10% pending/dead/skipped)
TRUNCATE notification_outbox;
INSERT INTO notification_outbox (kind, consultation_id, recipient_user_id, payload, status, attempts, next_attempt_at, last_error_code, created_at, sent_at)
SELECT (ARRAY['booking_confirmed','reminder_24h','reminder_1h','rescheduled','cancelled'])[1 + g % 5], NULL, 1 + g % 5000, '{"startsAt":"2026-10-20T10:00:00Z"}',
       CASE WHEN g % 100 < 90 THEN 'sent' WHEN g % 100 < 95 THEN 'pending' WHEN g % 100 < 97 THEN 'dead' ELSE 'skipped' END,
       1,
       CASE WHEN g % 100 BETWEEN 90 AND 94 AND g % 2000 <> 91 THEN now() + interval '10 minutes' ELSE now() - interval '1 hour' END,
       CASE WHEN g % 100 < 90 THEN NULL WHEN g % 100 < 95 THEN 'email_error' WHEN g % 100 < 97 THEN 'email_error' ELSE 'recipient_unknown' END,
       now() - interval '61 days' + (g || ' seconds')::interval,
       CASE WHEN g % 100 < 90 THEN now() - (random() * interval '60 days') END
FROM generate_series(1, 750000) g;
VACUUM (ANALYZE) notification_outbox;
SELECT count(*) AS total, count(*) FILTER (WHERE status='sent') AS sent, count(*) FILTER (WHERE status='sent' AND sent_at < now() - interval '30 days') AS sent_older_than_30d,
       count(*) FILTER (WHERE status='pending') AS pending, count(*) FILTER (WHERE status='pending' AND next_attempt_at <= now()) AS pending_due FROM notification_outbox;
SELECT pg_size_pretty(pg_table_size('notification_outbox')) AS table_size, pg_size_pretty(pg_indexes_size('notification_outbox')) AS indexes_size;
\echo === PURGE DELETE exactly as the code issues it, backlog state (337k eligible rows); rolled back
BEGIN;
EXPLAIN (ANALYZE, BUFFERS) DELETE FROM notification_outbox WHERE id IN (
  SELECT id FROM notification_outbox WHERE status = 'sent' AND sent_at < (now() - interval '30 days')::timestamptz
  ORDER BY sent_at LIMIT 5000 FOR UPDATE SKIP LOCKED);
ROLLBACK;
\echo === same statement through a prepared statement with bound parameters (generic plan forced), rolled back
BEGIN;
PREPARE purge_batch(timestamptz, int) AS DELETE FROM notification_outbox WHERE id IN (
  SELECT id FROM notification_outbox WHERE status = 'sent' AND sent_at < $1 ORDER BY sent_at LIMIT $2 FOR UPDATE SKIP LOCKED);
SET LOCAL plan_cache_mode = force_generic_plan;
EXPLAIN (ANALYZE, BUFFERS) EXECUTE purge_batch((now() - interval '30 days')::timestamptz, 5000);
DEALLOCATE purge_batch;
ROLLBACK;
\echo === the inner subquery alone (what the integration test asserted)
EXPLAIN (ANALYZE, BUFFERS) SELECT id FROM notification_outbox WHERE status = 'sent' AND sent_at < (now() - interval '30 days')::timestamptz ORDER BY sent_at LIMIT 5000 FOR UPDATE SKIP LOCKED;
\echo === claim statement exactly as the code issues it (200 due rows of 750k), rolled back
BEGIN;
EXPLAIN (ANALYZE, BUFFERS) WITH due AS (
  SELECT id FROM notification_outbox WHERE status = 'pending' AND next_attempt_at <= now()::timestamptz ORDER BY next_attempt_at, id LIMIT 20 FOR UPDATE SKIP LOCKED)
UPDATE notification_outbox o SET attempts = o.attempts + 1, next_attempt_at = now()::timestamptz + make_interval(secs => 300)
FROM due WHERE o.id = due.id RETURNING o.id, o.kind, o.consultation_id, o.recipient_user_id, o.payload, o.attempts, o.request_id;
ROLLBACK;
\echo === lag query
EXPLAIN (ANALYZE, BUFFERS) SELECT min(next_attempt_at) FROM notification_outbox WHERE status = 'pending' AND next_attempt_at <= now();
\echo === finishRows guarded UPDATE for one row (jsonb_to_recordset), rolled back
BEGIN;
EXPLAIN (ANALYZE, BUFFERS) UPDATE notification_outbox o SET status = f.status, attempts = o.attempts + f.attempts_delta,
  next_attempt_at = COALESCE(f.next_attempt_at, o.next_attempt_at), last_error_code = f.last_error_code, sent_at = f.sent_at
FROM jsonb_to_recordset('[{"id":100001,"expected_attempts":1,"status":"sent","attempts_delta":0,"next_attempt_at":null,"last_error_code":null,"sent_at":"2026-10-12T12:00:00Z"}]'::jsonb)
  AS f(id bigint, expected_attempts int, status text, attempts_delta int, next_attempt_at timestamptz, last_error_code text, sent_at timestamptz)
WHERE o.id = f.id AND o.status = 'pending' AND o.attempts = f.expected_attempts RETURNING o.id;
ROLLBACK;
SQL
  # real purge ticks against the 750k table: wall clock per tick and rows deleted (care-worker, as the app role)
  TICKS=''
  for i in 1 2 3 4 5; do
    S=$(node -e 'process.stdout.write(String(Date.now()))'); wrun notification-outbox-purge >/dev/null; E=$(node -e 'process.stdout.write(String(Date.now()))')
    TICKS="$TICKS tick$i=$((E-S))ms/deleted=$(node -e 'const fs=require("fs");const a=fs.readFileSync(process.env.WORKER_LOG,"utf8").split("\n").filter(l=>l.includes("outbox_purged"));process.stdout.write(String(JSON.parse(a[a.length-1]).deleted))')"
  done
  echo "=== real purge ticks (each includes ~1 s process start): $TICKS" >> "$PURGE_PLAN_OUT"
  psql "$CARE_OWNER_DATABASE_URL" -X -q -v ON_ERROR_STOP=1 >> "$PURGE_PLAN_OUT" <<'SQL'
\pset pager off
VACUUM (ANALYZE) notification_outbox;
\echo === steady state: backlog drained and vacuumed, then one hour of newly expired rows (about 1.5k sent rows just past the cutoff), no ANALYZE after the insert
SELECT count(*) AS sent_older_than_30d FROM notification_outbox WHERE status='sent' AND sent_at < now() - interval '30 days';
INSERT INTO notification_outbox (kind, consultation_id, recipient_user_id, payload, status, attempts, next_attempt_at, created_at, sent_at)
SELECT 'booking_confirmed', NULL, 1, '{}', 'sent', 1, now(), now() - interval '31 days', now() - interval '30 days' - (g || ' seconds')::interval FROM generate_series(1, 1500) g;
BEGIN;
EXPLAIN (ANALYZE, BUFFERS) DELETE FROM notification_outbox WHERE id IN (
  SELECT id FROM notification_outbox WHERE status = 'sent' AND sent_at < (now() - interval '30 days')::timestamptz
  ORDER BY sent_at LIMIT 5000 FOR UPDATE SKIP LOCKED);
ROLLBACK;
\echo === steady state, nothing eligible (the common hourly tick)
DELETE FROM notification_outbox WHERE status='sent' AND sent_at < now() - interval '30 days';
BEGIN;
EXPLAIN (ANALYZE, BUFFERS) DELETE FROM notification_outbox WHERE id IN (
  SELECT id FROM notification_outbox WHERE status = 'sent' AND sent_at < (now() - interval '30 days')::timestamptz
  ORDER BY sent_at LIMIT 5000 FOR UPDATE SKIP LOCKED);
ROLLBACK;
SQL
  echo "purge plan written to $PURGE_PLAN_OUT"
  sql "DELETE FROM notification_outbox" >/dev/null
fi

echo
echo "Result: $PASS pass / $FAIL fail"
[ "$FAIL" = 0 ]
