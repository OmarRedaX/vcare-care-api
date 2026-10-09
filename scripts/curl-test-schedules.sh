#!/usr/bin/env bash
# Repeatable HTTP QA for the eight schedules routes (working hours, exceptions, consultation types) plus the
# doctors isBookable flip. Use only a disposable *_test database.
#
# Start first (see docs/schedules/manual-qa.md -> Environment):
#   node scripts/schedules-qa-fake-identity.mjs        # synthetic JWKS + in-memory user tokens (FAKE_IDENTITY_PORT, default 3021)
#   ALLOWED_CURRENCIES=EGP,USD npx tsx src/server.ts   # IDENTITY_JWKS_URL pointed at the fake; REDIS_URL on a spare db index
# Required: CARE_OWNER_DATABASE_URL (owner login to the disposable *_test database).
# Optional: CARE_URL (default http://127.0.0.1:3031), FAKE_IDENTITY_URL (default http://127.0.0.1:3021),
#           REDIS_URL (flushed at start so the per-user rate limit windows are clean; a spare db index only),
#           QA_REPORT (file that receives the case table), SERVER_LOG (care-api log file; scanned for free-text leaks).
# Synthetic fixture users: doctors 201,204,206..211, patient 101, admin 1. The script resets their rows first (idempotent).
set -euo pipefail

CARE_URL="${CARE_URL:-http://127.0.0.1:3031}"
FAKE_IDENTITY_URL="${FAKE_IDENTITY_URL:-http://127.0.0.1:3021}"
: "${CARE_OWNER_DATABASE_URL:?Set CARE_OWNER_DATABASE_URL to the disposable *_test owner database}"
[[ "$CARE_OWNER_DATABASE_URL" =~ /[^/?]*_test($|\?) ]] || { echo 'Refusing non-test database' >&2; exit 2; }
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
PASS=0; FAIL=0; CASE=0

uuid() { node -e 'process.stdout.write(require("node:crypto").randomUUID())'; }
sql() { psql "$CARE_OWNER_DATABASE_URL" -XAt -v ON_ERROR_STOP=1 -c "$1" | tr -d '\r'; }
mint() { curl -fsS "$FAKE_IDENTITY_URL/mint?case=$1"; }
# jq-free JSON helpers: js <expression over b = parsed last body> ; prints the value
js() { node -e 'const b=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const r=eval(process.argv[2]);process.stdout.write(String(r))' "$TMP/body" "$1"; }
# date arithmetic in a given IANA zone: ldate <zone> <offsetDays>
ldate() { node -e 'const z=process.argv[1],n=Number(process.argv[2]);const f=new Intl.DateTimeFormat("en-CA",{timeZone:z,year:"numeric",month:"2-digit",day:"2-digit"});const t=f.format(new Date());const d=new Date(t+"T00:00:00Z");d.setUTCDate(d.getUTCDate()+n);process.stdout.write(d.toISOString().slice(0,10))' "$1" "$2"; }
# Next Europe/Berlin UTC-offset change after today: prints "<local date of the change> <spring|autumn>".
dst_date() { node -e 'const nth=Number(process.argv[1]);let seen=0;
const off=(d)=>new Intl.DateTimeFormat("en-US",{timeZone:"Europe/Berlin",timeZoneName:"longOffset"}).formatToParts(d).find(p=>p.type==="timeZoneName").value;
const noon=(i)=>{const t=new Date();t.setUTCHours(12,0,0,0);return new Date(t.getTime()+i*86400000)};
let prev=off(noon(0));
for(let i=1;i<500;i++){const o=off(noon(i));if(o!==prev&&++seen===nth){process.stdout.write(noon(i).toISOString().slice(0,10)+" "+(o>prev?"spring":"autumn"));process.exit(0)}prev=o}process.exit(1)' "$1"; }

call() {
  local method="$1" path="$2" token="$3" body="${4:-}" key="${5:-}" extra="${6:-}" rid
  rid="$(uuid)"; printf '%s' "$rid" > "$TMP/rid"
  local args=(-sS -X "$method" -H "X-Request-Id: $rid" -D "$TMP/headers" -o "$TMP/body" -w '%{http_code}')
  [ -z "$token" ] || args+=(-H "Authorization: Bearer $token")
  [ -z "$body" ] || args+=(-H 'Content-Type: application/json' --data-binary "$body")
  [ -z "$key" ] || args+=(-H "Idempotency-Key: $key")
  [ -z "$extra" ] || args+=(-H "$extra")
  # Keep each doctor under the 30 writes/min limiter except where a case deliberately trips it.
  if [ -n "$token" ] && [ "$method" != GET ] && [ -z "${NO_THROTTLE:-}" ]; then
    local f="$TMP/w_${token: -12}" n=0
    [ ! -f "$f" ] || n="$(cat "$f")"
    n=$((n+1))
    if [ "$n" -ge 27 ]; then sleep 61; n=1; fi
    printf '%s' "$n" > "$f"
  fi
  curl "${args[@]}" "$CARE_URL$path"
}
# Envelope check. kind=error: success=false, error.code, error.requestId, details array. kind=ok: success=true.
# kind=none: 204 empty body. Optional JS assertion over b (parsed body) and h (headers text).
check_body() {
  node - "$TMP/body" "$TMP/headers" "$TMP/rid" "$1" "$2" "${3:-}" <<'NODE'
const fs = require('fs');
const [file, headers, ridFile, kind, code, assertion] = process.argv.slice(2);
const rid = fs.readFileSync(ridFile, 'utf8');
const h = fs.readFileSync(headers, 'utf8');
if (!new RegExp(`^x-request-id: ${rid}\\r?$`, 'im').test(h)) process.exit(1);
const raw = fs.readFileSync(file, 'utf8');
if (kind === 'none') process.exit(raw.length === 0 ? 0 : 1);
let b; try { b = JSON.parse(raw); } catch { process.exit(1); }
if (kind === 'error') {
  if (b.success !== false || b.error?.code !== code || b.error?.requestId !== rid ||
      typeof b.error?.message !== 'string' || !Array.isArray(b.error?.details)) process.exit(1);
} else if (b.success !== true) process.exit(1);
if (assertion && !eval(assertion)) process.exit(1);
NODE
}
record() {
  local method="$1" path="$2" role="$3" scenario="$4" expected="$5" got="$6" ok="$7"
  CASE=$((CASE+1))
  if [ "$ok" = 1 ]; then PASS=$((PASS+1)); result=PASS; else FAIL=$((FAIL+1)); result=FAIL; fi
  printf '%s|%s|%s|%s|%s|%s|%s|%s\n' "$CASE" "$method" "$path" "$role" "$scenario" "$expected" "$got" "$result" | tee -a "${QA_REPORT:-$TMP/report}"
}
# expect METHOD PATH ROLE TOKEN SCENARIO EXPECTED [ASSERT_JS] [BODY] [KEY] [EXTRA_HEADER]
# EXPECTED: "200" (success envelope), "204" (empty body) or "<status> <ErrorCode>" (error envelope).
expect() {
  local method="$1" path="$2" role="$3" token="$4" scenario="$5" expected="$6" assertion="${7:-}" body="${8:-}" key="${9:-}" extra="${10:-}"
  local status ok=1 kind=ok code='' want="${expected%% *}"
  status="$(call "$method" "$path" "$token" "$body" "$key" "$extra")"
  [ "$expected" != "$want" ] && { kind=error; code="${expected#* }"; }
  [ "$want" = 204 ] && kind=none
  [ "$status" = "$want" ] || ok=0
  check_body "$kind" "$code" "$assertion" || ok=0
  local got="$status"
  if [ "$kind" = error ]; then
    got="$status $(node -e 'try{process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1])).error.code)}catch{process.stdout.write("invalid-body")}' "$TMP/body")"
  fi
  record "$method" "$path" "$role" "$scenario" "$expected" "$got" "$ok"
}
# check_value DESCRIPTION EXPECTED ACTUAL  (non-HTTP checks: SQL, header, cross-call equality)
check_value() { record check "$1" "$2" "$3" "$4" "$5" "$([ "$4" = "$5" ] && echo 1 || echo 0)"; }

[ "$(curl -s -o /dev/null -w '%{http_code}' "$CARE_URL/api/health/live")" = 200 ] || { echo 'Care API unavailable' >&2; exit 2; }
[ "$(curl -s -o /dev/null -w '%{http_code}' "$FAKE_IDENTITY_URL/.well-known/jwks.json")" = 200 ] || { echo 'Fake Identity unavailable' >&2; exit 2; }
case "$(sql 'select current_database()')" in *_test) ;; *) echo 'Expected a *_test database' >&2; exit 2;; esac

T0="$(sql 'select now()')"
USERS='201,204,206,207,208,209,210,211'
reset() {
  sql "DELETE FROM consultation_types WHERE doctor_profile_id IN (SELECT id FROM doctor_profiles WHERE user_id IN ($USERS));
       DELETE FROM schedule_exceptions WHERE doctor_profile_id IN (SELECT id FROM doctor_profiles WHERE user_id IN ($USERS));
       DELETE FROM working_hours WHERE doctor_profile_id IN (SELECT id FROM doctor_profiles WHERE user_id IN ($USERS));
       DELETE FROM doctor_specialties WHERE doctor_profile_id IN (SELECT id FROM doctor_profiles WHERE user_id IN ($USERS));
       DELETE FROM doctor_languages WHERE doctor_profile_id IN (SELECT id FROM doctor_profiles WHERE user_id IN ($USERS));
       DELETE FROM doctor_profiles WHERE user_id IN ($USERS);" >/dev/null
}
reset
trap 'reset || true; rm -rf "$TMP"' EXIT
if [ -n "${REDIS_URL:-}" ]; then
  node -e 'const R=require("ioredis");const r=new R(process.env.REDIS_URL);r.flushdb().then(()=>r.quit())' >/dev/null
fi

SPECIALTY="$(sql 'select id from specialties where is_active order by id limit 1')"
DOCTOR="$(mint doctor-201)"; OTHER="$(mint doctor-204)"; NOPROFILE="$(mint doctor-205)"; BERLIN="$(mint doctor-206)"
RATE="$(mint doctor-207)"; CAPDOC="$(mint doctor-208)"; TYPES="$(mint doctor-209)"; EXC="$(mint doctor-210)"; KIRI="$(mint doctor-211)"
PENDING="$(mint doctor-pending)"; REJECTED="$(mint doctor-rejected)"; PATIENT="$(mint patient-101)"; ADMIN="$(mint admin-1)"; EXPIRED="$(mint expired)"
echo 'case|method|path|role|scenario|expected|got|result'

# ---- fixtures: one draft profile per doctor through the real apply route (EGP, timezone per doctor) ----
apply() { # token tz
  local body="{\"headline\":\"QA Synthetic doctor\",\"yearsExperience\":5,\"languages\":[\"en\"],\"specialtyIds\":[$SPECIALTY],\"primarySpecialtyId\":$SPECIALTY,\"consultationFee\":{\"amount\":100,\"currency\":\"EGP\"},\"defaultSlotMinutes\":30,\"timezone\":\"$2\",\"submit\":false}"
  [ "$(call POST /api/doctors/apply "$1" "$body")" = 201 ] || { echo "fixture apply failed for tz $2" >&2; exit 2; }
}
for t in "$DOCTOR" "$OTHER" "$TYPES" "$EXC" "$CAPDOC" "$RATE"; do apply "$t" Africa/Cairo; done
apply "$BERLIN" Europe/Berlin
apply "$KIRI" Pacific/Kiritimati
approve() { sql "UPDATE doctor_profiles SET verification_status='approved', decided_at=now(), identity_sync_status='synced' WHERE user_id=$1" >/dev/null; }

WH=/api/doctors/me/working-hours; EX=/api/doctors/me/exceptions; CT=/api/doctors/me/consultation-types
HOURS_OK='{"days":[{"weekday":1,"intervals":[{"startTime":"09:00","endTime":"12:00"}]}]}'
EXC_OK='{"type":"day_off","date":"2099-01-01"}'
TYPE_OK='{"name":"Synthetic Visit 001","durationMinutes":30,"price":500,"currency":"EGP"}'
TYPE_PATCH='{"price":600}'

# ---- 1. RBAC matrix over all eight routes ----
rbac_row() { # method path body
  local method="$1" path="$2" body="$3"
  expect "$method" "$path" none '' unauthenticated '401 Unauthorized' '' "$body"
  expect "$method" "$path" patient "$PATIENT" wrong-role '403 Forbidden' '' "$body"
  expect "$method" "$path" admin "$ADMIN" wrong-role '403 Forbidden' '' "$body"
  expect "$method" "$path" doctor-pending "$PENDING" token-status-pending '403 Forbidden' '' "$body"
  expect "$method" "$path" doctor-rejected "$REJECTED" token-status-rejected '403 Forbidden' '' "$body"
  expect "$method" "$path" doctor-no-profile "$NOPROFILE" active-doctor-without-profile '404 NotFound' '' "$body"
}
rbac_row GET "$WH" ''
rbac_row PUT "$WH" "$HOURS_OK"
rbac_row GET "$EX" ''
rbac_row POST "$EX" "$EXC_OK"
rbac_row DELETE "$EX/1" ''
rbac_row GET "$CT" ''
rbac_row POST "$CT" "$TYPE_OK"
rbac_row PATCH "$CT/1" "$TYPE_PATCH"
expect GET "$WH" doctor "$EXPIRED" expired-token '401 TokenExpired'
expect GET "$WH" patient "$PATIENT" spoofed-X-User-Id-ignored '403 Forbidden' '' '' '' 'X-User-Id: 201'

# ---- 2. Working hours (doctor 201, Africa/Cairo) ----
expect GET "$WH" doctor "$DOCTOR" empty-set '200' 'b.data.timezone==="Africa/Cairo" && Array.isArray(b.data.days) && b.data.days.length===0'
SPLIT='{"days":[{"weekday":7,"intervals":[{"startTime":"00:00","endTime":"24:00"}]},{"weekday":1,"intervals":[{"startTime":"14:00","endTime":"18:00"},{"startTime":"09:00","endTime":"12:00"}]},{"weekday":2,"intervals":[{"startTime":"09:00","endTime":"12:00"},{"startTime":"12:00","endTime":"17:00"}]}]}'
expect PUT "$WH" doctor "$DOCTOR" split-shift-and-24:00-sorted-output 200 'JSON.stringify(b.data.days.map(d=>d.weekday))==="[1,2,7]" && b.data.days[0].intervals[0].startTime==="09:00" && b.data.days[2].intervals[0].endTime==="24:00" && b.data.days[1].intervals.length===2' "$SPLIT"
cp "$TMP/body" "$TMP/put1"
expect GET "$WH" doctor "$DOCTOR" read-back-equals-put 200 'JSON.stringify(b.data.days.map(d=>d.weekday))==="[1,2,7]" && b.data.days[0].intervals.length===2'
AUDIT_BEFORE="$(sql "select count(*) from audit_logs where action='schedule.hours_replaced' and actor_user_id=201")"
expect PUT "$WH" doctor "$DOCTOR" identical-set-is-noop 200 'b.data.days.length===3' "$SPLIT"
check_value "$WH" doctor 'no-op PUT writes no audit row' "$AUDIT_BEFORE" "$(sql "select count(*) from audit_logs where action='schedule.hours_replaced' and actor_user_id=201")"
KEY1="$(uuid)"
expect PUT "$WH" doctor "$DOCTOR" idempotency-key-ignored-first 200 'b.data.days.length===1' "$HOURS_OK" "$KEY1"
expect PUT "$WH" doctor "$DOCTOR" idempotency-key-ignored-different-body-no-422 200 'b.data.days.length===2' '{"days":[{"weekday":3,"intervals":[{"startTime":"08:00","endTime":"09:00"}]},{"weekday":4,"intervals":[{"startTime":"08:00","endTime":"09:00"}]}]}' "$KEY1"
expect PUT "$WH" doctor "$DOCTOR" touching-intervals-allowed 200 'b.data.days[0].intervals.length===2' '{"days":[{"weekday":5,"intervals":[{"startTime":"09:00","endTime":"12:00"},{"startTime":"12:00","endTime":"14:00"}]}]}'
expect PUT "$WH" doctor "$DOCTOR" confirmConflicts-true-accepted-no-conflicts 200 'b.data.days.length===1' '{"days":[{"weekday":6,"intervals":[{"startTime":"10:00","endTime":"11:00"}]}],"confirmConflicts":true}'
V='400 ValidationFailed'
iv() { printf '{"weekday":%s,"intervals":[%s]}' "$1" "$2"; }
I9='{"startTime":"09:00","endTime":"12:00"}'
expect PUT "$WH" doctor "$DOCTOR" duplicate-weekday "$V" '' "{\"days\":[$(iv 1 "$I9"),$(iv 1 '{"startTime":"13:00","endTime":"14:00"}')]}"
expect PUT "$WH" doctor "$DOCTOR" weekday-8 "$V" '' "{\"days\":[$(iv 8 "$I9")]}"
expect PUT "$WH" doctor "$DOCTOR" weekday-0 "$V" '' "{\"days\":[$(iv 0 "$I9")]}"
expect PUT "$WH" doctor "$DOCTOR" overlapping-intervals "$V" '' "{\"days\":[$(iv 1 "$I9,{\"startTime\":\"11:00\",\"endTime\":\"13:00\"}")]}"
expect PUT "$WH" doctor "$DOCTOR" end-equals-start "$V" '' "{\"days\":[$(iv 1 '{"startTime":"09:00","endTime":"09:00"}')]}"
expect PUT "$WH" doctor "$DOCTOR" end-before-start "$V" '' "{\"days\":[$(iv 1 '{"startTime":"12:00","endTime":"09:00"}')]}"
expect PUT "$WH" doctor "$DOCTOR" 24:00-as-start "$V" '' "{\"days\":[$(iv 1 '{"startTime":"24:00","endTime":"24:00"}')]}"
expect PUT "$WH" doctor "$DOCTOR" bad-time-format "$V" '' "{\"days\":[$(iv 1 '{"startTime":"9:00","endTime":"12:00"}')]}"
expect PUT "$WH" doctor "$DOCTOR" time-25:00 "$V" '' "{\"days\":[$(iv 1 '{"startTime":"09:00","endTime":"25:00"}')]}"
expect PUT "$WH" doctor "$DOCTOR" seven-intervals-one-day "$V" '' "{\"days\":[$(iv 1 '{"startTime":"01:00","endTime":"02:00"},{"startTime":"03:00","endTime":"04:00"},{"startTime":"05:00","endTime":"06:00"},{"startTime":"07:00","endTime":"08:00"},{"startTime":"09:00","endTime":"10:00"},{"startTime":"11:00","endTime":"12:00"},{"startTime":"13:00","endTime":"14:00"}')]}"
expect PUT "$WH" doctor "$DOCTOR" empty-intervals-array "$V" '' '{"days":[{"weekday":1,"intervals":[]}]}'
expect PUT "$WH" doctor "$DOCTOR" eight-day-entries "$V" '' "{\"days\":[$(iv 1 "$I9"),$(iv 2 "$I9"),$(iv 3 "$I9"),$(iv 4 "$I9"),$(iv 5 "$I9"),$(iv 6 "$I9"),$(iv 7 "$I9"),$(iv 7 "$I9")]}"
expect PUT "$WH" doctor "$DOCTOR" unknown-member "$V" '' "{\"days\":[],\"doctorId\":204}"
expect PUT "$WH" doctor "$DOCTOR" days-missing "$V" '' '{}'
expect PUT "$WH" doctor "$DOCTOR" weekday-as-string "$V" '' '{"days":[{"weekday":"1","intervals":[{"startTime":"09:00","endTime":"12:00"}]}]}'
expect PUT "$WH" doctor "$DOCTOR" confirmConflicts-not-boolean "$V" '' '{"days":[],"confirmConflicts":"yes"}'
expect PUT "$WH" doctor "$DOCTOR" days-null "$V" '' '{"days":null}'
expect GET "$WH" doctor "$DOCTOR" unchanged-after-400s 200 'b.data.days.length===1 && b.data.days[0].weekday===6'
expect PUT "$WH" doctor "$DOCTOR" empty-days-clears-all 200 'b.data.days.length===0' '{"days":[]}'

# ---- 3. Schedule exceptions (doctor 210, Africa/Cairo) ----
CAIRO_TODAY="$(ldate Africa/Cairo 0)"; D() { ldate Africa/Cairo "$1"; }
expect GET "$EX" doctor "$EXC" empty-list 200 'Array.isArray(b.data) && b.data.length===0 && b.meta.count===0 && b.meta.hasMore===false'
expect POST "$EX" doctor "$EXC" day-off-single-date 201 'b.data.length===1 && b.data[0].type==="day_off" && b.data[0].startTime===null && b.data[0].endTime===null && b.data[0].reason==="SYNTHETIC-REASON-4417" && typeof b.data[0].id==="number"' "{\"type\":\"day_off\",\"date\":\"$(D 5)\",\"reason\":\"SYNTHETIC-REASON-4417\"}"
ID_DAYOFF="$(js 'b.data[0].id')"
expect POST "$EX" doctor "$EXC" duplicate-date-409 '409 Conflict' 'b.error.details[0].field==="date"' "{\"type\":\"day_off\",\"date\":\"$(D 5)\"}"
expect POST "$EX" doctor "$EXC" day-off-range-3-dates 201 'b.data.length===3 && b.data[0].date<b.data[1].date && b.data[1].date<b.data[2].date' "{\"type\":\"day_off\",\"date\":\"$(D 10)\",\"endDate\":\"$(D 12)\"}"
expect POST "$EX" doctor "$EXC" range-overlapping-existing-409-whole-request '409 Conflict' '' "{\"type\":\"day_off\",\"date\":\"$(D 12)\",\"endDate\":\"$(D 14)\"}"
expect GET "$EX" doctor "$EXC" nothing-created-by-rejected-range 200 "b.data.every(r=>r.date!==\"$(D 13)\" && r.date!==\"$(D 14)\")" ""
expect POST "$EX" doctor "$EXC" custom-hours-one-date 201 'b.data.length===1 && b.data[0].type==="custom_hours" && b.data[0].startTime==="10:00" && b.data[0].endTime==="24:00" && b.data[0].reason===null' "{\"type\":\"custom_hours\",\"date\":\"$(D 20)\",\"startTime\":\"10:00\",\"endTime\":\"24:00\"}"
ID_CUSTOM="$(js 'b.data[0].id')"
expect POST "$EX" doctor "$EXC" custom-hours-with-endDate "$V" '' "{\"type\":\"custom_hours\",\"date\":\"$(D 21)\",\"endDate\":\"$(D 22)\",\"startTime\":\"10:00\",\"endTime\":\"12:00\"}"
expect POST "$EX" doctor "$EXC" custom-hours-missing-times "$V" '' "{\"type\":\"custom_hours\",\"date\":\"$(D 21)\"}"
expect POST "$EX" doctor "$EXC" custom-hours-end-not-after-start "$V" '' "{\"type\":\"custom_hours\",\"date\":\"$(D 21)\",\"startTime\":\"12:00\",\"endTime\":\"12:00\"}"
expect POST "$EX" doctor "$EXC" day-off-with-times "$V" '' "{\"type\":\"day_off\",\"date\":\"$(D 21)\",\"startTime\":\"10:00\",\"endTime\":\"12:00\"}"
expect POST "$EX" doctor "$EXC" endDate-before-date "$V" '' "{\"type\":\"day_off\",\"date\":\"$(D 25)\",\"endDate\":\"$(D 24)\"}"
expect POST "$EX" doctor "$EXC" range-61-dates "$V" '' "{\"type\":\"day_off\",\"date\":\"$(D 30)\",\"endDate\":\"$(D 90)\"}"
expect POST "$EX" doctor "$EXC" range-60-dates-allowed 201 'b.data.length===60' "{\"type\":\"day_off\",\"date\":\"$(D 30)\",\"endDate\":\"$(D 89)\"}"
expect POST "$EX" doctor "$EXC" past-date-3-days-ago "$V" 'b.error.details.some(d=>d.field==="date")' "{\"type\":\"day_off\",\"date\":\"$(D -3)\"}"
expect POST "$EX" doctor "$EXC" yesterday "$V" 'b.error.details.some(d=>d.field==="date")' "{\"type\":\"day_off\",\"date\":\"$(D -1)\"}"
expect POST "$EX" doctor "$EXC" range-starting-in-past "$V" '' "{\"type\":\"day_off\",\"date\":\"$(D -2)\",\"endDate\":\"$(D 1)\"}"
expect POST "$EX" doctor "$EXC" today-allowed 201 'b.data.length===1' "{\"type\":\"day_off\",\"date\":\"$(D 0)\"}"
expect POST "$EX" doctor "$EXC" impossible-calendar-date "$V" '' '{"type":"day_off","date":"2099-02-30"}'
expect POST "$EX" doctor "$EXC" malformed-date "$V" '' '{"type":"day_off","date":"01/02/2099"}'
expect POST "$EX" doctor "$EXC" reason-501-chars "$V" '' "{\"type\":\"day_off\",\"date\":\"$(D 95)\",\"reason\":\"$(printf 'x%.0s' $(seq 1 501))\"}"
expect POST "$EX" doctor "$EXC" reason-null "$V" '' "{\"type\":\"day_off\",\"date\":\"$(D 95)\",\"reason\":null}"
expect POST "$EX" doctor "$EXC" unknown-type "$V" '' "{\"type\":\"holiday\",\"date\":\"$(D 95)\"}"
expect POST "$EX" doctor "$EXC" unknown-member-doctorId "$V" '' "{\"type\":\"day_off\",\"date\":\"$(D 95)\",\"doctorId\":204}"
expect POST "$EX" doctor "$EXC" confirmConflicts-not-boolean "$V" '' "{\"type\":\"day_off\",\"date\":\"$(D 95)\",\"confirmConflicts\":\"true\"}"
expect POST "$EX" doctor "$EXC" confirmConflicts-true-accepted 201 'b.data.length===1' "{\"type\":\"day_off\",\"date\":\"$(D 96)\",\"confirmConflicts\":true}"
IKEY="$(uuid)"; IBODY="{\"type\":\"day_off\",\"date\":\"$(D 100)\",\"reason\":\"SYNTHETIC-REASON-4417\"}"
expect POST "$EX" doctor "$EXC" idempotent-first 201 'b.data.length===1' "$IBODY" "$IKEY"
cp "$TMP/body" "$TMP/ex_first"
expect POST "$EX" doctor "$EXC" idempotent-replay-same-status-and-body 201 'b.data.length===1' "$IBODY" "$IKEY"
check_value "$EX" doctor 'replay body equals original' equal "$([ "$(cat "$TMP/ex_first")" = "$(cat "$TMP/body")" ] && echo equal || echo different)"
expect POST "$EX" doctor "$EXC" idempotent-conflict-different-body '422 IdempotencyConflict' '' "{\"type\":\"day_off\",\"date\":\"$(D 101)\"}" "$IKEY"
expect POST "$EX" doctor "$EXC" idempotency-key-not-uuid "$V" '' "{\"type\":\"day_off\",\"date\":\"$(D 101)\"}" 'not-a-uuid'
expect GET "$EX?fromDate=$(D 100)&toDate=$(D 100)" doctor "$EXC" replay-created-exactly-one-row 200 'b.data.length===1'
# list / pagination
expect GET "$EX?limit=2" doctor "$EXC" page-1-limit-2 200 'b.data.length===2 && b.meta.hasMore===true && typeof b.meta.nextCursor==="string" && b.meta.count===2 && b.data[0].date<b.data[1].date'
CUR="$(js 'b.meta.nextCursor')"; FIRSTDATE="$(js 'b.data[1].date')"
expect GET "$EX?limit=2&cursor=$CUR" doctor "$EXC" page-2-via-cursor 200 "b.data.length===2 && b.data[0].date>\"$FIRSTDATE\""
expect GET "$EX?fromDate=$(D 10)&toDate=$(D 12)" doctor "$EXC" date-window-filter 200 'b.data.length===3 && b.meta.hasMore===false'
expect GET "$EX?fromDate=$(D 12)&toDate=$(D 10)" doctor "$EXC" fromDate-after-toDate "$V"
expect GET "$EX?fromDate=2099-13-40" doctor "$EXC" bad-fromDate "$V"
expect GET "$EX?limit=0" doctor "$EXC" limit-0 "$V"
expect GET "$EX?limit=101" doctor "$EXC" limit-101 "$V"
expect GET "$EX?cursor=not-a-cursor" doctor "$EXC" malformed-cursor "$V"
expect GET "$EX?fromDate=$(D -5)&limit=100" doctor "$EXC" earlier-fromDate-includes-today 200 "b.data.some(r=>r.date===\"$(D 0)\")"
expect GET "$EX" doctor "$OTHER" non-owner-sees-only-own 200 'b.data.length===0'
# delete
expect DELETE "$EX/$ID_DAYOFF" doctor "$OTHER" non-owner-delete-is-404 '404 NotFound'
expect DELETE "$EX/$ID_DAYOFF?confirmConflicts=maybe" doctor "$EXC" confirmConflicts-not-boolean "$V"
expect DELETE "$EX/$ID_DAYOFF" doctor "$EXC" delete-day-off 204
expect DELETE "$EX/$ID_DAYOFF" doctor "$EXC" repeat-delete-already-deleted '404 NotFound'
expect DELETE "$EX/abc" doctor "$EXC" non-numeric-id '404 NotFound'
expect DELETE "$EX/0" doctor "$EXC" id-zero '404 NotFound'
expect DELETE "$EX/99999999" doctor "$EXC" absent-id '404 NotFound'
expect DELETE "$EX/$ID_CUSTOM?confirmConflicts=true" doctor "$EXC" delete-custom-hours-confirm-true 204
expect GET "$EX?fromDate=$(D 5)&toDate=$(D 5)" doctor "$EXC" deleted-row-no-longer-listed 200 'b.data.length===0'
expect POST "$EX" doctor "$EXC" date-reusable-after-soft-delete 201 'b.data.length===1' "{\"type\":\"day_off\",\"date\":\"$(D 5)\"}"
check_value "$EX" doctor 'soft delete keeps the row (deleted_at set)' 1 "$(sql "select count(*) from schedule_exceptions where id=$ID_DAYOFF and deleted_at is not null")"

# ---- 4. DST days (doctor 206, Europe/Berlin) and local-date semantics ----
plus() { node -e 'const d=new Date(process.argv[1]+"T00:00:00Z");d.setUTCDate(d.getUTCDate()+Number(process.argv[2]));process.stdout.write(d.toISOString().slice(0,10))' "$1" "$2"; }
read -r SPRING_DATE _ <<< "$(dst_date 2)"; read -r AUTUMN_DATE _ <<< "$(dst_date 1)"
expect PUT "$WH" doctor "$BERLIN" weekly-hours-split-at-gap-minute 200 'b.data.timezone==="Europe/Berlin" && b.data.days[0].weekday===1 && b.data.days[1].intervals.length===2' '{"days":[{"weekday":7,"intervals":[{"startTime":"00:00","endTime":"02:30"},{"startTime":"02:30","endTime":"24:00"}]},{"weekday":1,"intervals":[{"startTime":"02:00","endTime":"03:00"}]}]}'
expect GET "$WH" doctor "$BERLIN" dst-hours-roundtrip-wall-clock 200 'b.data.days[1].intervals[1].endTime==="24:00" && b.data.days[0].intervals[0].startTime==="02:00"'
expect POST "$EX" doctor "$BERLIN" custom-hours-inside-spring-forward-gap 201 "b.data[0].date===\"$SPRING_DATE\" && b.data[0].startTime===\"02:15\" && b.data[0].endTime===\"03:45\"" "{\"type\":\"custom_hours\",\"date\":\"$SPRING_DATE\",\"startTime\":\"02:15\",\"endTime\":\"03:45\"}"
expect POST "$EX" doctor "$BERLIN" custom-hours-in-autumn-repeated-hour 201 "b.data[0].date===\"$AUTUMN_DATE\" && b.data[0].startTime===\"02:30\"" "{\"type\":\"custom_hours\",\"date\":\"$AUTUMN_DATE\",\"startTime\":\"02:30\",\"endTime\":\"02:45\"}"
expect POST "$EX" doctor "$BERLIN" day-off-range-across-autumn-transition 201 'b.data.length===3' "{\"type\":\"day_off\",\"date\":\"$(plus "$AUTUMN_DATE" 1)\",\"endDate\":\"$(plus "$AUTUMN_DATE" 3)\"}"
expect GET "$EX?fromDate=$AUTUMN_DATE&toDate=$AUTUMN_DATE" doctor "$BERLIN" dst-exception-listed-on-its-local-date 200 "b.data.length===1 && b.data[0].date===\"$AUTUMN_DATE\""
# today is evaluated in the doctor's timezone (Kiritimati is UTC+14: its local date is usually ahead of the UTC date)
expect POST "$EX" doctor "$KIRI" local-today-in-UTC+14-accepted 201 'b.data.length===1' "{\"type\":\"day_off\",\"date\":\"$(ldate Pacific/Kiritimati 0)\"}"
expect POST "$EX" doctor "$KIRI" local-yesterday-in-UTC+14-rejected "$V" 'b.error.details.some(d=>d.field==="date")' "{\"type\":\"day_off\",\"date\":\"$(ldate Pacific/Kiritimati -1)\"}"

# ---- 5. Consultation types (doctor 209, EGP profile) ----
expect GET "$CT" doctor "$TYPES" empty-list 200 'b.data.length===0 && b.meta.count===0'
expect GET /api/doctors/me doctor "$TYPES" isBookable-false-before-any-type 200 'b.data.isBookable===false'
expect POST "$CT" doctor "$TYPES" create-type 201 'typeof b.data.id==="number" && b.data.isActive===true && b.data.currency==="EGP" && b.data.durationMinutes===30 && b.data.price===500 && !("deletedAt" in b.data) && !("doctorProfileId" in b.data)' "$TYPE_OK"
TID="$(js 'b.data.id')"
expect POST "$CT" doctor "$TYPES" duplicate-name-409 '409 Conflict' 'b.error.details[0].field==="name"' "$TYPE_OK"
expect POST "$CT" doctor "$TYPES" price-zero-allowed 201 'b.data.price===0' '{"name":"Free Synthetic Check","durationMinutes":5,"price":0,"currency":"EGP"}'
expect POST "$CT" doctor "$TYPES" price-max-and-duration-240-allowed 201 'b.data.price===2147483647 && b.data.durationMinutes===240' '{"name":"Max Synthetic Visit","durationMinutes":240,"price":2147483647,"currency":"EGP"}'
expect POST "$CT" doctor "$TYPES" name-1-char "$V" '' '{"name":"A","durationMinutes":30,"price":1,"currency":"EGP"}'
expect POST "$CT" doctor "$TYPES" name-whitespace-only "$V" '' '{"name":"     ","durationMinutes":30,"price":1,"currency":"EGP"}'
expect POST "$CT" doctor "$TYPES" name-101-chars "$V" '' "{\"name\":\"$(printf 'n%.0s' $(seq 1 101))\",\"durationMinutes\":30,\"price\":1,\"currency\":\"EGP\"}"
expect POST "$CT" doctor "$TYPES" name-control-character "$V" '' '{"name":"Bad\u0007Name","durationMinutes":30,"price":1,"currency":"EGP"}'
expect POST "$CT" doctor "$TYPES" duration-4 "$V" '' '{"name":"Synthetic Short","durationMinutes":4,"price":1,"currency":"EGP"}'
expect POST "$CT" doctor "$TYPES" duration-241 "$V" '' '{"name":"Synthetic Long","durationMinutes":241,"price":1,"currency":"EGP"}'
expect POST "$CT" doctor "$TYPES" duration-fractional "$V" '' '{"name":"Synthetic Frac","durationMinutes":30.5,"price":1,"currency":"EGP"}'
expect POST "$CT" doctor "$TYPES" duration-string "$V" '' '{"name":"Synthetic Str","durationMinutes":"30","price":1,"currency":"EGP"}'
expect POST "$CT" doctor "$TYPES" price-negative "$V" '' '{"name":"Synthetic Neg","durationMinutes":30,"price":-1,"currency":"EGP"}'
expect POST "$CT" doctor "$TYPES" price-over-int32 "$V" '' '{"name":"Synthetic Big","durationMinutes":30,"price":2147483648,"currency":"EGP"}'
expect POST "$CT" doctor "$TYPES" currency-allowed-but-not-profile-currency-USD "$V" 'b.error.details.some(d=>d.field==="currency")' '{"name":"Synthetic Usd","durationMinutes":30,"price":1,"currency":"USD"}'
expect POST "$CT" doctor "$TYPES" currency-not-allowed-GBP "$V" 'b.error.details.some(d=>d.field==="currency")' '{"name":"Synthetic Gbp","durationMinutes":30,"price":1,"currency":"GBP"}'
expect POST "$CT" doctor "$TYPES" currency-lowercase "$V" '' '{"name":"Synthetic Low","durationMinutes":30,"price":1,"currency":"egp"}'
expect POST "$CT" doctor "$TYPES" currency-missing "$V" '' '{"name":"Synthetic Nocur","durationMinutes":30,"price":1}'
expect POST "$CT" doctor "$TYPES" unknown-member-isActive "$V" '' '{"name":"Synthetic Unk","durationMinutes":30,"price":1,"currency":"EGP","isActive":false}'
TKEY="$(uuid)"; TBODY='{"name":"Idempotent Synthetic","durationMinutes":20,"price":50,"currency":"EGP"}'
expect POST "$CT" doctor "$TYPES" idempotent-first 201 'b.data.name==="Idempotent Synthetic"' "$TBODY" "$TKEY"
cp "$TMP/body" "$TMP/t_first"
expect POST "$CT" doctor "$TYPES" idempotent-replay 201 'b.data.name==="Idempotent Synthetic"' "$TBODY" "$TKEY"
check_value "$CT" doctor 'replay body equals original' equal "$([ "$(cat "$TMP/t_first")" = "$(cat "$TMP/body")" ] && echo equal || echo different)"
expect POST "$CT" doctor "$TYPES" idempotent-conflict-different-body '422 IdempotencyConflict' '' '{"name":"Idempotent Synthetic Two","durationMinutes":20,"price":50,"currency":"EGP"}' "$TKEY"
expect GET "$CT" doctor "$TYPES" list-has-exactly-one-idempotent-row 200 'b.data.filter(t=>t.name==="Idempotent Synthetic").length===1 && b.data.length===4 && b.data[0].id<b.data[1].id'
expect GET "$CT?limit=2" doctor "$TYPES" page-1-limit-2 200 'b.data.length===2 && b.meta.hasMore===true && typeof b.meta.nextCursor==="string"'
CUR="$(js 'b.meta.nextCursor')"; LASTID="$(js 'b.data[1].id')"
expect GET "$CT?limit=2&cursor=$CUR" doctor "$TYPES" page-2-via-cursor 200 "b.data.length===2 && b.data[0].id>$LASTID && b.meta.hasMore===false"
expect GET "$CT?limit=0" doctor "$TYPES" limit-0 "$V"
expect GET "$CT?limit=101" doctor "$TYPES" limit-101 "$V"
expect GET "$CT?cursor=garbage" doctor "$TYPES" malformed-cursor "$V"
expect GET "$CT?isActive=maybe" doctor "$TYPES" isActive-not-boolean "$V"
# PATCH
expect PATCH "$CT/$TID" doctor "$TYPES" change-price 200 'b.data.price===600 && b.data.id>0' "$TYPE_PATCH"
expect PATCH "$CT/$TID" doctor "$TYPES" rename-and-duration 200 'b.data.name==="Synthetic Visit Renamed" && b.data.durationMinutes===45' '{"name":"Synthetic Visit Renamed","durationMinutes":45}'
expect PATCH "$CT/$TID" doctor "$TYPES" noop-same-values 200 'b.data.price===600' '{"price":600}'
expect PATCH "$CT/$TID" doctor "$TYPES" currency-same-as-profile 200 'b.data.currency==="EGP"' '{"currency":"EGP"}'
expect PATCH "$CT/$TID" doctor "$TYPES" currency-USD-mismatch "$V" 'b.error.details.some(d=>d.field==="currency")' '{"currency":"USD"}'
expect PATCH "$CT/$TID" doctor "$TYPES" empty-body "$V" 'b.error.details.some(d=>d.field==="body")' '{}'
expect PATCH "$CT/$TID" doctor "$TYPES" null-member "$V" '' '{"price":null}'
expect PATCH "$CT/$TID" doctor "$TYPES" isActive-as-string "$V" '' '{"isActive":"false"}'
expect PATCH "$CT/$TID" doctor "$TYPES" unknown-member "$V" '' '{"doctorProfileId":1}'
expect PATCH "$CT/$TID" doctor "$TYPES" duplicate-name-409 '409 Conflict' 'b.error.details[0].field==="name"' '{"name":"Free Synthetic Check"}'
expect PATCH "$CT/$TID" doctor "$OTHER" non-owner-patch '404 NotFound' '' '{"price":1}'
expect PATCH "$CT/99999999" doctor "$TYPES" absent-id '404 NotFound' '' '{"price":1}'
expect PATCH "$CT/abc" doctor "$TYPES" non-numeric-id '404 NotFound' '' '{"price":1}'
expect GET "$CT" doctor "$OTHER" non-owner-list-excludes-foreign-types 200 'b.data.length===0'
# isBookable follows the active live types (profile approved + synced by owner SQL)
approve 209
expect GET /api/doctors/me doctor "$TYPES" isBookable-true-with-active-type 200 'b.data.isBookable===true'
for id in $(sql "select id from consultation_types where doctor_profile_id=(select id from doctor_profiles where user_id=209) order by id"); do
  call PATCH "$CT/$id" "$TYPES" '{"isActive":false}' >/dev/null
done
expect GET /api/doctors/me doctor "$TYPES" isBookable-false-after-deactivating-last-active-type 200 'b.data.isBookable===false'
expect GET "$CT?isActive=false" doctor "$TYPES" filter-inactive 200 'b.data.length===4 && b.data.every(t=>t.isActive===false)'
expect GET "$CT?isActive=true" doctor "$TYPES" filter-active-empty 200 'b.data.length===0'
expect PATCH "$CT/$TID" doctor "$TYPES" reactivate 200 'b.data.isActive===true' '{"isActive":true}'
expect GET /api/doctors/me doctor "$TYPES" isBookable-true-after-reactivation 200 'b.data.isBookable===true'

# ---- 6. 20-type cap (doctor 208) ----
for i in $(seq -w 1 20); do
  s="$(call POST "$CT" "$CAPDOC" "{\"name\":\"Synthetic Cap $i\",\"durationMinutes\":15,\"price\":10,\"currency\":\"EGP\"}")"
  [ "$s" = 201 ] || record POST "$CT" doctor "create type $i of 20" 201 "$s" 0
done
check_value "$CT" doctor 'twenty live types created' 20 "$(sql "select count(*) from consultation_types where deleted_at is null and doctor_profile_id=(select id from doctor_profiles where user_id=208)")"
expect POST "$CT" doctor "$CAPDOC" 21st-type-409 '409 Conflict' 'b.error.details[0].field==="consultationTypes"' '{"name":"Synthetic Cap 21","durationMinutes":15,"price":10,"currency":"EGP"}'
FIRST_CAP="$(sql "select min(id) from consultation_types where doctor_profile_id=(select id from doctor_profiles where user_id=208)")"
expect PATCH "$CT/$FIRST_CAP" doctor "$CAPDOC" deactivate-one-of-20 200 'b.data.isActive===false' '{"isActive":false}'
expect POST "$CT" doctor "$CAPDOC" 21st-still-409-inactive-types-count '409 Conflict' 'b.error.details[0].field==="consultationTypes"' '{"name":"Synthetic Cap 21","durationMinutes":15,"price":10,"currency":"EGP"}'
expect GET "$CT?limit=10" doctor "$CAPDOC" cap-doctor-page-1 200 'b.data.length===10 && b.meta.hasMore===true'
CUR="$(js 'b.meta.nextCursor')"
expect GET "$CT?limit=10&cursor=$CUR" doctor "$CAPDOC" cap-doctor-page-2-last 200 'b.data.length===10 && b.meta.hasMore===false && b.meta.nextCursor===null'

# ---- 7. Audit, privacy ----
check_value audit-logs owner 'hours_replaced audit rows exist for doctor 201' 1 "$([ "$(sql "select count(*) from audit_logs where action='schedule.hours_replaced' and actor_user_id=201")" -ge 1 ] && echo 1 || echo 0)"
check_value audit-logs owner 'one consultation_type.created audit row per created type (doctor 208)' 20 "$(sql "select count(*) from audit_logs where action='consultation_type.created' and actor_user_id=208 and created_at >= '$T0'")"
check_value audit-logs owner 'free text never in audit metadata' 0 "$(sql "select count(*) from audit_logs where actor_user_id in ($USERS) and created_at >= '$T0' and (metadata::text like '%SYNTHETIC-REASON-4417%' or metadata::text like '%Synthetic Visit%' or metadata::text like '%Synthetic Cap%')")"
if [ -n "${SERVER_LOG:-}" ] && [ -f "$SERVER_LOG" ]; then
  check_value server-log observer 'free text never in the care-api log' 0 "$(grep -c 'SYNTHETIC-REASON-4417\|Synthetic Visit\|Synthetic Cap' "$SERVER_LOG" || true)"
fi

# ---- 7b. Concurrent PUTs of one doctor serialize on the profile lock (S-R1) ----
SET_A='{"days":[{"weekday":1,"intervals":[{"startTime":"08:00","endTime":"09:00"}]},{"weekday":2,"intervals":[{"startTime":"08:00","endTime":"09:00"}]}]}'
SET_B='{"days":[{"weekday":3,"intervals":[{"startTime":"10:00","endTime":"11:00"}]},{"weekday":4,"intervals":[{"startTime":"10:00","endTime":"11:00"}]},{"weekday":5,"intervals":[{"startTime":"10:00","endTime":"11:00"}]}]}'
curl -sS -o /dev/null -w '%{http_code}' -X PUT -H "Authorization: Bearer $DOCTOR" -H 'Content-Type: application/json' --data-binary "$SET_A" "$CARE_URL$WH" > "$TMP/conc_a" &
curl -sS -o /dev/null -w '%{http_code}' -X PUT -H "Authorization: Bearer $DOCTOR" -H 'Content-Type: application/json' --data-binary "$SET_B" "$CARE_URL$WH" > "$TMP/conc_b" &
wait
check_value "$WH" doctor 'two concurrent PUTs both answer 200' '200 200' "$(cat "$TMP/conc_a") $(cat "$TMP/conc_b")"
check_value "$WH" doctor 'live set is exactly one request set (2 or 3 weekdays, no mix)' 1 "$([ "$(sql "select count(*) from working_hours where deleted_at is null and doctor_profile_id=(select id from doctor_profiles where user_id=201)")" = 2 ] || [ "$(sql "select count(*) from working_hours where deleted_at is null and doctor_profile_id=(select id from doctor_profiles where user_id=201)")" = 3 ] && echo 1 || echo 0)"

# ---- 8. Local suspension blocks all eight routes (doctor 204) ----
sql "UPDATE doctor_profiles SET suspended_at=now(), suspension_reason='QA synthetic suspension' WHERE user_id=204" >/dev/null
for route in "GET $WH" "PUT $WH" "GET $EX" "POST $EX" "DELETE $EX/1" "GET $CT" "POST $CT" "PATCH $CT/1"; do
  m="${route%% *}"; p="${route#* }"; b=''
  case "$route" in "PUT $WH") b="$HOURS_OK";; "POST $EX") b="$EXC_OK";; "POST $CT") b="$TYPE_OK";; "PATCH $CT/1") b="$TYPE_PATCH";; esac
  expect "$m" "$p" doctor "$OTHER" locally-suspended '403 Forbidden' '' "$b"
done
sql 'UPDATE doctor_profiles SET suspended_at=NULL, suspension_reason=NULL WHERE user_id=204' >/dev/null
expect GET "$WH" doctor "$OTHER" reinstated-readable-again 200

# ---- 9. Rate limits (doctor 207): reads 120/min, writes 30/min, per user ----
NO_THROTTLE=1
ok=1; for i in $(seq 1 120); do s="$(call GET "$WH" "$RATE")"; [ "$s" = 200 ] || ok=0; done
check_value "$WH" doctor 'first 120 reads in the window all 200' 1 "$ok"
expect GET "$WH" doctor "$RATE" read-121st-limited '429 RateLimited'
check_value "$WH" doctor 'Retry-After present on 429' 1 "$(grep -qi '^retry-after: [0-9]' "$TMP/headers" && echo 1 || echo 0)"
ok=1; for i in $(seq 1 30); do s="$(call PUT "$WH" "$RATE" '{"days":[]}')"; [ "$s" = 200 ] || ok=0; done
check_value "$WH" doctor 'first 30 writes in the window all 200' 1 "$ok"
expect PUT "$WH" doctor "$RATE" write-31st-limited '429 RateLimited' '' '{"days":[]}'
check_value "$WH" doctor 'Retry-After present on 429' 1 "$(grep -qi '^retry-after: [0-9]' "$TMP/headers" && echo 1 || echo 0)"
expect POST "$EX" doctor "$RATE" write-limit-covers-exceptions '429 RateLimited' '' "$EXC_OK"
expect POST "$CT" doctor "$RATE" write-limit-covers-types '429 RateLimited' '' "$TYPE_OK"
NO_THROTTLE=

echo "RESULT $PASS pass / $FAIL fail ($CASE cases)"
[ "$FAIL" = 0 ]
