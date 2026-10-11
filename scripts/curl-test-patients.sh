#!/usr/bin/env bash
# Repeatable HTTP QA for GET/PATCH /api/patients/me. Use only a disposable *_test database.
#
# Start first (see docs/patients/manual-qa.md -> Environment):
#   node scripts/patients-qa-fake-identity.mjs   # synthetic JWKS + in-memory user tokens (FAKE_IDENTITY_PORT, default 3022)
#   npx tsx src/server.ts                        # IDENTITY_JWKS_URL pointed at the fake; REDIS_URL on a spare db index; PORT=3041
# Required: CARE_OWNER_DATABASE_URL (owner login to the disposable *_test database).
# Optional: CARE_URL (default http://127.0.0.1:3041), FAKE_IDENTITY_URL (default http://127.0.0.1:3022),
#           REDIS_URL (flushed at start so per-user rate-limit windows are clean; a spare db index only),
#           QA_REPORT (file that receives the case table), SERVER_LOG (care-api log file; scanned for clinical-text leaks).
# Synthetic fixture users: patients 301-311 and 391-394, doctors 201-203, admin 1. Their patient_profiles rows are reset first.
set -euo pipefail

CARE_URL="${CARE_URL:-http://127.0.0.1:3041}"
FAKE_IDENTITY_URL="${FAKE_IDENTITY_URL:-http://127.0.0.1:3022}"
: "${CARE_OWNER_DATABASE_URL:?Set CARE_OWNER_DATABASE_URL to the disposable *_test owner database}"
[[ "$CARE_OWNER_DATABASE_URL" =~ /[^/?]*_test($|\?) ]] || { echo 'Refusing non-test database' >&2; exit 2; }
TMP="$(mktemp -d)"
PASS=0; FAIL=0; CASE=0

uuid() { node -e 'process.stdout.write(require("node:crypto").randomUUID())'; }
sql() { psql "$CARE_OWNER_DATABASE_URL" -XAt -v ON_ERROR_STOP=1 -c "$1" | tr -d '\r'; }
mint() { curl -fsS "$FAKE_IDENTITY_URL/mint?case=$1"; }
# date in a given IANA zone: ldate <zone> <offsetDays>
ldate() { node -e 'const z=process.argv[1],n=Number(process.argv[2]);const f=new Intl.DateTimeFormat("en-CA",{timeZone:z,year:"numeric",month:"2-digit",day:"2-digit"});const d=new Date(f.format(new Date())+"T00:00:00Z");d.setUTCDate(d.getUTCDate()+n);process.stdout.write(d.toISOString().slice(0,10))' "$1" "$2"; }

# Keep each patient under the 20 writes/min limiter except where a case deliberately trips it.
call() {
  local method="$1" path="$2" token="$3" body="${4:-}" key="${5:-}" extra="${6:-}" rid
  rid="$(uuid)"; printf '%s' "$rid" > "$TMP/rid"
  local args=(-sS -X "$method" -H "X-Request-Id: $rid" -D "$TMP/headers" -o "$TMP/body" -w '%{http_code}')
  [ -z "$token" ] || args+=(-H "Authorization: Bearer $token")
  [ -z "$body" ] || args+=(-H 'Content-Type: application/json' --data-binary "$body")
  [ -z "$key" ] || args+=(-H "Idempotency-Key: $key")
  [ -z "$extra" ] || args+=(-H "$extra")
  if [ -n "$token" ] && [ "$method" != GET ] && [ -z "${NO_THROTTLE:-}" ]; then
    local f="$TMP/w_${token: -12}" n=0
    [ ! -f "$f" ] || n="$(cat "$f")"
    n=$((n+1))
    if [ "$n" -ge 18 ]; then sleep 61; n=1; fi
    printf '%s' "$n" > "$f"
  fi
  curl "${args[@]}" "$CARE_URL$path"
}
# Envelope check: X-Request-Id echoed, Cache-Control: no-store, envelope per kind, optional JS assertion over b (body) and h (headers).
check_body() {
  node - "$TMP/body" "$TMP/headers" "$TMP/rid" "$1" "$2" "${3:-}" <<'NODE'
const fs = require('fs');
const [file, headers, ridFile, kind, code, assertion] = process.argv.slice(2);
const rid = fs.readFileSync(ridFile, 'utf8');
const h = fs.readFileSync(headers, 'utf8');
if (!new RegExp(`^x-request-id: ${rid}\\r?$`, 'im').test(h)) process.exit(1);
if (!/^cache-control: .*no-store/im.test(h)) process.exit(1);
const raw = fs.readFileSync(file, 'utf8');
let b; try { b = JSON.parse(raw); } catch { process.exit(1); }
if (kind === 'error') {
  if (b.success !== false || b.error?.code !== code || b.error?.requestId !== rid ||
      typeof b.error?.message !== 'string' || !Array.isArray(b.error?.details)) process.exit(1);
} else if (b.success !== true) process.exit(1);
if (assertion && !eval(assertion)) process.exit(1);
NODE
}
record() {
  local method="$1" path="$2" role="$3" scenario="$4" expected="$5" got="$6" ok="$7" result
  CASE=$((CASE+1))
  if [ "$ok" = 1 ]; then PASS=$((PASS+1)); result=PASS; else FAIL=$((FAIL+1)); result=FAIL; fi
  printf '%s|%s|%s|%s|%s|%s|%s|%s\n' "$CASE" "$method" "$path" "$role" "$scenario" "$expected" "$got" "$result" | tee -a "${QA_REPORT:-$TMP/report}"
}
# expect METHOD PATH ROLE TOKEN SCENARIO EXPECTED [ASSERT_JS] [BODY] [KEY] [EXTRA_HEADER]
# EXPECTED: "200" (success envelope) or "<status> <ErrorCode>" (error envelope).
expect() {
  local method="$1" path="$2" role="$3" token="$4" scenario="$5" expected="$6" assertion="${7:-}" body="${8:-}" key="${9:-}" extra="${10:-}"
  local status ok=1 kind=ok code='' want="${expected%% *}"
  status="$(call "$method" "$path" "$token" "$body" "$key" "$extra")"
  [ "$expected" != "$want" ] && { kind=error; code="${expected#* }"; }
  [ "$status" = "$want" ] || ok=0
  check_body "$kind" "$code" "$assertion" || ok=0
  local got="$status"
  if [ "$kind" = error ]; then
    got="$status $(node -e 'try{process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1])).error.code)}catch{process.stdout.write("invalid-body")}' "$TMP/body")"
  fi
  record "$method" "$path" "$role" "$scenario" "$expected" "$got" "$ok"
}
# check_value SCOPE DESCRIPTION EXPECTED ACTUAL  (non-HTTP checks: SQL, log scan, cross-call equality)
check_value() { record check "$1" owner "$2" "$3" "$4" "$([ "$3" = "$4" ] && echo 1 || echo 0)"; }
# body_has: 1 when the last response body contains the literal string, else 0
body_has() { grep -qF -- "$1" "$TMP/body" && echo 1 || echo 0; }
audit_count() { # action user [entity_id]
  sql "SELECT count(*) FROM audit_logs WHERE created_at >= '$T0' AND action='$1' AND actor_user_id=$2 ${3:+AND entity_id=$3}"
}

[ "$(curl -s -o /dev/null -w '%{http_code}' "$CARE_URL/api/health/live")" = 200 ] || { echo 'Care API unavailable' >&2; exit 2; }
[ "$(curl -s -o /dev/null -w '%{http_code}' "$FAKE_IDENTITY_URL/.well-known/jwks.json")" = 200 ] || { echo 'Fake Identity unavailable' >&2; exit 2; }
case "$(sql 'select current_database()')" in *_test) ;; *) echo 'Expected a *_test database' >&2; exit 2;; esac

T0="$(sql 'select now()')"
USERS='301,302,303,304,305,306,307,308,309,310,311,391,392,393,394'
reset() { sql "DELETE FROM patient_profiles WHERE user_id IN ($USERS)" >/dev/null; }
reset
trap 'reset || true; rm -rf "$TMP"' EXIT
if [ -n "${REDIS_URL:-}" ]; then
  node -e 'const R=require("ioredis");const r=new R(process.env.REDIS_URL);r.flushdb().then(()=>r.quit())' >/dev/null
fi

P1="$(mint patient-301)"; P2="$(mint patient-302)"; P3="$(mint patient-303)"; P4="$(mint patient-304)"; P5="$(mint patient-305)"
P6="$(mint patient-306)"; P7="$(mint patient-307)"; P8="$(mint patient-308)"; P9="$(mint patient-309)"; P10="$(mint patient-310)"; P11="$(mint patient-311)"
PPEND="$(mint patient-pending)"; PREJ="$(mint patient-rejected)"; PSUSP="$(mint patient-suspended)"; PUNV="$(mint patient-unverified)"
DOC="$(mint doctor-201)"; DPEND="$(mint doctor-pending)"; DREJ="$(mint doctor-rejected)"; ADMIN="$(mint admin-1)"
EXPIRED="$(mint expired)"; SVC="$(curl -fsS "$FAKE_IDENTITY_URL/mint?case=patient-301&typ=service")"
echo 'case|method|path|role|scenario|expected|got|result'

ME=/api/patients/me
KEYS='Object.keys(b.data).sort().join()==="allergies,bloodType,chronicConditions,createdAt,dateOfBirth,gender,id,timezone,updatedAt,userId"'
SYN1='TEST-ALLERGEN-A'; SYN2='TEST-CONDITION-B'; SYN3='TEST-ALLERGEN-C'

# ---- 1. RBAC / authentication matrix over both routes ----
for m in GET PATCH; do
  body=''; [ "$m" = PATCH ] && body="{\"timezone\":\"Africa/Cairo\",\"allergies\":[\"$SYN1\"]}"
  expect $m $ME none '' unauthenticated '401 Unauthorized' '' "$body"
  expect $m $ME patient "garbage.token.value" malformed-token '401 Unauthorized' '' "$body"
  expect $m $ME patient "$EXPIRED" expired-token '401 TokenExpired' '' "$body"
  expect $m $ME service "$SVC" token-typ-service-not-a-user-token '401 Unauthorized' '' "$body"
  expect $m $ME doctor "$DOC" wrong-role '403 Forbidden' '' "$body"
  expect $m $ME doctor-pending "$DPEND" wrong-role-pending '403 Forbidden' '' "$body"
  expect $m $ME doctor-rejected "$DREJ" wrong-role-rejected '403 Forbidden' '' "$body"
  expect $m $ME admin "$ADMIN" wrong-role-admin-denied '403 Forbidden' '!JSON.stringify(b).includes("'"$SYN1"'")' "$body"
  expect $m $ME patient-pending "$PPEND" token-status-pending '403 Forbidden' '' "$body"
  expect $m $ME patient-rejected "$PREJ" token-status-rejected '403 Forbidden' '' "$body"
  expect $m $ME patient-suspended "$PSUSP" token-status-suspended '403 Forbidden' '' "$body"
done
expect GET $ME admin "$ADMIN" spoofed-X-User-Id-X-Role-patient-ignored '403 Forbidden' '' '' '' 'X-User-Id: 301'
expect PATCH $ME admin "$ADMIN" spoofed-X-Role-patient-ignored '403 Forbidden' '' '{"timezone":"Africa/Cairo"}' '' 'X-Role: patient'
check_value rbac 'no profile row created by any denied call' 0 "$(sql "SELECT count(*) FROM patient_profiles WHERE user_id IN (1,201,202,203,391,392,393)")"
check_value audit 'denied/unauthenticated calls wrote no patient_profile audit row' 0 "$(sql "SELECT count(*) FROM audit_logs WHERE created_at >= '$T0' AND action LIKE 'patient_profile.%'")"

# ---- 2. profile flow for patient 301 ----
expect GET $ME patient "$P1" no-profile-yet '404 NotFound'
check_value audit '404 GET writes no audit row' 0 "$(audit_count patient_profile.read 301)"
expect PATCH $ME patient "$P1" create-without-timezone '400 ValidationFailed' 'b.error.details.some(d=>d.field==="timezone")&&!JSON.stringify(b).includes("'"$SYN1"'")' "{\"allergies\":[\"$SYN1\"]}"
check_value db 'rejected create writes no row' 0 "$(sql "SELECT count(*) FROM patient_profiles WHERE user_id=301")"
expect PATCH $ME patient "$P1" empty-object-body '400 ValidationFailed' 'b.error.details.some(d=>d.field==="body")' '{}'
expect PATCH $ME patient "$P1" no-body-at-all '400 ValidationFailed'
expect PATCH $ME patient "$P1" create-with-timezone-only '200' "$KEYS&&b.data.userId===301&&b.data.timezone==='Africa/Cairo'&&b.data.allergies.length===0&&b.data.chronicConditions.length===0&&b.data.dateOfBirth===null&&b.data.gender===null&&b.data.bloodType===null" '{"timezone":"Africa/Cairo"}'
ID1="$(sql "SELECT id FROM patient_profiles WHERE user_id=301 AND deleted_at IS NULL")"
CREATED_AT="$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1])).data.createdAt)' "$TMP/body")"
check_value audit 'create writes one patient_profile.updated audit row (created=true)' 1 "$(sql "SELECT count(*) FROM audit_logs WHERE created_at >= '$T0' AND action='patient_profile.updated' AND actor_user_id=301 AND actor_role='patient' AND entity_type='patient_profile' AND entity_id=$ID1 AND metadata->>'created'='true' AND metadata->>'changedFields'='timezone'")"
check_value audit 'audit request_id equals the sent X-Request-Id' 1 "$(sql "SELECT count(*) FROM audit_logs WHERE created_at >= '$T0' AND action='patient_profile.updated' AND entity_id=$ID1 AND request_id='$(cat "$TMP/rid")'")"
expect GET $ME patient "$P1" read-back '200' "$KEYS&&b.data.id===$ID1&&b.data.timezone==='Africa/Cairo'&&/^\\d{4}-\\d\\d-\\d\\dT[\\d:.]+Z\$/.test(b.data.createdAt)"
check_value audit 'GET 200 writes one patient_profile.read row (metadata patientUserId only)' 1 "$(sql "SELECT count(*) FROM audit_logs WHERE created_at >= '$T0' AND action='patient_profile.read' AND actor_user_id=301 AND actor_role='patient' AND entity_id=$ID1 AND request_id='$(cat "$TMP/rid")' AND metadata::text='{\"patientUserId\": 301}'")"
expect PATCH $ME patient "$P1" partial-update-keeps-untouched '200' "b.data.gender==='female'&&b.data.bloodType==='O+'&&b.data.timezone==='Africa/Cairo'&&b.data.dateOfBirth===null" '{"gender":"female","bloodType":"O+"}'
expect PATCH $ME patient "$P1" set-arrays-and-dob '200' "b.data.dateOfBirth==='1990-05-17'&&JSON.stringify(b.data.allergies)==='[\"$SYN1\",\"$SYN3\"]'&&JSON.stringify(b.data.chronicConditions)==='[\"$SYN2\"]'" "{\"dateOfBirth\":\"1990-05-17\",\"allergies\":[\"$SYN1\",\"$SYN3\"],\"chronicConditions\":[\"$SYN2\"]}"
expect PATCH $ME patient "$P1" arrays-replaced-whole '200' "JSON.stringify(b.data.allergies)==='[\"$SYN3\"]'&&JSON.stringify(b.data.chronicConditions)==='[\"$SYN2\"]'" "{\"allergies\":[\"$SYN3\"]}"
expect PATCH $ME patient "$P1" empty-array-clears '200' 'b.data.allergies.length===0' '{"allergies":[]}'
expect PATCH $ME patient "$P1" null-clears-scalars '200' 'b.data.gender===null&&b.data.bloodType===null&&b.data.dateOfBirth===null' '{"gender":null,"bloodType":null,"dateOfBirth":null}'
expect PATCH $ME patient "$P1" set-two-ordered-items '200' '' "{\"allergies\":[\"$SYN1\",\"$SYN3\"]}"
UPD_BEFORE="$(sql "SELECT updated_at FROM patient_profiles WHERE id=$ID1")"
AUD_BEFORE="$(sql "SELECT count(*) FROM audit_logs WHERE created_at >= '$T0' AND action='patient_profile.updated' AND entity_id=$ID1")"
expect PATCH $ME patient "$P1" noop-same-values-200 '200' "b.data.createdAt==='$CREATED_AT'" "{\"allergies\":[\"$SYN1\",\"$SYN3\"],\"timezone\":\"africa/cairo\"}"
check_value db 'no-op PATCH leaves updated_at unchanged' "$UPD_BEFORE" "$(sql "SELECT updated_at FROM patient_profiles WHERE id=$ID1")"
check_value audit 'no-op PATCH writes no audit row' "$AUD_BEFORE" "$(sql "SELECT count(*) FROM audit_logs WHERE created_at >= '$T0' AND action='patient_profile.updated' AND entity_id=$ID1")"
expect PATCH $ME patient "$P1" reordered-array-is-a-change '200' "JSON.stringify(b.data.allergies)==='[\"$SYN3\",\"$SYN1\"]'" "{\"allergies\":[\"$SYN3\",\"$SYN1\"]}"
check_value audit 'real change audited with changedFields=allergies' 1 "$(sql "SELECT count(*) FROM audit_logs WHERE created_at >= '$T0' AND action='patient_profile.updated' AND entity_id=$ID1 AND request_id='$(cat "$TMP/rid")' AND metadata->>'created'='false' AND metadata->>'changedFields'='allergies'")"
expect PATCH $ME patient "$P1" idempotency-key-ignored-first '200' '' '{"gender":"male"}' "$(uuid)"
KEY="$(uuid)"
expect PATCH $ME patient "$P1" idempotency-key-ignored-diff-body-no-422 '200' 'b.data.gender==="other"' '{"gender":"other"}' "$KEY"
expect PATCH $ME patient "$P1" idempotency-key-same-key-different-body-still-200 '200' 'b.data.gender==="undisclosed"' '{"gender":"undisclosed"}' "$KEY"
expect PATCH $ME patient "$P1" timezone-change-canonical '200' "b.data.timezone==='Europe/Berlin'" '{"timezone":"europe/berlin"}'
expect PATCH $ME patient "$P1" identity-headers-ignored '200' 'b.data.userId===301' '{"bloodType":"AB-"}' '' 'X-User-Id: 302'
expect GET $ME patient-unverified "$PUNV" unverified-email-allowed-reads '404 NotFound'
expect PATCH $ME patient-unverified "$PUNV" unverified-email-allowed-writes '200' 'b.data.userId===394' '{"timezone":"Africa/Cairo"}'
expect GET $ME patient "$P1" get-final-state '200' "b.data.gender==='undisclosed'&&b.data.bloodType==='AB-'&&b.data.timezone==='Europe/Berlin'&&b.data.id===$ID1"
check_value db 'exactly one live row per patient' 1 "$(sql "SELECT count(*) FROM patient_profiles WHERE user_id=301 AND deleted_at IS NULL")"
check_value audit 'every write has one audit row: patient 301 update rows == real changes (create plus each real change)' "$(sql "SELECT count(*) FROM audit_logs WHERE created_at >= '$T0' AND action='patient_profile.updated' AND actor_user_id=301")" "$(sql "SELECT count(*) FROM audit_logs WHERE created_at >= '$T0' AND action='patient_profile.updated' AND entity_id=$ID1")"
check_value audit 'audit metadata holds no clinical value' 0 "$(sql "SELECT count(*) FROM audit_logs WHERE created_at >= '$T0' AND entity_type='patient_profile' AND (metadata::text ~* 'TEST-(ALLERGEN|CONDITION)' OR metadata::text ~ '1990' OR metadata::text ~* 'female|undisclosed|AB-|O\\+')")"
check_value audit 'audit metadata keys are only created/changedFields/patientUserId' 0 "$(sql "SELECT count(*) FROM audit_logs a, jsonb_object_keys(a.metadata) k WHERE a.created_at >= '$T0' AND a.entity_type='patient_profile' AND k NOT IN ('created','changedFields','patientUserId')")"

# ---- 3. validation matrix (patient 304 owns a profile; none of these may change it) ----
expect PATCH $ME patient "$P4" setup-profile '200' '' '{"timezone":"Africa/Cairo","allergies":["TEST-ALLERGEN-V"]}'
BEFORE_V="$(sql "SELECT md5(row(allergies,chronic_conditions,timezone,gender,blood_type,date_of_birth,updated_at)::text) FROM patient_profiles WHERE user_id=304")"
v400() { expect PATCH $ME patient "$P4" "$1" '400 ValidationFailed' "${3:+$3&&}b.error.details.length>0&&!JSON.stringify(b).includes('SENTINEL')" "$2"; }
v400 unknown-member-userId '{"userId":999,"timezone":"Africa/Cairo"}' 'b.error.details.some(d=>d.field==="userId")'
v400 unknown-member-id '{"id":5,"gender":"male"}'
v400 unknown-member-fullName '{"fullName":"SENTINEL"}'
v400 unknown-member-diagnosis '{"diagnosis":"SENTINEL"}'
v400 timezone-null '{"timezone":null}'
v400 allergies-null '{"allergies":null}'
v400 chronic-null '{"chronicConditions":null}'
v400 timezone-invalid-zone '{"timezone":"Mars/Olympus"}'
v400 timezone-not-string '{"timezone":5}'
v400 timezone-65-chars "{\"timezone\":\"$(printf 'A%.0s' $(seq 1 65))\"}"
v400 gender-invalid '{"gender":"SENTINEL"}'
v400 gender-not-string '{"gender":1}'
v400 blood-type-invalid '{"bloodType":"SENTINEL"}'
v400 blood-type-lowercase '{"bloodType":"a+"}'
v400 allergies-not-array '{"allergies":"SENTINEL"}'
v400 allergies-51-items "{\"allergies\":[$(node -e 'process.stdout.write(Array.from({length:51},(_,i)=>JSON.stringify("SENTINEL-"+i)).join(","))')]}" 'b.error.details.some(d=>d.field==="allergies")'
v400 chronic-51-items "{\"chronicConditions\":[$(node -e 'process.stdout.write(Array.from({length:51},(_,i)=>JSON.stringify("SENTINEL-"+i)).join(","))')]}" 'b.error.details.some(d=>d.field==="chronicConditions")'
v400 allergy-item-201-chars "{\"allergies\":[\"SENTINEL$(printf 'x%.0s' $(seq 1 193))\"]}"
v400 allergy-item-empty '{"allergies":[""]}'
v400 allergy-item-blank '{"allergies":["   "]}'
v400 allergy-item-not-string '{"allergies":[5]}'
v400 allergy-item-control-char '{"allergies":["SENTINEL\u0007bell"]}'
v400 allergy-duplicate-items '{"allergies":["SENTINEL-DUP","SENTINEL-DUP"]}' 'b.error.details.some(d=>d.field==="allergies")'
v400 chronic-duplicate-items '{"chronicConditions":["SENTINEL-DUP","SENTINEL-DUP"]}'
v400 chronic-blank-item '{"chronicConditions":["\t"]}'
v400 dob-impossible-date '{"dateOfBirth":"2027-02-30"}'
v400 dob-wrong-format '{"dateOfBirth":"17/05/1990"}'
v400 dob-with-time '{"dateOfBirth":"1990-05-17T00:00:00Z"}'
v400 dob-number '{"dateOfBirth":19900517}'
v400 dob-in-future '{"dateOfBirth":"2999-01-01"}' 'b.error.details.some(d=>d.field==="dateOfBirth")'
v400 body-is-array '[]'
# Parser-level 400s (scalar JSON, malformed JSON) are rejected before the route; no-store must still be present.
v400 body-is-string '"SENTINEL"' 'b.error.details.some(d=>d.field==="body")'
check_value no-store 'scalar-JSON-body 400 carries Cache-Control: no-store (spec 3.1)' 1 "$(grep -qi '^cache-control: .*no-store' "$TMP/headers" && echo 1 || echo 0)"
v400 body-is-number '5'
expect PATCH $ME patient "$P4" malformed-json '400 ValidationFailed' '' '{"timezone":'
check_value no-store 'malformed-JSON 400 carries Cache-Control: no-store (spec 3.1)' 1 "$(grep -qi '^cache-control: .*no-store' "$TMP/headers" && echo 1 || echo 0)"
check_value db 'all 400 cases left the profile untouched' "$BEFORE_V" "$(sql "SELECT md5(row(allergies,chronic_conditions,timezone,gender,blood_type,date_of_birth,updated_at)::text) FROM patient_profiles WHERE user_id=304")"
expect PATCH $ME patient "$P4" allergies-exactly-50-ok '200' 'b.data.allergies.length===50' "{\"allergies\":[$(node -e 'process.stdout.write(Array.from({length:50},(_,i)=>JSON.stringify("TEST-A-"+i)).join(","))')]}"
expect PATCH $ME patient "$P4" item-exactly-200-chars-ok '200' 'b.data.allergies[0].length===200' "{\"allergies\":[\"$(printf 'x%.0s' $(seq 1 200))\"]}"
expect PATCH $ME patient "$P4" multibyte-200-code-points-ok '200' '[...b.data.allergies[0]].length===200' "{\"allergies\":[\"$(node -e 'process.stdout.write("é".repeat(200))')\"]}"
expect PATCH $ME patient "$P4" case-differing-items-are-not-duplicates '200' 'b.data.allergies.length===2' '{"allergies":["TEST-case","TEST-CASE"]}'
expect PATCH $ME patient "$P4" dob-today-ok '200' '' "{\"dateOfBirth\":\"$(ldate Africa/Cairo 0)\"}"
expect PATCH $ME patient "$P4" dob-leap-day-ok '200' 'b.data.dateOfBirth==="2000-02-29"' '{"dateOfBirth":"2000-02-29"}'
expect PATCH $ME patient "$P4" dob-non-leap-day-rejected '400 ValidationFailed' '' '{"dateOfBirth":"2001-02-29"}'

# ---- 4. ownership isolation ----
expect PATCH $ME patient "$P2" other-patient-creates-own '200' 'b.data.userId===302&&b.data.id!=='"$ID1" "{\"timezone\":\"Asia/Tokyo\",\"allergies\":[\"TEST-ALLERGEN-OTHER\"]}"
expect GET $ME patient "$P2" other-patient-sees-only-own '200' "b.data.userId===302&&b.data.timezone==='Asia/Tokyo'&&!JSON.stringify(b).includes('$SYN1')&&!JSON.stringify(b).includes('$SYN3')"
expect GET $ME patient "$P1" first-patient-unaffected '200' "b.data.userId===301&&b.data.timezone==='Europe/Berlin'&&!JSON.stringify(b).includes('TEST-ALLERGEN-OTHER')"
expect PATCH $ME patient "$P2" body-userId-cannot-redirect-write '400 ValidationFailed' '' '{"userId":301,"gender":"male"}'
check_value db 'patient 301 row not touched by patient 302 attempts' "undisclosed" "$(sql "SELECT gender FROM patient_profiles WHERE user_id=301")"

# ---- 5. concurrency: parallel first-time PATCHes of one patient ----
for i in 1 2 3 4 5 6; do
  ( curl -sS -o "$TMP/race$i.body" -w '%{http_code}' -X PATCH -H "Authorization: Bearer $P3" -H 'Content-Type: application/json' -H "X-Request-Id: $(uuid)" \
      --data-binary "{\"timezone\":\"Africa/Cairo\",\"allergies\":[\"TEST-RACE-$i\"]}" "$CARE_URL$ME" > "$TMP/race$i.status" ) &
done
wait
check_value concurrency 'six parallel first PATCHes all answer 200' '200 200 200 200 200 200' "$(for i in 1 2 3 4 5 6; do cat "$TMP/race$i.status"; printf ' '; done | sed 's/ $//')"
check_value concurrency 'exactly one live row after the race' 1 "$(sql "SELECT count(*) FROM patient_profiles WHERE user_id=303 AND deleted_at IS NULL")"
check_value concurrency 'no 500 body in the race (all success envelopes)' 6 "$(grep -l '"success":true' "$TMP"/race*.body | wc -l | tr -d ' ')"
check_value audit 'race: one audit row per real write (rows with created=true == 1)' 1 "$(sql "SELECT count(*) FROM audit_logs WHERE created_at >= '$T0' AND action='patient_profile.updated' AND actor_user_id=303 AND metadata->>'created'='true'")"

# ---- 6. dateOfBirth is judged in the patient's effective timezone ----
KIRI_TODAY="$(ldate Pacific/Kiritimati 0)"; KIRI_TOMORROW="$(ldate Pacific/Kiritimati 1)"
expect PATCH $ME patient "$P7" kiritimati-local-today-accepted '200' "b.data.dateOfBirth==='$KIRI_TODAY'" "{\"timezone\":\"Pacific/Kiritimati\",\"dateOfBirth\":\"$KIRI_TODAY\"}"
expect PATCH $ME patient "$P7" kiritimati-local-tomorrow-rejected '400 ValidationFailed' 'b.error.details.some(d=>d.field==="dateOfBirth")' "{\"dateOfBirth\":\"$KIRI_TOMORROW\"}"
expect PATCH $ME patient "$P8" create-with-future-dob-rejected-no-row '400 ValidationFailed' '' '{"timezone":"Africa/Cairo","dateOfBirth":"2999-01-01"}'
check_value db 'rejected create-with-future-dob wrote no row' 0 "$(sql "SELECT count(*) FROM patient_profiles WHERE user_id=308")"

# ---- 7. soft delete ----
sql "UPDATE patient_profiles SET deleted_at=now() WHERE user_id=302" >/dev/null
expect GET $ME patient "$P2" soft-deleted-profile-is-404 '404 NotFound'
expect PATCH $ME patient "$P2" new-live-row-after-soft-delete '200' 'b.data.userId===302' '{"timezone":"Asia/Tokyo"}'
check_value db 'soft-deleted row kept, one new live row' '2 1' "$(sql "SELECT count(*) || ' ' || count(*) FILTER (WHERE deleted_at IS NULL) FROM patient_profiles WHERE user_id=302")"

# ---- 8. database grants (app role) ----
check_value grants 'vcare_app has no DELETE on patient_profiles' false "$(sql "SELECT has_table_privilege('vcare_app','patient_profiles','DELETE')::text")"
check_value grants 'vcare_app has SELECT, INSERT, UPDATE on patient_profiles' 'true true true' "$(sql "SELECT has_table_privilege('vcare_app','patient_profiles','SELECT')::text || ' ' || has_table_privilege('vcare_app','patient_profiles','INSERT')::text || ' ' || has_table_privilege('vcare_app','patient_profiles','UPDATE')::text")"

# ---- 9. log hygiene ----
if [ -n "${SERVER_LOG:-}" ] && [ -f "$SERVER_LOG" ]; then
  check_value logs 'care-api log has no clinical fixture strings' 0 "$(grep -cE 'TEST-(ALLERGEN|CONDITION|RACE|A-|DUP)|SENTINEL|1990-05-17|Bearer ' "$SERVER_LOG" || true)"
  check_value logs 'care-api log has no level=error line' 0 "$(grep -c '"level":"error"' "$SERVER_LOG" || true)"
fi

# ---- 10. rate limits (last: they exhaust the windows) ----
NO_THROTTLE=1
ok=1
for i in $(seq 1 20); do
  s="$(call PATCH $ME "$P5" "{\"timezone\":\"Africa/Cairo\",\"allergies\":[\"TEST-RL-$i\"]}")"; [ "$s" = 200 ] || ok=0
done
check_value rate-limit 'first 20 PATCHes in the window all 200' 1 "$ok"
expect PATCH $ME patient "$P5" write-21st-limited '429 RateLimited' '' '{"gender":"male"}'
check_value rate-limit 'Retry-After present on 429' 1 "$(grep -qi '^retry-after: ' "$TMP/headers" && echo 1 || echo 0)"
expect PATCH $ME patient "$P9" write-limit-is-per-user '200' '' '{"timezone":"Africa/Cairo"}'
expect PATCH $ME patient "$P6" setup-for-read-limit '200' '' '{"timezone":"Africa/Cairo"}'
ok=1
for i in $(seq 1 120); do
  s="$(call GET $ME "$P6")"; [ "$s" = 200 ] || ok=0
done
check_value rate-limit 'first 120 GETs in the window all 200' 1 "$ok"
expect GET $ME patient "$P6" read-121st-limited '429 RateLimited'
check_value rate-limit 'Retry-After present on 429' 1 "$(grep -qi '^retry-after: ' "$TMP/headers" && echo 1 || echo 0)"
check_value audit 'GET audit rows == successful GETs for patient 306 (120)' 120 "$(audit_count patient_profile.read 306)"
check_value rate-limit 'a 429 GET is not audited and PATCH limit does not block reads' 1 "$([ "$(call GET $ME "$P5")" = 429 ] && echo 0 || echo 1)"

echo
echo "Result: $PASS pass / $FAIL fail"
[ "$FAIL" -eq 0 ]
