#!/usr/bin/env bash
# Repeatable HTTP QA for the four live doctors onboarding routes. Use only a disposable *_test database.
# Start scripts/doctors-qa-fake-identity.mjs and src/server.ts with its JWKS URL pointed at the fake first.
# Required: CARE_OWNER_DATABASE_URL, CARE_URL (default http://127.0.0.1:3001), FAKE_IDENTITY_URL
# (default http://127.0.0.1:3021). QA_REPORT optionally receives the case table without tokens or bodies.
set -euo pipefail

CARE_URL="${CARE_URL:-http://127.0.0.1:3001}"
FAKE_IDENTITY_URL="${FAKE_IDENTITY_URL:-http://127.0.0.1:3021}"
: "${CARE_OWNER_DATABASE_URL:?Set CARE_OWNER_DATABASE_URL to the disposable *_test owner database}"
[[ "$CARE_OWNER_DATABASE_URL" =~ /[^/?]*_test($|\?) ]] || { echo 'Refusing non-test database' >&2; exit 2; }
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
PASS=0; FAIL=0; CASE=0
uuid() { node -e 'process.stdout.write(require("node:crypto").randomUUID())'; }
sql() { psql "$CARE_OWNER_DATABASE_URL" -XAt -v ON_ERROR_STOP=1 -c "$1"; }
mint() { curl -fsS "$FAKE_IDENTITY_URL/mint?case=$1"; }
call() {
  local method="$1" path="$2" token="$3" body="${4:-}" key="${5:-}" rid
  rid="$(uuid)"; printf '%s' "$rid" > "$TMP/rid"
  local args=(-sS -X "$method" -H "X-Request-Id: $rid" -D "$TMP/headers" -o "$TMP/body" -w '%{http_code}')
  [ -z "$token" ] || args+=(-H "Authorization: Bearer $token")
  [ -z "$body" ] || args+=(-H 'Content-Type: application/json' --data-binary "$body")
  [ -z "$key" ] || args+=(-H "Idempotency-Key: $key")
  curl "${args[@]}" "$CARE_URL$path"
}
check_body() {
  node - "$TMP/body" "$TMP/headers" "$TMP/rid" "$1" "$2" <<'NODE'
const fs = require('fs');
const [file, headers, ridFile, kind, code] = process.argv.slice(2);
let b; try { b=JSON.parse(fs.readFileSync(file,'utf8')); } catch { process.exit(1); }
const rid=fs.readFileSync(ridFile,'utf8');
if (!new RegExp(`^x-request-id: ${rid}\\r?$`,'im').test(fs.readFileSync(headers,'utf8'))) process.exit(1);
if (kind==='error') {
  if (b.success!==false || b.error?.code!==code || b.error?.requestId!==rid ||
      typeof b.error?.message!=='string' || !Array.isArray(b.error?.details)) process.exit(1);
} else {
  if (b.success!==true || !b.data || typeof b.data!=='object') process.exit(1);
  const own='id userId headline bio yearsExperience languages specialties consultationFee defaultSlotMinutes timezone isAcceptingPatients verificationStatus reviewNote identitySyncStatus isSuspended suspendedAt isBookable createdAt updatedAt'.split(' ');
  const app='id doctorUserId doctor status identitySyncStatus specialties yearsExperience submittedAt decidedAt reviewedBy reviewNote documents missingRequirements'.split(' ');
  const required=kind==='own'?own:app;
  if (required.some(k=>!(k in b.data))) process.exit(1);
  if (kind==='own' && (!Array.isArray(b.data.languages) || !Array.isArray(b.data.specialties) ||
      typeof b.data.consultationFee?.amount!=='number' || typeof b.data.consultationFee?.currency!=='string')) process.exit(1);
  if (kind==='application' && (!Array.isArray(b.data.documents) || !Array.isArray(b.data.missingRequirements) ||
      b.data.doctor?.profileHydrated!==false)) process.exit(1);
}
NODE
}
record() {
  local method="$1" path="$2" role="$3" scenario="$4" expected="$5" got="$6" ok="$7"
  CASE=$((CASE+1))
  if [ "$ok" = 1 ]; then PASS=$((PASS+1)); result=PASS; else FAIL=$((FAIL+1)); result=FAIL; fi
  printf '%s|%s|%s|%s|%s|%s|%s|%s\n' "$CASE" "$method" "$path" "$role" "$scenario" "$expected" "$got" "$result" | tee -a "${QA_REPORT:-$TMP/report}"
}
expect() {
  local method="$1" path="$2" role="$3" token="$4" scenario="$5" expected="$6" kind="$7" body="${8:-}" key="${9:-}" status ok=1 code=''
  status="$(call "$method" "$path" "$token" "$body" "$key")"
  if [ "$kind" = error ]; then code="${expected#* }"; else code=''; fi
  [ "$status" = "${expected%% *}" ] || ok=0
  check_body "$kind" "$code" || ok=0
  local got="$status"
  if [ "$kind" = error ]; then
    got="$status $(node -e 'try{process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1])).error.code)}catch{process.stdout.write("invalid-body")}' "$TMP/body")"
  fi
  record "$method" "$path" "$role" "$scenario" "$expected" "$got" "$ok"
}

[ "$(curl -s -o /dev/null -w '%{http_code}' "$CARE_URL/api/health/live")" = 200 ] || { echo 'Care API unavailable' >&2; exit 2; }
[ "$(curl -s -o /dev/null -w '%{http_code}' "$FAKE_IDENTITY_URL/.well-known/jwks.json")" = 200 ] || { echo 'Fake Identity unavailable' >&2; exit 2; }
[ "$(sql 'select current_database()')" = care_test ] || { echo 'Expected care_test' >&2; exit 2; }
[ "$(sql 'select count(*) from doctor_profiles where user_id in (201,202,203)')" = 0 ] || { echo 'QA fixture user ids already occupied' >&2; exit 2; }
sql "INSERT INTO specialties (id,name,slug,is_active) VALUES (900001,'QA Synthetic One','qa-doctors-one',true),(900002,'QA Synthetic Two','qa-doctors-two',true) ON CONFLICT (id) DO NOTHING" >/dev/null
cleanup() {
  sql "DELETE FROM doctor_specialties WHERE doctor_profile_id IN (SELECT id FROM doctor_profiles WHERE user_id IN (201,202,203) AND headline LIKE 'QA Synthetic%'); DELETE FROM doctor_languages WHERE doctor_profile_id IN (SELECT id FROM doctor_profiles WHERE user_id IN (201,202,203) AND headline LIKE 'QA Synthetic%'); DELETE FROM doctor_profiles WHERE user_id IN (201,202,203) AND headline LIKE 'QA Synthetic%'; DELETE FROM specialties WHERE id IN (900001,900002) AND slug LIKE 'qa-doctors-%';" >/dev/null || true
}
trap 'cleanup; rm -rf "$TMP"' EXIT

DOCTOR="$(mint doctor-201)"; OTHER="$(mint doctor-pending)"; REJECTED="$(mint doctor-rejected)"
PATIENT="$(mint patient-101)"; ADMIN="$(mint admin-1)"; EXPIRED="$(mint expired)"
APPLY='{"headline":"QA Synthetic doctor","yearsExperience":5,"languages":["en","ar"],"specialtyIds":[900001,900002],"primarySpecialtyId":900001,"consultationFee":{"amount":100,"currency":"EGP"},"defaultSlotMinutes":30,"timezone":"africa/cairo","submit":false}'
A=/api/doctors/apply; M=/api/doctors/me; V=/api/doctors/me/application
echo 'case|method|path|role|scenario|expected|got|result'
for route in "POST $A" "GET $M" "PATCH $M" "GET $V"; do
  method="${route%% *}"; path="${route#* }"; payload=''; [ "$method" = POST ] && payload="$APPLY"; [ "$method" = PATCH ] && payload='{"headline":"QA Synthetic update"}'
  expect "$method" "$path" none '' unauthenticated '401 Unauthorized' error "$payload"
  expect "$method" "$path" patient "$PATIENT" wrong-role '403 Forbidden' error "$payload"
  expect "$method" "$path" admin "$ADMIN" wrong-role '403 Forbidden' error "$payload"
done
expect GET "$M" doctor "$EXPIRED" expired '401 TokenExpired' error
expect GET "$M" doctor "$OTHER" absent-other-doctor '404 NotFound' error
expect GET "$V" doctor "$OTHER" absent-other-application '404 NotFound' error
expect PATCH "$M" doctor "$DOCTOR" absent-profile '404 NotFound' error '{"headline":"QA Synthetic update"}'
expect POST "$A" doctor "$DOCTOR" create-draft '201 own' own "$APPLY"
cp "$TMP/body" "$TMP/created"
expect GET "$M" doctor "$DOCTOR" own-profile '200 own' own
expect GET "$V" doctor "$DOCTOR" own-application '200 application' application
expect GET "$M" doctor "$OTHER" non-owner-isolation '404 NotFound' error
expect POST "$A" doctor "$DOCTOR" replace-draft '200 own' own "$APPLY"
expect PATCH "$M" doctor "$DOCTOR" change-headline '200 own' own '{"headline":"QA Synthetic updated"}'
expect PATCH "$M" doctor "$DOCTOR" empty-body '400 ValidationFailed' error '{}'
expect PATCH "$M" doctor "$DOCTOR" invalid-timezone '400 ValidationFailed' error '{"timezone":"Bad/Zone"}'
expect PATCH "$M" doctor "$DOCTOR" unknown-property '400 ValidationFailed' error '{"userId":202}'
expect POST "$A" doctor "$OTHER" submit-needs-documents '400 ValidationFailed' error "${APPLY/\"submit\":false/\"submit\":true}"
expect POST "$A" doctor "$OTHER" unknown-specialty '400 ValidationFailed' error "${APPLY//900001/999999}"
expect POST "$A" doctor "$OTHER" currency-not-allowed '400 ValidationFailed' error "${APPLY/\"EGP\"/\"USD\"}"
expect POST "$A" doctor "$OTHER" body-userId-forbidden '400 ValidationFailed' error "${APPLY/\"submit\":false/\"userId\":201,\"submit\":false}"
KEY="$(uuid)"
expect POST "$A" doctor "$OTHER" idempotent-first '201 own' own "$APPLY" "$KEY"
cp "$TMP/body" "$TMP/idempotent"
expect POST "$A" doctor "$OTHER" idempotent-replay '201 own' own "$APPLY" "$KEY"
record POST "$A" doctor 'replay-body-equal' equal "$([ "$(cat "$TMP/idempotent")" = "$(cat "$TMP/body")" ] && echo equal || echo different)" "$([ "$(cat "$TMP/idempotent")" = "$(cat "$TMP/body")" ] && echo 1 || echo 0)"
expect POST "$A" doctor "$OTHER" idempotent-conflict '422 IdempotencyConflict' error "${APPLY/QA Synthetic doctor/QA Synthetic changed}" "$KEY"
expect POST "$A" doctor "$REJECTED" rejected-doctor-can-apply '201 own' own "$APPLY"
sql "UPDATE doctor_profiles SET suspended_at=now(), suspension_reason='QA synthetic suspension' WHERE user_id=201" >/dev/null
expect PATCH "$M" doctor "$DOCTOR" locally-suspended-blocked '403 Forbidden' error '{"headline":"QA Synthetic blocked"}'
expect GET "$M" doctor "$DOCTOR" locally-suspended-readable '200 own' own
sql 'UPDATE doctor_profiles SET suspended_at=NULL, suspension_reason=NULL WHERE user_id=201' >/dev/null
sql "UPDATE doctor_profiles SET verification_status='submitted', submitted_at=now() WHERE user_id=201" >/dev/null
expect POST "$A" doctor "$DOCTOR" submitted-conflict '409 Conflict' error "$APPLY"
sql "UPDATE doctor_profiles SET verification_status='draft', submitted_at=NULL WHERE user_id=201" >/dev/null
# One prior successful write by rejected doctor; 19 more fit the 20/min window, then the next is limited.
for i in $(seq 1 19); do call PATCH "$M" "$REJECTED" '{"headline":"QA Synthetic doctor"}' >/dev/null; done
expect PATCH "$M" doctor "$REJECTED" rate-limit '429 RateLimited' error '{"headline":"QA Synthetic doctor"}'
echo "RESULT $PASS pass / $FAIL fail ($CASE cases)"
[ "$FAIL" = 0 ]
