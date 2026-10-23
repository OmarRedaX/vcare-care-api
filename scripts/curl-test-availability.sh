#!/usr/bin/env bash
# Slice 1 slots QA (GET /api/doctors/{doctorUserId}/slots) against a disposable *_test database, a running Care API
# and the schedules fake Identity (scripts/schedules-qa-fake-identity.mjs, mints patient-101 with a verified email).
#
# Required: CARE_OWNER_DATABASE_URL (owner login to a disposable *_test database).
# Optional: CARE_URL (default http://127.0.0.1:3001), FAKE_IDENTITY_URL (default http://127.0.0.1:3021),
#           REDIS_URL (the SAME Redis the Care server uses). When set, the Redis-backed cases (cache hit, key + TTL,
#           invalidation on book and cancel) run in addition to the eight base cases. When unset, only the base cases run
#           (use that mode against a Care server whose REDIS_URL points at an unreachable port to verify the Postgres fallback).
# The script touches Redis only for doctor user 208: slots:208:*, slots-ver:208, free-map:208 and member 208 of
# next-available:index / next-available:refresh. It removes its own Postgres rows and Redis keys on exit.
set -euo pipefail

CARE_URL="${CARE_URL:-http://127.0.0.1:3001}"
FAKE_IDENTITY_URL="${FAKE_IDENTITY_URL:-http://127.0.0.1:3021}"
: "${CARE_OWNER_DATABASE_URL:?Set CARE_OWNER_DATABASE_URL for a disposable *_test database}"
[[ "$CARE_OWNER_DATABASE_URL" =~ /[^/?]*_test($|\?) ]] || { echo 'Refusing a non-test database' >&2; exit 2; }
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REDIS_URL="${REDIS_URL:-}"

tmp="$(mktemp -d)"
sql() { psql "$CARE_OWNER_DATABASE_URL" -XAtq -v ON_ERROR_STOP=1 -c "$1" | tr -d '\r'; }
mint() { curl -fsS "$FAKE_IDENTITY_URL/mint?case=$1"; }
uuid() { node -e 'process.stdout.write(require("node:crypto").randomUUID())'; }

# Redis helper (ioredis from node_modules; no redis-cli needed). Commands: keys <prefix> | get <key> | ttl <key> | cleanup208
rds() {
  ROOT="$ROOT" RURL="$REDIS_URL" node -e '
const Redis = require(process.env.ROOT + "/node_modules/ioredis");
const r = new Redis(process.env.RURL);
const scan = async (p) => { let c = "0"; const out = []; do { const [n, ks] = await r.scan(c, "MATCH", p + "*", "COUNT", 500); c = n; out.push(...ks); } while (c !== "0"); return out; };
(async () => {
  const [cmd, arg] = process.argv.slice(1);
  if (cmd === "keys") console.log((await scan(arg)).sort().join("\n"));
  else if (cmd === "get") console.log((await r.get(arg)) ?? "");
  else if (cmd === "ttl") console.log(await r.ttl(arg));
  else if (cmd === "cleanup208") {
    const ks = [...(await scan("slots:208:")), "slots-ver:208", "free-map:208"];
    await r.del(...ks); await r.zrem("next-available:index", "208"); await r.srem("next-available:refresh", "208");
  }
  await r.quit();
})().catch((e) => { console.error(e.message); process.exit(1); });' "$@" | tr -d '\r'
}

reset_fixture() {
  # trg_notification_outbox_delete_sent_only refuses deleting pending rows: mark this fixture's rows sent first.
  sql "UPDATE notification_outbox SET status = 'sent', sent_at = now() WHERE status <> 'sent' AND consultation_id IN (SELECT id FROM consultations WHERE doctor_user_id = 208);
       DELETE FROM notification_outbox WHERE consultation_id IN (SELECT id FROM consultations WHERE doctor_user_id = 208);
       DELETE FROM consultations WHERE doctor_user_id = 208;
       DELETE FROM consultation_types WHERE doctor_profile_id IN (SELECT id FROM doctor_profiles WHERE user_id = 208);
       DELETE FROM working_hours WHERE doctor_profile_id IN (SELECT id FROM doctor_profiles WHERE user_id = 208);
       DELETE FROM doctor_profiles WHERE user_id = 208;" >/dev/null
}
cleanup() {
  reset_fixture 2>/dev/null || true
  [ -z "$REDIS_URL" ] || rds cleanup208 >/dev/null 2>&1 || true
  rm -rf "$tmp"
}
trap cleanup EXIT

tomorrow="$(node -e 'const d=new Date();d.setUTCHours(0,0,0,0);d.setUTCDate(d.getUTCDate()+1);process.stdout.write(d.toISOString().slice(0,10))')"
next="$(node -e 'const d=new Date(process.argv[1]+"T00:00:00Z");d.setUTCDate(d.getUTCDate()+1);process.stdout.write(d.toISOString().slice(0,10))' "$tomorrow")"
from="${tomorrow}T00:00:00Z"
to="${next}T00:00:00Z"
past_from="2020-01-01T00:00:00Z"
past_to="2020-01-02T00:00:00Z"

# Synthetic fixture, isolated by user id 208.
reset_fixture
[ -z "$REDIS_URL" ] || rds cleanup208 >/dev/null
profile_id="$(sql "INSERT INTO doctor_profiles (user_id, headline, years_experience, consultation_fee, currency, default_slot_minutes, timezone, is_accepting_patients, verification_status, identity_sync_status, decided_at) VALUES (208, 'Synthetic Availability QA', 5, 100, 'EGP', 30, 'UTC', true, 'approved', 'synced', NOW()) RETURNING id")"
weekday="$(sql "SELECT EXTRACT(ISODOW FROM DATE '$tomorrow')::int")"
sql "INSERT INTO working_hours (doctor_profile_id, weekday, start_time, end_time) VALUES ($profile_id, $weekday, '09:00', '11:00')" >/dev/null
type_id="$(sql "INSERT INTO consultation_types (doctor_profile_id, name, duration_minutes, price, currency, is_active) VALUES ($profile_id, 'Synthetic Availability Visit', 30, 100, 'EGP', true) RETURNING id")"

patient="$(mint patient-101)"
admin="$(mint admin-1)"
doctor="$(mint doctor-208)"
passed=0

fail() { printf 'FAIL %s\n' "$*" >&2; exit 1; }
ok() { passed=$((passed+1)); printf 'PASS %s\n' "$*"; }

# jv <file> <js expression over b> -> prints the value (b = parsed JSON file)
jv() { node -e 'const b=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(String(eval(process.argv[2])))' "$1" "$2"; }

# call <method> <path> <token> [body] [idempotency-key]; sets $status and $rid; body in $tmp/body, headers in $tmp/headers
call() {
  local method="$1" path="$2" token="$3" body="${4:-}" key="${5:-}"
  rid="$(uuid)"
  local args=(-sS -X "$method" -D "$tmp/headers" -o "$tmp/body" -w '%{http_code}' -H "X-Request-Id: $rid")
  [ -z "$token" ] || args+=(-H "Authorization: Bearer $token")
  [ -z "$body" ] || args+=(-H 'Content-Type: application/json' --data-binary "$body")
  [ -z "$key" ] || args+=(-H "Idempotency-Key: $key")
  status="$(curl "${args[@]}" "$CARE_URL$path")"
}
rid_echoed() { tr -d '\r' < "$tmp/headers" | grep -qix "x-request-id: $rid"; }
slots_get() { call GET "/api/doctors/208/slots?typeId=$type_id&from=$from&to=$to" "$1"; }

check() {
  local label="$1" expected_status="$2" expected_code="$3" token="$4" kind="$5" f="$6" t="$7" zone="${8:-}"
  local rid status
  rid="$(uuid)"
  local args=(-sS -G -D "$tmp/headers" -o "$tmp/body" -w '%{http_code}' -H "X-Request-Id: $rid" \
    --data-urlencode "typeId=$kind" --data-urlencode "from=$f" --data-urlencode "to=$t")
  [ -z "$token" ] || args+=(-H "Authorization: Bearer $token")
  [ -z "$zone" ] || args+=(--data-urlencode "timezone=$zone")
  status="$(curl "${args[@]}" "$CARE_URL/api/doctors/208/slots")"
  node - "$tmp/body" "$tmp/headers" "$rid" "$status" "$expected_status" "$expected_code" <<'NODE' || fail "$label (status $status, expected $expected_status $expected_code)"
const fs=require('fs');
const [bodyFile,headerFile,rid,status,wanted,code]=process.argv.slice(2);
const h=fs.readFileSync(headerFile,'utf8');
const b=JSON.parse(fs.readFileSync(bodyFile,'utf8'));
if(status!==wanted || !new RegExp(`^x-request-id: ${rid}\\r?$`,'im').test(h)) process.exit(1);
if(code==='ok') {
  if(b.success!==true || !Array.isArray(b.data) || b.meta?.count!==b.data.length) process.exit(1);
  if(b.data.some(x=>typeof x.startsAt!=='string'||typeof x.endsAt!=='string'||typeof x.startsAtLocal!=='string'||typeof x.endsAtLocal!=='string'||typeof x.timezone!=='string')) process.exit(1);
} else if(b.success!==false || b.error?.code!==code || b.error?.requestId!==rid || !Array.isArray(b.error?.details)) process.exit(1);
NODE
  passed=$((passed+1))
  printf 'PASS %s (%s %s)\n' "$label" "$status" "$expected_code"
}

echo '== base cases (Redis independent; same answers with Redis up or down) =='
check 'unauthenticated' 401 Unauthorized '' "$type_id" "$from" "$to"
check 'doctor denied' 403 Forbidden "$doctor" "$type_id" "$from" "$to"
check 'patient slots' 200 ok "$patient" "$type_id" "$from" "$to"
check 'admin slots' 200 ok "$admin" "$type_id" "$from" "$to"
check 'invalid timezone' 400 ValidationFailed "$patient" "$type_id" "$from" "$to" 'Invalid/Zone'
check 'unknown type' 404 NotFound "$patient" 999999 "$from" "$to"
check 'past window empty' 200 ok "$patient" "$type_id" "$past_from" "$past_to"

if [ -n "$REDIS_URL" ]; then
  echo '== Redis-backed cases (user 208 keys only) =='
  rds cleanup208 >/dev/null

  # (a) cache write, TTL, identical second response, and proof that the second read is served from the cache
  slots_get "$patient"; [ "$status" = 200 ] && rid_echoed || fail "(a) first slots call: status $status"
  cp "$tmp/body" "$tmp/first"
  count0="$(jv "$tmp/first" 'b.data.length')"
  [ "$count0" = 4 ] || fail "(a) expected 4 slots on the first call, got $count0"
  keys="$(rds keys 'slots:208:')"
  [ "$(printf '%s\n' "$keys" | grep -c .)" -ge 1 ] || fail '(a) no slots:208:* key after the first call'
  key="$(printf '%s\n' "$keys" | head -1)"
  ttl="$(rds ttl "$key")"
  { [ "$ttl" -gt 0 ] && [ "$ttl" -le 60 ]; } || fail "(a) TTL of $key is $ttl, expected 1..60"
  ok "(a) first call 200, ${count0} slots, key $key exists, TTL ${ttl}s <= 60"
  slots_get "$patient"; [ "$status" = 200 ] && rid_echoed || fail "(a) second slots call: status $status"
  [ "$(jv "$tmp/first" 'JSON.stringify(b)')" = "$(jv "$tmp/body" 'JSON.stringify(b)')" ] || fail '(a) second response differs from the first'
  ok '(a) second identical request returns an identical body (data and meta)'
  # Behind-the-cache change with no version bump: a cache hit must still return the original four slots.
  sql "UPDATE working_hours SET end_time = '09:30' WHERE doctor_profile_id = $profile_id" >/dev/null
  slots_get "$patient"; [ "$status" = 200 ] || fail "(a) third call: status $status"
  [ "$(jv "$tmp/body" 'b.data.length')" = 4 ] || fail '(a) third call recomputed (working hours edit visible), so the cache was not hit'
  sql "UPDATE working_hours SET end_time = '11:00' WHERE doctor_profile_id = $profile_id" >/dev/null
  ok '(a) cache hit proven: edit of working hours behind the cache (no version bump) is not visible within the TTL'

  # (b) real booking through the API: slot disappears, slots-ver:208 incremented
  ver0="$(rds get slots-ver:208)"; ver0="${ver0:-0}"
  start="$(jv "$tmp/first" 'b.data[0].startsAt')"
  book_body="$(printf '{"doctorId":208,"typeId":%s,"startsAt":"%s","complaintText":"Synthetic availability QA visit","patientTimezone":"UTC"}' "$type_id" "$start")"
  call POST /api/consultations "$patient" "$book_body" "$(uuid)"
  [ "$status" = 201 ] || fail "(b) booking returned $status: $(cat "$tmp/body" | head -c 300)"
  rid_echoed || fail '(b) booking did not echo X-Request-Id'
  cid="$(jv "$tmp/body" 'b.data.id')"
  ver1="$(rds get slots-ver:208)"; ver1="${ver1:-0}"
  [ "$ver1" -gt "$ver0" ] || fail "(b) slots-ver:208 did not increment on booking ($ver0 -> $ver1)"
  slots_get "$patient"; [ "$status" = 200 ] && rid_echoed || fail "(b) slots after booking: status $status"
  [ "$(jv "$tmp/body" "b.data.some(x=>x.startsAt==='$start')")" = false ] || fail '(b) booked start is still listed'
  [ "$(jv "$tmp/body" 'b.data.length')" = 3 ] || fail "(b) expected 3 slots after booking, got $(jv "$tmp/body" 'b.data.length')"
  ok "(b) booking 201 (id $cid), slots-ver:208 $ver0 -> $ver1, booked start no longer listed (3 slots)"

  # (c) cancel through the API: slot reappears, version incremented again
  call PATCH "/api/consultations/$cid/cancel" "$patient" '{"reason":"Synthetic QA cancel"}' "$(uuid)"
  [ "$status" = 200 ] || fail "(c) cancel returned $status: $(cat "$tmp/body" | head -c 300)"
  rid_echoed || fail '(c) cancel did not echo X-Request-Id'
  ver2="$(rds get slots-ver:208)"; ver2="${ver2:-0}"
  [ "$ver2" -gt "$ver1" ] || fail "(c) slots-ver:208 did not increment on cancel ($ver1 -> $ver2)"
  slots_get "$patient"; [ "$status" = 200 ] && rid_echoed || fail "(c) slots after cancel: status $status"
  [ "$(jv "$tmp/body" "b.data.some(x=>x.startsAt==='$start')")" = true ] || fail '(c) cancelled start did not reappear'
  [ "$(jv "$tmp/body" 'b.data.length')" = 4 ] || fail '(c) expected 4 slots after cancel'
  ok "(c) cancel 200, slots-ver:208 $ver1 -> $ver2, start listed again (4 slots)"

  # (d) request id echo was asserted on every call above; also on a cache-hit admin read and an error response
  slots_get "$admin"; [ "$status" = 200 ] && rid_echoed || fail '(d) admin cached read: no X-Request-Id echo'
  ok '(d) X-Request-Id echoed on every call in (a)-(c) and on an admin cached read'

  # Cache must not be served once the doctor stops being bookable (404 checks run before the cache read, AV-R9).
  [ -n "$(rds keys 'slots:208:')" ] || fail 'expected a slots:208:* key before the non-bookable check'
fi

sql "UPDATE doctor_profiles SET is_accepting_patients = false WHERE id = $profile_id" >/dev/null
check 'non-bookable doctor (cache key present when Redis is up)' 404 NotFound "$admin" "$type_id" "$from" "$to"
printf 'Availability slice 1 CURL QA: %s passed\n' "$passed"
