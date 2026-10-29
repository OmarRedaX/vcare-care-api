#!/usr/bin/env bash
# availability CURL QA, slice 1 (GET /api/doctors/{id}/slots), slice 2 (GET /api/doctors search, GET /api/doctors/{id} profile,
# the availability-refresh / availability-sweep worker loops) and slice 3 (name index and the `name` filter: AV-R27..AV-R29)
# against a disposable *_test database, a running Care API and the availability fake Identity
# (scripts/availability-qa-fake-identity.mjs: JWKS, token mint, batch users, control surface incl. rename).
#
# Required: CARE_OWNER_DATABASE_URL (owner login to a disposable *_test database).
# Optional:
#   CARE_URL             default http://127.0.0.1:3001 (the Care API under test)
#   FAKE_IDENTITY_URL    default http://127.0.0.1:3021
#   REDIS_URL            the SAME Redis the Care server uses. Set = "Redis-up" run (cache, index, freshness, worker cases run).
#                        Unset = "Redis-down" run: point CARE_URL at a Care server whose REDIS_URL is unreachable; the degraded
#                        answers (meta.degraded) are asserted instead.
#   CARE_UP_URL          Redis-down run only: a second Care server WITH Redis, used to mint an `earliest` cursor (same signing secret)
#                        for the "earliest cursor is 400 while Redis is unusable" case. Skipped when unset.
#   EARLIEST_CURSOR / DEGRADED_CURSOR / CURSOR_FILE
#                        Cross-run cursors (no second server needed): a Redis-up run with CURSOR_FILE=<path> writes
#                        EARLIEST_CURSOR=<cursor>; a Redis-down run with CURSOR_FILE=<path> writes DEGRADED_CURSOR=<cursor>.
#                        Export either into the other run (same SERVICE_CLIENT_SECRET) to assert the cross-mode 400s.
#   CARE_LOG_FILE        file the Care server's stdout was redirected to; scanned for fixture display names, avatar URLs and the
#                        name query (none allowed), error-level lines and 5xx lines. Skipped when unset.
#   AVAILABILITY_INLINE_MISS_CAP  must equal the server's value (default 20).
#   WORKER_CMD           default "node --import tsx src/worker.ts" (run from the repo root). The worker cases need the worker
#                        env (DATABASE_URL, REDIS_URL, IDENTITY_*, SERVICE_CLIENT_*, STORAGE_*, VIDEO_*) exported, exactly like
#                        the server's; they are skipped when DATABASE_URL is unset or REDIS_URL is unset.
#   KEEP_FIXTURE=1       leave the fixture rows and Redis keys in place on exit (manual probing; the next run resets them).
#   SKIP_RATE_LIMIT=1    skip the final 429 case (it exhausts the profile route limiter for up to a minute).
# Fixture ids (cannot collide with other scripts): slice 1 doctor 208; slice 2 doctors 8201-8208 and 8210-8234; specialties
# qa-avail-a|b|c. Redis keys touched: slots:/slots-ver:/free-map:/identity:user: of those doctors, their members of
# next-available:index / next-available:refresh, rl:doctors-* and the write-limiter counters of the fixture users (rate limiter
# counters), the idem:* keys of its own booking/cancel calls, name-index* (slice 3; deleted at the start of a Redis-up run so the
# "index absent before any sweep" cases are deterministic) and next-available:swept-at when this run created it. Everything is
# removed on exit. audit_logs rows written by the doctor API calls are append-only and stay.
# Slice 3 (Redis-up run) additionally needs the worker env exported (it runs `--once availability-sweep` several times, with
# LOG_LEVEL=info so the availability_name_index_* lines are written) and uses pg_dump (optional) for the "no names in Postgres" scan.
set -euo pipefail

CARE_URL="${CARE_URL:-http://127.0.0.1:3001}"
FAKE_IDENTITY_URL="${FAKE_IDENTITY_URL:-http://127.0.0.1:3021}"
: "${CARE_OWNER_DATABASE_URL:?Set CARE_OWNER_DATABASE_URL for a disposable *_test database}"
[[ "$CARE_OWNER_DATABASE_URL" =~ /[^/?]*_test($|\?) ]] || { echo 'Refusing a non-test database' >&2; exit 2; }
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REDIS_URL="${REDIS_URL:-}"
CARE_UP_URL="${CARE_UP_URL:-}"
EARLIEST_CURSOR="${EARLIEST_CURSOR:-}"
DEGRADED_CURSOR="${DEGRADED_CURSOR:-}"
CURSOR_FILE="${CURSOR_FILE:-}"
CARE_LOG_FILE="${CARE_LOG_FILE:-}"
INLINE_CAP="${AVAILABILITY_INLINE_MISS_CAP:-20}"
WORKER_CMD="${WORKER_CMD:-node --import tsx src/worker.ts}"
SKIP_RATE_LIMIT="${SKIP_RATE_LIMIT:-0}"

tmp="$(mktemp -d)"
passed=0; failed=0; skipped=0; case_no=0
WORKER_PID=""
LOCK_PID=""
SWEPT_AT_PRE=""
sql() { psql "$CARE_OWNER_DATABASE_URL" -XAtq -v ON_ERROR_STOP=1 -c "$1" | tr -d '\r'; }
mint() { curl -fsS "$FAKE_IDENTITY_URL/mint?case=$1"; }
uuid() { node -e 'process.stdout.write(require("node:crypto").randomUUID())'; }
IDEM_KEYS=()
new_key() { NEW_KEY="$(uuid)"; IDEM_KEYS+=("$NEW_KEY"); }

# Redis helper (ioredis from node_modules; no redis-cli needed).
#   rds keys <prefix> | get <key> | ttl <key> | cleanup208 | cleanup82 | rlreset | delidem <uuid...> | raw <ioredis-method> <args...>
rds() {
  ROOT="$ROOT" RURL="$REDIS_URL" node -e '
const Redis = require(process.env.ROOT + "/node_modules/ioredis");
const r = new Redis(process.env.RURL);
const scan = async (p) => { let c = "0"; const out = []; do { const [n, ks] = await r.scan(c, "MATCH", p + "*", "COUNT", 500); c = n; out.push(...ks); } while (c !== "0"); return out; };
const del = async (ks) => { for (let i = 0; i < ks.length; i += 100) await r.del(...ks.slice(i, i + 100)); };
(async () => {
  const [cmd, ...args] = process.argv.slice(1);
  if (cmd === "keys") console.log((await scan(args[0])).sort().join("\n"));
  else if (cmd === "get") console.log((await r.get(args[0])) ?? "");
  else if (cmd === "ttl") console.log(await r.ttl(args[0]));
  else if (cmd === "cleanup208") {
    const ks = [...(await scan("slots:208:")), "slots-ver:208", "free-map:208"];
    await del(ks); await r.zrem("next-available:index", "208"); await r.srem("next-available:refresh", "208");
  } else if (cmd === "cleanup82") {
    const ks = [...(await scan("slots:82")), ...(await scan("slots-ver:82")), ...(await scan("free-map:82")), ...(await scan("identity:user:82")), ...(await scan("rl:doctors-")),
      ...(await scan("rl:schedules-write-user:82")), ...(await scan("rl:schedules-read-user:82")), "rl:consultations-write-user:101", "rl:consultations-write-admin:1"];
    await del(ks);
    const members = [];
    for (let id = 8201; id <= 8299; id++) members.push(String(id));
    await r.zrem("next-available:index", ...members); await r.srem("next-available:refresh", ...members);
  } else if (cmd === "delidem") { const ks = (await scan("idem:")).filter((k) => args.some((u) => k.endsWith(":" + u))); await del(ks); }
  else if (cmd === "rlreset") await del(await scan("rl:doctors-"));
  else if (cmd === "cleanupnames") await del([...(await scan("name-index")), ...(await scan("identity:user:82")), ...(await scan("identity:user:208"))]);
  else if (cmd === "cleanupidentity") await del(await scan("identity:user:82"));
  else if (cmd === "raw") { const v = await r[args[0]](...args.slice(1)); console.log(Array.isArray(v) ? v.join(",") : (v ?? "")); }
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
reset_fixture2() {
  local own="SELECT id FROM doctor_profiles WHERE user_id BETWEEN 8200 AND 8299"
  sql "UPDATE notification_outbox SET status = 'sent', sent_at = now() WHERE status <> 'sent' AND consultation_id IN (SELECT id FROM consultations WHERE doctor_user_id BETWEEN 8200 AND 8299);
       DELETE FROM notification_outbox WHERE consultation_id IN (SELECT id FROM consultations WHERE doctor_user_id BETWEEN 8200 AND 8299);
       DELETE FROM consultations WHERE doctor_user_id BETWEEN 8200 AND 8299;
       DELETE FROM doctor_languages WHERE doctor_profile_id IN ($own);
       DELETE FROM doctor_specialties WHERE doctor_profile_id IN ($own);
       DELETE FROM consultation_types WHERE doctor_profile_id IN ($own);
       DELETE FROM working_hours WHERE doctor_profile_id IN ($own);
       DELETE FROM schedule_exceptions WHERE doctor_profile_id IN ($own);
       DELETE FROM doctor_profiles WHERE user_id BETWEEN 8200 AND 8299;
       DELETE FROM specialties WHERE slug IN ('qa-avail-a','qa-avail-b','qa-avail-c');
       DELETE FROM patient_profiles WHERE user_id = 8301;" >/dev/null
}
# release_lock: end the session that holds the sweep advisory lock. `kill` of the background psql is not enough on Git Bash for Windows (it
# kills the wrapper, the native psql keeps the lock for the whole pg_sleep and starves the next sweep), so terminate the backend itself.
release_lock() {
  [ -n "$LOCK_PID" ] || return 0
  kill "$LOCK_PID" 2>/dev/null || true
  sql "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE query LIKE 'SELECT pg_advisory_lock(hashtextextended%' AND pid <> pg_backend_pid()" >/dev/null 2>&1 || true
  LOCK_PID=""
}
worker_stop() {
  [ -n "$WORKER_PID" ] || return 0
  local win=""
  [ -r "/proc/$WORKER_PID/winpid" ] && win="$(cat "/proc/$WORKER_PID/winpid")"
  if [ -n "$win" ] && command -v taskkill >/dev/null 2>&1; then MSYS_NO_PATHCONV=1 taskkill /PID "$win" /T /F >/dev/null 2>&1 || true; else kill "$WORKER_PID" 2>/dev/null || true; fi
  WORKER_PID=""
}
summary() { printf 'Availability CURL QA (%s): %s passed, %s failed, %s skipped\n' "$([ -n "$REDIS_URL" ] && echo 'Redis up' || echo 'Redis down')" "$passed" "$failed" "$skipped"; }
cleanup() {
  local code=$?
  worker_stop
  release_lock
  curl -fsS "$FAKE_IDENTITY_URL/control/reset" >/dev/null 2>&1 || true
  if [ "${KEEP_FIXTURE:-0}" = 1 ]; then rm -rf "$tmp"; summary; echo '(KEEP_FIXTURE=1: fixture rows and Redis keys left in place)'; exit "$code"; fi
  reset_fixture 2>/dev/null || true
  reset_fixture2 2>/dev/null || true
  if [ -n "$REDIS_URL" ]; then
    rds cleanup208 >/dev/null 2>&1 || true
    rds cleanup82 >/dev/null 2>&1 || true
    rds cleanupnames >/dev/null 2>&1 || true
    [ "${#IDEM_KEYS[@]}" -eq 0 ] || rds delidem "${IDEM_KEYS[@]}" >/dev/null 2>&1 || true
    [ -n "$SWEPT_AT_PRE" ] || rds raw del next-available:swept-at >/dev/null 2>&1 || true
  fi
  rm -rf "$tmp"
  summary
  exit "$code"
}
trap cleanup EXIT

tomorrow="$(node -e 'const d=new Date();d.setUTCHours(0,0,0,0);d.setUTCDate(d.getUTCDate()+1);process.stdout.write(d.toISOString().slice(0,10))')"
next="$(node -e 'const d=new Date(process.argv[1]+"T00:00:00Z");d.setUTCDate(d.getUTCDate()+1);process.stdout.write(d.toISOString().slice(0,10))' "$tomorrow")"
from="${tomorrow}T00:00:00Z"
to="${next}T00:00:00Z"
past_from="2020-01-01T00:00:00Z"
past_to="2020-01-02T00:00:00Z"

# ================================================================================================================================
# Slice 1 fixture: synthetic doctor 208 (UTC, one 30-minute type, 09:00-11:00 on the next UTC day)
# ================================================================================================================================
reset_fixture
if [ -n "$REDIS_URL" ]; then
  rds cleanup208 >/dev/null
  SWEPT_AT_PRE="$(rds get next-available:swept-at)"
fi
profile_id="$(sql "INSERT INTO doctor_profiles (user_id, headline, years_experience, consultation_fee, currency, default_slot_minutes, timezone, is_accepting_patients, verification_status, identity_sync_status, decided_at) VALUES (208, 'Synthetic Availability QA', 5, 100, 'EGP', 30, 'UTC', true, 'approved', 'synced', NOW()) RETURNING id")"
weekday="$(sql "SELECT EXTRACT(ISODOW FROM DATE '$tomorrow')::int")"
sql "INSERT INTO working_hours (doctor_profile_id, weekday, start_time, end_time) VALUES ($profile_id, $weekday, '09:00', '11:00')" >/dev/null
type_id="$(sql "INSERT INTO consultation_types (doctor_profile_id, name, duration_minutes, price, currency, is_active) VALUES ($profile_id, 'Synthetic Availability Visit', 30, 100, 'EGP', true) RETURNING id")"

patient="$(mint patient-101)"
admin="$(mint admin-1)"
doctor="$(mint doctor-208)"

fail() { failed=$((failed+1)); printf 'FAIL %s\n' "$*" >&2; exit 1; }
ok() { passed=$((passed+1)); case_no=$((case_no+1)); printf 'PASS #%03d %s\n' "$case_no" "$*"; }
bad() { failed=$((failed+1)); case_no=$((case_no+1)); printf 'FAIL #%03d %s\n' "$case_no" "$*" >&2; }
skip() { skipped=$((skipped+1)); printf 'SKIP %s\n' "$*"; }

# jv <file> <js expression over b> -> prints the value (b = parsed JSON file)
jv() { node -e 'const b=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(String(eval(process.argv[2])))' "$1" "$2"; }
# jt <file> <js expression over b> -> exit 0 when truthy (also false on a parse error)
jt() { node -e 'let ok=false;try{const b=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));ok=!!eval(process.argv[2]);}catch(e){}process.exit(ok?0:1)' "$1" "$2"; }

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
  passed=$((passed+1)); case_no=$((case_no+1))
  printf 'PASS #%03d S1 %s (%s %s)\n' "$case_no" "$label" "$status" "$expected_code"
}

echo '== slice 1: base cases (Redis independent; same answers with Redis up or down) =='
check 'unauthenticated' 401 Unauthorized '' "$type_id" "$from" "$to"
check 'doctor denied' 403 Forbidden "$doctor" "$type_id" "$from" "$to"
check 'patient slots' 200 ok "$patient" "$type_id" "$from" "$to"
check 'admin slots' 200 ok "$admin" "$type_id" "$from" "$to"
check 'invalid timezone' 400 ValidationFailed "$patient" "$type_id" "$from" "$to" 'Invalid/Zone'
check 'unknown type' 404 NotFound "$patient" 999999 "$from" "$to"
check 'past window empty' 200 ok "$patient" "$type_id" "$past_from" "$past_to"

if [ -n "$REDIS_URL" ]; then
  echo '== slice 1: Redis-backed cases (user 208 keys only) =='
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
  ok "S1 (a) first call 200, ${count0} slots, key $key exists, TTL ${ttl}s <= 60"
  slots_get "$patient"; [ "$status" = 200 ] && rid_echoed || fail "(a) second slots call: status $status"
  [ "$(jv "$tmp/first" 'JSON.stringify(b)')" = "$(jv "$tmp/body" 'JSON.stringify(b)')" ] || fail '(a) second response differs from the first'
  ok 'S1 (a) second identical request returns an identical body (data and meta)'
  # Behind-the-cache change with no version bump: a cache hit must still return the original four slots.
  sql "UPDATE working_hours SET end_time = '09:30' WHERE doctor_profile_id = $profile_id" >/dev/null
  slots_get "$patient"; [ "$status" = 200 ] || fail "(a) third call: status $status"
  [ "$(jv "$tmp/body" 'b.data.length')" = 4 ] || fail '(a) third call recomputed (working hours edit visible), so the cache was not hit'
  sql "UPDATE working_hours SET end_time = '11:00' WHERE doctor_profile_id = $profile_id" >/dev/null
  ok 'S1 (a) cache hit proven: edit of working hours behind the cache (no version bump) is not visible within the TTL'

  # (b) real booking through the API: slot disappears, slots-ver:208 incremented
  ver0="$(rds get slots-ver:208)"; ver0="${ver0:-0}"
  start="$(jv "$tmp/first" 'b.data[0].startsAt')"
  book_body="$(printf '{"doctorId":208,"typeId":%s,"startsAt":"%s","complaintText":"Synthetic availability QA visit","patientTimezone":"UTC"}' "$type_id" "$start")"
  new_key; call POST /api/consultations "$patient" "$book_body" "$NEW_KEY"
  [ "$status" = 201 ] || fail "(b) booking returned $status: $(head -c 300 "$tmp/body")"
  rid_echoed || fail '(b) booking did not echo X-Request-Id'
  cid="$(jv "$tmp/body" 'b.data.id')"
  ver1="$(rds get slots-ver:208)"; ver1="${ver1:-0}"
  [ "$ver1" -gt "$ver0" ] || fail "(b) slots-ver:208 did not increment on booking ($ver0 -> $ver1)"
  slots_get "$patient"; [ "$status" = 200 ] && rid_echoed || fail "(b) slots after booking: status $status"
  [ "$(jv "$tmp/body" "b.data.some(x=>x.startsAt==='$start')")" = false ] || fail '(b) booked start is still listed'
  [ "$(jv "$tmp/body" 'b.data.length')" = 3 ] || fail "(b) expected 3 slots after booking, got $(jv "$tmp/body" 'b.data.length')"
  ok "S1 (b) booking 201 (id $cid), slots-ver:208 $ver0 -> $ver1, booked start no longer listed (3 slots)"

  # (c) cancel through the API: slot reappears, version incremented again
  new_key; call PATCH "/api/consultations/$cid/cancel" "$patient" '{"reason":"Synthetic QA cancel"}' "$NEW_KEY"
  [ "$status" = 200 ] || fail "(c) cancel returned $status: $(head -c 300 "$tmp/body")"
  rid_echoed || fail '(c) cancel did not echo X-Request-Id'
  ver2="$(rds get slots-ver:208)"; ver2="${ver2:-0}"
  [ "$ver2" -gt "$ver1" ] || fail "(c) slots-ver:208 did not increment on cancel ($ver1 -> $ver2)"
  slots_get "$patient"; [ "$status" = 200 ] && rid_echoed || fail "(c) slots after cancel: status $status"
  [ "$(jv "$tmp/body" "b.data.some(x=>x.startsAt==='$start')")" = true ] || fail '(c) cancelled start did not reappear'
  [ "$(jv "$tmp/body" 'b.data.length')" = 4 ] || fail '(c) expected 4 slots after cancel'
  ok "S1 (c) cancel 200, slots-ver:208 $ver1 -> $ver2, start listed again (4 slots)"

  # (d) request id echo was asserted on every call above; also on a cache-hit admin read
  slots_get "$admin"; [ "$status" = 200 ] && rid_echoed || fail '(d) admin cached read: no X-Request-Id echo'
  ok 'S1 (d) X-Request-Id echoed on every call in (a)-(c) and on an admin cached read'

  # Cache must not be served once the doctor stops being bookable (404 checks run before the cache read, AV-R9).
  [ -n "$(rds keys 'slots:208:')" ] || fail 'expected a slots:208:* key before the non-bookable check'
fi

sql "UPDATE doctor_profiles SET is_accepting_patients = false WHERE id = $profile_id" >/dev/null
check 'non-bookable doctor (cache key present when Redis is up)' 404 NotFound "$admin" "$type_id" "$from" "$to"
printf 'Slice 1: %s cases passed so far\n' "$passed"

# ================================================================================================================================
# Slice 2 fixture
#   8201 fee 300 yrs 10 ar,en  spec a            hours 08:00-12:00 daily        types: 30
#   8202 fee 100 yrs  3 ar     spec a            hours 14:00-18:00 daily        types: 30
#   8203 fee 200 yrs 20 en     spec a(p) + b     hours 20:00-22:00 daily        types: 60, 30, 15 (inactive)  shortest active = 30
#   8204 fee 200 yrs 10 ar     spec a(p) + b     hours 20:00-22:00 daily        types: 30   (ties with 8203 on earliest and fee)
#   8205 fee 150 yrs  5 ar     spec a            NO working hours               types: 30   (bookable, known-none)
#   8206 fee 150 yrs  6 ar     spec a            not accepting patients         (non-bookable)
#   8207 fee 150 yrs  7 ar     spec a            suspended                      (non-bookable)
#   8208 fee 120 yrs  8 ar     spec a            hours 10:00-11:00 daily        types: 30
#   8210-8234 (25 doctors)     spec c            hours 08:00-17:00 daily        types: 30   (inline-miss cap fixture)
# ================================================================================================================================
echo
echo '== slice 2: fixture =='
reset_fixture2
[ -z "$REDIS_URL" ] || { rds cleanup82 >/dev/null; rds cleanupnames >/dev/null; }
sql "INSERT INTO specialties (slug, name, is_active) VALUES ('qa-avail-a','QA Availability A',true),('qa-avail-b','QA Availability B',true),('qa-avail-c','QA Availability C',true);
INSERT INTO doctor_profiles (user_id, headline, years_experience, consultation_fee, currency, default_slot_minutes, timezone, is_accepting_patients, verification_status, identity_sync_status, decided_at, suspended_at, suspension_reason) VALUES
 (8201,'QA Alpha Cardiology',10,300,'EGP',30,'UTC',true,'approved','synced',NOW(),NULL,NULL),
 (8202,'QA Beta Cardiology',3,100,'EGP',30,'UTC',true,'approved','synced',NOW(),NULL,NULL),
 (8203,'QA Gamma Dermatology',20,200,'EGP',30,'UTC',true,'approved','synced',NOW(),NULL,NULL),
 (8204,'QA Delta Dermatology',10,200,'EGP',30,'UTC',true,'approved','synced',NOW(),NULL,NULL),
 (8205,'QA Epsilon Without Hours',5,150,'EGP',30,'UTC',true,'approved','synced',NOW(),NULL,NULL),
 (8206,'QA Zeta Not Accepting',6,150,'EGP',30,'UTC',false,'approved','synced',NOW(),NULL,NULL),
 (8207,'QA Eta Suspended',7,150,'EGP',30,'UTC',true,'approved','synced',NOW(),NOW(),'Synthetic QA suspension'),
 (8208,'QA Theta Cardiology',8,120,'EGP',30,'UTC',true,'approved','synced',NOW(),NULL,NULL);
INSERT INTO doctor_profiles (user_id, headline, years_experience, consultation_fee, currency, default_slot_minutes, timezone, is_accepting_patients, verification_status, identity_sync_status, decided_at, deleted_at) VALUES
 (8240,'QA Sync Pending',4,110,'EGP',30,'UTC',true,'approved','pending',NOW(),NULL),
 (8241,'QA No Active Type',4,110,'EGP',30,'UTC',true,'approved','synced',NOW(),NULL),
 (8242,'QA Soft Deleted',4,110,'EGP',30,'UTC',true,'approved','synced',NOW(),NOW()),
 (8243,'QA Submitted Application',4,110,'EGP',30,'UTC',true,'submitted','not_required',NULL,NULL);
INSERT INTO doctor_profiles (user_id, headline, years_experience, consultation_fee, currency, default_slot_minutes, timezone, is_accepting_patients, verification_status, identity_sync_status, decided_at)
 SELECT 8210 + i, 'QA Cap Doctor ' || i, i % 30, 400 + i, 'EGP', 30, 'UTC', true, 'approved', 'synced', NOW() FROM generate_series(0, 24) AS i;
INSERT INTO working_hours (doctor_profile_id, weekday, start_time, end_time)
 SELECT dp.id, d, v.s::time, v.e::time FROM doctor_profiles dp
 JOIN (VALUES (8201,'08:00','12:00'),(8202,'14:00','18:00'),(8203,'20:00','22:00'),(8204,'20:00','22:00'),(8206,'09:00','10:00'),(8207,'09:00','10:00'),(8208,'10:00','11:00')) v(u,s,e) ON v.u = dp.user_id
 CROSS JOIN generate_series(1,7) d;
INSERT INTO working_hours (doctor_profile_id, weekday, start_time, end_time)
 SELECT dp.id, d, '08:00'::time, '17:00'::time FROM doctor_profiles dp CROSS JOIN generate_series(1,7) d WHERE dp.user_id BETWEEN 8210 AND 8234;
INSERT INTO consultation_types (doctor_profile_id, name, duration_minutes, price, currency, is_active)
 SELECT dp.id, 'Synthetic QA visit', 30, dp.consultation_fee, 'EGP', dp.user_id <> 8241 FROM doctor_profiles dp WHERE (dp.user_id BETWEEN 8201 AND 8234 AND dp.user_id <> 8203) OR dp.user_id IN (8240, 8241, 8242, 8243);
INSERT INTO consultation_types (doctor_profile_id, name, duration_minutes, price, currency, is_active)
 SELECT dp.id, v.n, v.m, 200, 'EGP', v.a FROM doctor_profiles dp, (VALUES ('Synthetic QA long',60,true),('Synthetic QA short',30,true),('Synthetic QA retired',15,false)) v(n,m,a) WHERE dp.user_id = 8203;
INSERT INTO doctor_languages (doctor_profile_id, language_code)
 SELECT dp.id, l.c FROM doctor_profiles dp JOIN (VALUES (8201,'en'),(8201,'ar'),(8202,'ar'),(8203,'en'),(8204,'ar'),(8205,'ar'),(8206,'ar'),(8207,'ar'),(8208,'ar')) l(u,c) ON l.u = dp.user_id;
INSERT INTO doctor_specialties (doctor_profile_id, specialty_id, is_primary)
 SELECT dp.id, (SELECT id FROM specialties WHERE slug = 'qa-avail-a'), true FROM doctor_profiles dp WHERE dp.user_id BETWEEN 8201 AND 8208 OR dp.user_id IN (8240, 8241, 8242, 8243);
INSERT INTO working_hours (doctor_profile_id, weekday, start_time, end_time)
 SELECT dp.id, d, '08:00'::time, '12:00'::time FROM doctor_profiles dp CROSS JOIN generate_series(1,7) d WHERE dp.user_id IN (8240, 8241, 8242, 8243);
INSERT INTO patient_profiles (user_id, timezone) VALUES (8301, 'Asia/Tokyo');
INSERT INTO doctor_specialties (doctor_profile_id, specialty_id, is_primary)
 SELECT dp.id, (SELECT id FROM specialties WHERE slug = 'qa-avail-b'), false FROM doctor_profiles dp WHERE dp.user_id IN (8203, 8204);
INSERT INTO doctor_specialties (doctor_profile_id, specialty_id, is_primary)
 SELECT dp.id, (SELECT id FROM specialties WHERE slug = 'qa-avail-c'), true FROM doctor_profiles dp WHERE dp.user_id BETWEEN 8210 AND 8234;" >/dev/null

# profile ids + shortest active type per doctor (oracle inputs)
declare -A TYPE_OF PID_OF
while IFS='|' read -r u p; do PID_OF[$u]="$p"; done < <(sql "SELECT user_id, id FROM doctor_profiles WHERE user_id BETWEEN 8201 AND 8208")
while IFS='|' read -r u t; do TYPE_OF[$u]="$t"; done < <(sql "SELECT DISTINCT ON (dp.user_id) dp.user_id, ct.id FROM doctor_profiles dp JOIN consultation_types ct ON ct.doctor_profile_id = dp.id WHERE ct.is_active AND dp.user_id BETWEEN 8201 AND 8208 ORDER BY dp.user_id, ct.duration_minutes, ct.id")
node -e '
const [fees, years, pids] = [process.argv[1], process.argv[2], process.argv[3]].map((s) => Object.fromEntries(s.split(",").map((p) => p.split(":"))));
const meta = {}; for (const u of Object.keys(fees)) meta[u] = { fee: Number(fees[u]), years: Number(years[u]), pid: Number(pids[u]) };
require("fs").writeFileSync(process.argv[4] + "/meta.json", JSON.stringify(meta));' \
  "8201:300,8202:100,8203:200,8204:200,8205:150,8206:150,8207:150,8208:120" "8201:10,8202:3,8203:20,8204:10,8205:5,8206:6,8207:7,8208:8" \
  "$(for u in 8201 8202 8203 8204 8205 8206 8207 8208; do printf '%s:%s,' "$u" "${PID_OF[$u]}"; done | sed 's/,$//')" "$tmp"

# oracle.js: expected orderings and window matches computed from /slots data (an independent path from the rank index)
cat > "$tmp/oracle.js" <<'ORACLE'
const fs = require('fs');
const [dir, cmd, a1, a2, a3] = process.argv.slice(2);
const meta = JSON.parse(fs.readFileSync(dir + '/meta.json', 'utf8'));
const starts = (u) => { try { return JSON.parse(fs.readFileSync(`${dir}/starts-${u}.json`, 'utf8')); } catch { return []; } };
const first = (u) => { const s = starts(u); return s.length ? Math.min(...s) : Infinity; };
const parse = (s) => (s || '').split(',').filter(Boolean).map(Number);
const B = 900000;
if (cmd === 'first') { const f = first(Number(a1)); process.stdout.write(f === Infinity ? '' : String(f)); }
else if (cmd === 'order') { // order <sort> <ids>
  const ids = parse(a2);
  const key = { earliest_availability: (u) => [first(u), meta[u].pid], price: (u) => [meta[u].fee, meta[u].pid], experience: (u) => [-meta[u].years, -meta[u].pid] }[a1];
  const cmp = (p, q) => (p === q ? 0 : p < q ? -1 : 1);
  ids.sort((x, y) => { const kx = key(x), ky = key(y); return cmp(kx[0], ky[0]) || cmp(kx[1], ky[1]); });
  process.stdout.write(ids.join(','));
} else if (cmd === 'window') { // window <fromMs> <toMs> <ids>
  const [f, t] = [Number(a1), Number(a2)];
  process.stdout.write(parse(a3).filter((u) => starts(u).some((s) => { const b = Math.floor(s / B); return b * B < t && (b + 1) * B > f; })).join(','));
}
ORACLE
oracle() { node "$tmp/oracle.js" "$tmp" "$@"; }

# fetch_oracle <user...>: all free slot starts of the shortest active type in [now, now+14d] via the slice-1 route, as admin
fetch_oracle() {
  local u f t
  for u in "$@"; do
    read -r f t < <(node -e 'const n=Date.now()+1000;console.log(new Date(n).toISOString(),new Date(n+14*864e5).toISOString())')
    call GET "/api/doctors/$u/slots?typeId=${TYPE_OF[$u]}&from=$f&to=$t" "$admin"
    if [ "$status" = 200 ]; then jv "$tmp/body" 'JSON.stringify(b.data.map(x=>Date.parse(x.startsAt)))' > "$tmp/starts-$u.json"; else echo '[]' > "$tmp/starts-$u.json"; fi
  done
}

# tokens
doc8201="$(mint doctor-8201)"; doc8202="$(mint doctor-8202)"; patient_tokyo="$(mint patient-8301)"
pending_patient="$(mint patient-pending)"; expired="$(mint expired)"

# ---- request pacing: search and profile routes have their own 60/min per IP and 120/min per user limiters ------------------------
SEARCH_N=0; PROFILE_N=0
pace() { # pace <path>
  local kind=""
  case "$1" in
    /api/doctors|/api/doctors\?*) SEARCH_N=$((SEARCH_N+1)); kind=search; n=$SEARCH_N;;
    /api/doctors/*) PROFILE_N=$((PROFILE_N+1)); kind=profile; n=$PROFILE_N;;
    *) return 0;;
  esac
  if [ -n "$REDIS_URL" ]; then
    [ $((n % 35)) -ne 0 ] || rds rlreset >/dev/null
  else
    # per-instance fallback limiter: limit / RATE_LIMIT_FALLBACK_DIVISOR (default 2) per window; wait the window out
    if [ $((n % 24)) -eq 0 ]; then echo "(pacing: waiting 62 s for the in-memory $kind limiter window)"; sleep 62; fi
  fi
}
dget() { pace "$1"; call GET "$1" "$2"; }

# assert_resp <label> <expected status> <spec>: spec = error code when status >= 400, else a JS expression over b (envelope success checked)
assert_resp() {
  local label="$1" want="$2" spec="${3:-}" why=""
  [ "$status" = "$want" ] || why="status $status (want $want)"
  rid_echoed || why="${why:+$why; }X-Request-Id not echoed"
  if [ -z "$why" ]; then
    if [ "$want" -ge 400 ]; then
      jt "$tmp/body" "b.success===false && b.error.code==='$spec' && b.error.requestId==='$rid' && Array.isArray(b.error.details)" || why="error envelope or code (want $spec): $(head -c 160 "$tmp/body")"
    elif [ -n "$spec" ]; then
      jt "$tmp/body" "b.success===true && ($spec)" || why="body check failed: $spec"
    fi
  fi
  if [ -z "$why" ]; then ok "$label ($status${spec:+ ${spec:0:60}})"; else bad "$label: $why"; fi
}
# t <label> <path> <token> <status> <spec>
t() { dget "$2" "$3"; assert_resp "$1" "$4" "${5:-}"; }
# tids <label> <path> <token> <expected ids csv> [extra js]  -> 200 with data ids exactly (in order) and extra JS true
tids() {
  dget "$2" "$3"
  assert_resp "$1" 200 "b.data.map(x=>x.userId).join(',')==='$4'${5:+ && ($5)}"
}
# degraded expectation for the current mode: degr <earliest-sort 0|1> <window 0|1> <name 0|1> -> JSON array or null
degr() {
  local parts=()
  if [ -z "$REDIS_URL" ]; then
    [ "$1" != 1 ] || parts+=('"sort"')
    [ "$2" != 1 ] || parts+=('"availabilityFilter"')
  fi
  [ "$3" != 1 ] || parts+=('"nameFilter"')
  if [ "${#parts[@]}" -eq 0 ]; then echo null; else (IFS=,; echo "[${parts[*]}]"); fi
}
DEG_NONE='JSON.stringify(b.meta.degraded??null)===JSON.stringify(null)'
degjs() { printf 'JSON.stringify(b.meta.degraded??null)===JSON.stringify(%s)' "$1"; }
# effective sort in this mode (Redis down serves earliest_availability in price order)
eff() { if [ -z "$REDIS_URL" ] && [ "$1" = earliest_availability ]; then echo price; else echo "$1"; fi; }

MAIN='specialty=qa-avail-a'
ALL8='8201,8202,8203,8204,8205,8208'          # bookable members of spec a
fetch_oracle 8201 8202 8203 8204 8205 8208
EO="$(oracle order earliest_availability "$ALL8")"      # expected earliest order
PO="$(oracle order price "$ALL8")"                      # expected price order
XO="$(oracle order experience "$ALL8")"                 # expected experience order
echo "oracle: earliest=$EO price=$PO experience=$XO"
[ "$PO" = '8202,8208,8205,8203,8204,8201' ] && [ "$XO" = '8203,8204,8201,8208,8205,8202' ] || { echo "unexpected oracle fee/experience order"; exit 1; }

# ================================================================================================================================
echo; echo '== slice 2: RBAC, envelope, shape =='
t 'search: unauthenticated' "/api/doctors?$MAIN" '' 401 Unauthorized
t 'search: expired token' "/api/doctors?$MAIN" "$expired" 401 TokenExpired
t 'search: doctor role is denied' "/api/doctors?$MAIN" "$doctor" 403 Forbidden
t 'search: patient with non-active token status is denied' "/api/doctors?$MAIN" "$pending_patient" 403 Forbidden
t 'profile: unauthenticated' '/api/doctors/8201' '' 401 Unauthorized
t 'profile: doctor role is denied' '/api/doctors/8201' "$doctor" 403 Forbidden
t 'profile: patient reaching /doctors/me gets the doctors router 403' '/api/doctors/me' "$patient" 403 Forbidden

dget "/api/doctors?$MAIN&sort=price&limit=100" "$patient"
assert_resp 'search: patient 200, exactly the 6 bookable doctors (suspended and not-accepting excluded)' 200 \
  "b.data.map(x=>x.userId).join(',')==='$PO' && b.meta.count===6 && b.meta.hasMore===false && b.meta.nextCursor===null"
# DoctorProfile shape (contract): required fields present, no admin/verification/slot-preview fields on search items
assert_resp 'search: item shape matches DoctorProfile and leaks no verification, suspension, status or slot-preview field' 200 \
  "b.data.every(x=>['userId','headline','bio','yearsExperience','languages','specialties','consultationFee','timezone','isAcceptingPatients','nextAvailableAt','consultationTypes','displayName','avatarUrl','profileHydrated'].every(k=>k in x) && !('status' in x) && !('nextAvailableSlots' in x) && !('verificationStatus' in x) && !('identitySyncStatus' in x) && !('suspendedAt' in x) && !('defaultSlotMinutes' in x) && x.consultationFee.currency==='EGP' && Number.isInteger(x.consultationFee.amount) && x.languages.join()===[...x.languages].sort().join() && x.consultationTypes.every(c=>c.isActive===true))"
assert_resp 'search: 8203 lists only its active types, primary specialty first, languages sorted' 200 \
  "(()=>{const d=b.data.find(x=>x.userId===8203);return d.consultationTypes.length===2 && d.consultationTypes.every(c=>[30,60].includes(c.durationMinutes)) && d.specialties[0].slug==='qa-avail-a' && d.specialties[0].isPrimary===true && d.specialties.length===2;})()"
t 'search: admin 200 with the same set' "/api/doctors?$MAIN&sort=price&limit=100" "$admin" 200 "b.data.map(x=>x.userId).join(',')==='$PO' && b.data.every(x=>!('status' in x))"

# ================================================================================================================================
echo; echo '== slice 2: sorts, default sort, cursors and page 2 =='
SORT_E="$(eff earliest_availability)"
tids 'sort=earliest_availability' "/api/doctors?$MAIN&sort=earliest_availability&limit=100" "$patient" "$(oracle order "$SORT_E" "$ALL8")" "$(degjs "$(degr 1 0 0)")"
tids 'default sort equals earliest_availability' "/api/doctors?$MAIN&limit=100" "$patient" "$(oracle order "$SORT_E" "$ALL8")" "$(degjs "$(degr 1 0 0)")"
tids 'sort=price (fee ASC, ties by id)' "/api/doctors?$MAIN&sort=price&limit=100" "$patient" "$PO" "$DEG_NONE"
tids 'sort=experience (years DESC, ties by id DESC)' "/api/doctors?$MAIN&sort=experience&limit=100" "$patient" "$XO" "$DEG_NONE"
t 'sort=bogus -> 400' "/api/doctors?$MAIN&sort=bogus" "$patient" 400 ValidationFailed

# nextAvailableAt: equals the first free slot of the shortest active type (oracle); the known-none doctor is null and ranks last
dget "/api/doctors?$MAIN&limit=100" "$patient"
ok_first=1
for u in 8201 8202 8203 8204 8208; do
  want="$(oracle first "$u")"; got="$(jv "$tmp/body" "(()=>{const d=b.data.find(x=>x.userId===$u);return d.nextAvailableAt===null?'':Date.parse(d.nextAvailableAt)})()")"
  [ "$want" = "$got" ] || { ok_first=0; echo "  nextAvailableAt mismatch for $u: oracle=$want search=$got"; }
done
if [ "$ok_first" = 1 ] && jt "$tmp/body" "b.data.find(x=>x.userId===8205).nextAvailableAt===null"; then ok 'search: nextAvailableAt equals the oracle first free slot for 5 doctors; the doctor without hours has null'; else bad 'search: nextAvailableAt does not match the oracle'; fi
if [ -n "$REDIS_URL" ]; then
  assert_resp 'search (Redis up): the doctor with no slot (known-none) ranks last' 200 "b.data[b.data.length-1].userId===8205 && b.data[b.data.length-1].nextAvailableAt===null"
fi

# page walk with limit=2 for each sort: concatenated pages == the full order, hasMore exact, count <= limit, nextCursor null at the end
walk() { # walk <sort> <expected order> <earliest-sort 0|1> ; also exercises "page 2 via nextCursor"
  local sort="$1" want="$2" cursor="" got="" pages=0 flags=""
  while :; do
    local path="/api/doctors?$MAIN&sort=$sort&limit=2${cursor:+&cursor=$cursor}"
    dget "$path" "$patient"
    [ "$status" = 200 ] || { bad "walk $sort page $((pages+1)): status $status $(head -c 150 "$tmp/body")"; return; }
    rid_echoed || flags="${flags}rid;"
    jt "$tmp/body" "b.meta.count===b.data.length && b.data.length<=2 && b.meta.hasMore===(b.meta.nextCursor!==null)" || flags="${flags}meta;"
    got="${got:+$got,}$(jv "$tmp/body" 'b.data.map(x=>x.userId).join(",")')"
    pages=$((pages+1))
    [ "$pages" -ne 1 ] || cp "$tmp/body" "$tmp/page1-$sort"
    [ "$pages" -ne 2 ] || cp "$tmp/body" "$tmp/page2-$sort"
    cursor="$(jv "$tmp/body" 'b.meta.nextCursor??""')"
    [ -n "$cursor" ] || break
    [ "$pages" -lt 10 ] || { flags="${flags}runaway;"; break; }
  done
  if [ "$got" = "$want" ] && [ "$pages" = 3 ] && [ -z "$flags" ] && jt "$tmp/body" "b.meta.hasMore===false && b.meta.nextCursor===null"; then ok "pagination limit=2 sort=$sort: 3 pages, ids $got, hasMore/nextCursor exact, request id echoed"; else bad "pagination sort=$sort: got '$got' (want '$want') pages=$pages flags=$flags"; fi
}
walk earliest_availability "$(oracle order "$SORT_E" "$ALL8")"
walk price "$PO"
walk experience "$XO"
t 'limit=0 -> 400' "/api/doctors?$MAIN&limit=0" "$patient" 400 ValidationFailed
t 'limit=101 -> 400' "/api/doctors?$MAIN&limit=101" "$patient" 400 ValidationFailed
t 'limit=abc -> 400' "/api/doctors?$MAIN&limit=abc" "$patient" 400 ValidationFailed
t 'limit=100 -> 200' "/api/doctors?$MAIN&limit=100" "$patient" 200 'b.data.length===6'

# cursors: tamper, garbage, wrong sort
c1="$(jv "$tmp/page1-price" 'b.meta.nextCursor')"
tampered="${c1:0:3}$([ "${c1:3:1}" = A ] && echo B || echo A)${c1:4}"
t 'cursor: tampered payload -> 400' "/api/doctors?$MAIN&sort=price&limit=2&cursor=$tampered" "$patient" 400 ValidationFailed
t 'cursor: garbage -> 400' "/api/doctors?$MAIN&sort=price&limit=2&cursor=not-a-cursor" "$patient" 400 ValidationFailed
t 'cursor from sort=price replayed on sort=experience -> 400' "/api/doctors?$MAIN&sort=experience&limit=2&cursor=$c1" "$patient" 400 ValidationFailed
assert_resp_cursor_detail() { jt "$tmp/body" "b.error.details.some(d=>d.field==='cursor')" && ok 'cursor mismatch names the cursor field in details' || bad "cursor mismatch details: $(head -c 200 "$tmp/body")"; }
assert_resp_cursor_detail
t 'cursor is a position, not a grant: a price cursor from one filter set is accepted on another (200, never 5xx)' "/api/doctors?specialty=qa-avail-b&sort=price&limit=2&cursor=$c1" "$patient" 200 'Array.isArray(b.data)'
c_exp="$(jv "$tmp/page1-experience" 'b.meta.nextCursor')"
t 'cursor from experience replayed on price -> 400' "/api/doctors?$MAIN&sort=price&limit=2&cursor=$c_exp" "$patient" 400 ValidationFailed
if [ -n "$REDIS_URL" ]; then
  c_e="$(jv "$tmp/page1-earliest_availability" 'b.meta.nextCursor')"
  t 'cursor from earliest_availability replayed on price -> 400' "/api/doctors?$MAIN&sort=price&limit=2&cursor=$c_e" "$patient" 400 ValidationFailed
  [ -z "$CURSOR_FILE" ] || { grep -v '^EARLIEST_CURSOR=' "$CURSOR_FILE" 2>/dev/null > "$tmp/cursors" || true; echo "EARLIEST_CURSOR=$c_e" >> "$tmp/cursors"; cp "$tmp/cursors" "$CURSOR_FILE"; }
  if [ -n "$DEGRADED_CURSOR" ]; then
    t 'cursor issued while Redis was down (meta.degraded sort) is 400 on a healthy server (restart the list)' "/api/doctors?$MAIN&limit=2&cursor=$DEGRADED_CURSOR" "$patient" 400 ValidationFailed
    jt "$tmp/body" "b.error.details.some(d=>d.field==='cursor')" && ok 'degraded-cursor rejection names the cursor field' || bad "degraded cursor details: $(head -c 200 "$tmp/body")"
  else
    skip 'degraded-mode cursor on a healthy server: DEGRADED_CURSOR not set (export it from a Redis-down run)'
  fi
fi
t 'unknown query parameter -> 400' "/api/doctors?$MAIN&foo=1" "$patient" 400 ValidationFailed

# ================================================================================================================================
echo; echo '== slice 2: filters =='
tids 'specialty=qa-avail-b -> 8203, 8204 (earliest/price order with ties by id)' "/api/doctors?specialty=qa-avail-b&sort=price&limit=100" "$patient" '8203,8204'
tids 'specialty=unknown-slug -> 200 empty' "/api/doctors?specialty=no-such-qa-slug&limit=100" "$patient" '' 'b.meta.count===0 && b.meta.hasMore===false'
t 'specialty empty value -> 400' "/api/doctors?specialty=" "$patient" 400 ValidationFailed
tids 'language=en within spec a -> 8203, 8201 (price order)' "/api/doctors?$MAIN&language=en&sort=price&limit=100" "$patient" '8203,8201'
tids 'language=fr -> empty' "/api/doctors?$MAIN&language=fr&limit=100" "$patient" ''
t 'language=EN (uppercase) -> 400' "/api/doctors?$MAIN&language=EN" "$patient" 400 ValidationFailed
t 'language=eng -> 400' "/api/doctors?$MAIN&language=eng" "$patient" 400 ValidationFailed
tids 'minFee=150&maxFee=200 inclusive -> 8205, 8203, 8204' "/api/doctors?$MAIN&minFee=150&maxFee=200&sort=price&limit=100" "$patient" '8205,8203,8204'
tids 'minFee=100&maxFee=100 -> 8202' "/api/doctors?$MAIN&minFee=100&maxFee=100&sort=price&limit=100" "$patient" '8202'
tids 'minFee=301 -> empty' "/api/doctors?$MAIN&minFee=301&limit=100" "$patient" ''
t 'minFee > maxFee -> 400 naming minFee' "/api/doctors?$MAIN&minFee=300&maxFee=100" "$patient" 400 ValidationFailed
jt "$tmp/body" "b.error.details.some(d=>d.field==='minFee')" && ok 'minFee > maxFee: details[].field = minFee' || bad "minFee>maxFee details: $(head -c 200 "$tmp/body")"
t 'minFee=-1 -> 400' "/api/doctors?$MAIN&minFee=-1" "$patient" 400 ValidationFailed
t 'minFee=abc -> 400' "/api/doctors?$MAIN&minFee=abc" "$patient" 400 ValidationFailed
t 'maxFee above int range -> 400' "/api/doctors?$MAIN&maxFee=2147483648" "$patient" 400 ValidationFailed
tids 'combined: spec a + language ar + fee 100..150 -> 8202, 8208, 8205' "/api/doctors?$MAIN&language=ar&minFee=100&maxFee=150&sort=price&limit=100" "$patient" '8202,8208,8205'
# name, before any sweep: Redis up -> the name index is absent (deleted at the fixture start), Redis down -> unusable; either way the filter is
# headline-only and meta.degraded carries nameFilter (AV-R27). The index-backed cases are the slice 3 section below.
if [ -n "$REDIS_URL" ]; then
  [ -z "$(rds keys 'name-index')" ] && ok 'name index is absent before the first sweep (no name-index* key)' || bad 'name-index* key present before the first sweep'
fi
tids 'name=QA Alpha (headline prefix, case-insensitive) -> 8201; index absent (up) or Redis unusable (down): meta.degraded nameFilter' "/api/doctors?$MAIN&name=qa%20alpha&limit=100" "$patient" '8201' "$(degjs "$(degr 1 0 1)")"
tids 'name with repeated and surrounding spaces is trimmed and collapsed -> 8201' "/api/doctors?$MAIN&name=%20%20qa%20%20%20alpha%20&limit=100" "$patient" '8201'
tids 'name=QA%20ALPHA upper case -> 8201' "/api/doctors?$MAIN&name=QA%20ALPHA&limit=100" "$patient" '8201'
tids 'name=cardiology is not a prefix -> empty; headline-only fallback keeps degraded nameFilter' "/api/doctors?$MAIN&name=cardiology&limit=100" "$patient" '' "$(degjs "$(degr 1 0 1)")"
tids 'name on the Identity display name before any sweep: headline-only fallback -> empty + nameFilter' "/api/doctors?$MAIN&name=synthetic%20qa%20doctor&limit=100" "$patient" '' "$(degjs "$(degr 1 0 1)")"
t 'name of one character -> 400' "/api/doctors?$MAIN&name=a" "$patient" 400 ValidationFailed
t 'name with a control character -> 400' "/api/doctors?$MAIN&name=qa%0Aalpha" "$patient" 400 ValidationFailed
t 'name of 101 characters -> 400' "/api/doctors?$MAIN&name=$(printf 'a%.0s' $(seq 1 101))" "$patient" 400 ValidationFailed
t 'name with only spaces -> 400' "/api/doctors?$MAIN&name=%20%20%20" "$patient" 400 ValidationFailed

t 'search: duplicate sort parameter -> 400 (array rejected)' "/api/doctors?$MAIN&sort=price&sort=experience" "$patient" 400 ValidationFailed
t 'search: duplicate language parameter -> 400' "/api/doctors?$MAIN&language=ar&language=en" "$patient" 400 ValidationFailed
t 'search: cursor longer than 1024 characters -> 400' "/api/doctors?$MAIN&cursor=$(printf 'a%.0s' $(seq 1 1100))" "$patient" 400 ValidationFailed
tids 'search: SQL metacharacters in specialty are bound, not executed -> empty 200' "/api/doctors?specialty=%27%20OR%201%3D1%20--&limit=100" "$patient" ''
tids 'search: non-ASCII name prefix (2 code points) -> empty 200 with the headline-only nameFilter marker' "/api/doctors?$MAIN&name=%D8%A7%D9%84&limit=100" "$patient" '' "$(degjs "$(degr 1 0 1)")"
tids 'search: candidate parity -- sync pending, no active type, soft-deleted, submitted doctors (8240-8243, spec a) are absent' "/api/doctors?$MAIN&sort=price&limit=100" "$patient" "$PO" "b.data.every(x=>x.userId<8240)"

# ---- availability window filter ---------------------------------------------------------------------------------------------------
echo; echo '== slice 2: availableFrom / availableTo =='
W_NOTE=$([ -n "$REDIS_URL" ] && echo exact || echo ignored)
iso_ms() { node -e 'process.stdout.write(String(Date.parse(process.argv[1])))' "$1"; }
win_expect() { # win_expect <fromISO|""> <toISO|"">: expected ids in the mode (Redis up: oracle; down: window ignored -> every candidate)
  local f t nowms
  if [ -z "$REDIS_URL" ]; then oracle order "$(eff earliest_availability)" "$ALL8"; return; fi
  nowms="$(node -e 'process.stdout.write(String(Date.now()))')"
  f="${1:+$(iso_ms "$1")}"; f="${f:-$nowms}"
  t="${2:+$(iso_ms "$2")}"; t="${t:-$((f + 14*86400000))}"
  oracle window "$f" "$t" "$ALL8"
}
win_order() { oracle order "$(eff earliest_availability)" "$1"; }
q_from="${tomorrow}T21:30:00Z"; q_to="${tomorrow}T22:30:00Z"
exp="$(win_order "$(win_expect "$q_from" "$q_to")")"
tids "window [tomorrow 21:30, 22:30) (${W_NOTE}) -> ${exp}" "/api/doctors?$MAIN&availableFrom=$q_from&availableTo=$q_to&limit=100" "$patient" "$exp" "$(degjs "$(degr 1 1 0)")"
if [ -n "$REDIS_URL" ]; then
  [ "$exp" = '8203,8204' ] && ok 'window 21:30-22:30: exactly the two doctors free from 20:00-22:00' || bad "window 21:30-22:30 expected 8203,8204 got $exp"
  tids 'window [21:30, 21:45): the 21:30 start lies in this 15-minute bucket -> 8203, 8204' "/api/doctors?$MAIN&availableFrom=${tomorrow}T21:30:00Z&availableTo=${tomorrow}T21:45:00Z&limit=100" "$patient" '8203,8204'
  tids 'window [21:45, 22:30): no start in any overlapping bucket -> empty (exact to 15 minutes)' "/api/doctors?$MAIN&availableFrom=${tomorrow}T21:45:00Z&availableTo=${tomorrow}T22:30:00Z&limit=100" "$patient" ''
  tids 'window with a +02:00 offset (23:30+02:00 = 21:30Z) equals the UTC window' "/api/doctors?$MAIN&availableFrom=${tomorrow}T23:30:00%2B02:00&availableTo=${tomorrow}T23:45:00%2B02:00&limit=100" "$patient" '8203,8204'
  tids 'window + sort=price keeps the window and orders by price (tie by id)' "/api/doctors?$MAIN&availableFrom=$q_from&availableTo=$q_to&sort=price&limit=100" "$patient" '8203,8204'
fi
exp="$(win_order "$(win_expect "$q_from" "")")"
tids "availableFrom only (tomorrow 21:30; to = from + 14 d clipped to now + 14 d) -> ${exp}" "/api/doctors?$MAIN&availableFrom=$q_from&limit=100" "$patient" "$exp" "$(degjs "$(degr 1 1 0)")"
to_only="${tomorrow}T09:15:00Z"
exp="$(win_order "$(win_expect "" "$to_only")")"
tids "availableTo only (tomorrow 09:15; from = now) -> ${exp}" "/api/doctors?$MAIN&availableTo=$to_only&limit=100" "$patient" "$exp" "$(degjs "$(degr 1 1 0)")"
far_to="$(node -e 'process.stdout.write(new Date(Date.now()+13*864e5).toISOString())')"
exp="$(win_order "$(win_expect "" "$far_to")")"
tids "availableTo = now + 13 days -> every doctor with a slot (${exp})" "/api/doctors?$MAIN&availableTo=$far_to&limit=100" "$patient" "$exp"
# page 2 under a window filter (path B): limit=1 over the matching set
if [ -n "$REDIS_URL" ]; then
  dget "/api/doctors?$MAIN&availableTo=$far_to&limit=2" "$patient"; wc1="$(jv "$tmp/body" 'b.meta.nextCursor')"
  dget "/api/doctors?$MAIN&availableTo=$far_to&limit=2&cursor=$wc1" "$patient"
  want2="$(win_order "$(win_expect "" "$far_to")" | cut -d, -f3,4)"
  assert_resp 'window filter: page 2 via nextCursor continues the same order' 200 "b.data.map(x=>x.userId).join(',')==='$want2'"
fi
# 400s
past="2020-01-01T00:00:00Z"
t 'availableFrom in the past -> 400' "/api/doctors?$MAIN&availableFrom=$past" "$patient" 400 ValidationFailed
jt "$tmp/body" "b.error.details.some(d=>d.field==='availableFrom')" && ok 'availableFrom past: details[].field = availableFrom' || bad "availableFrom detail: $(head -c 200 "$tmp/body")"
t 'availableTo in the past (from defaults to now) -> 400' "/api/doctors?$MAIN&availableTo=$past" "$patient" 400 ValidationFailed
beyond="$(node -e 'process.stdout.write(new Date(Date.now()+15*864e5).toISOString())')"
t 'availableFrom beyond now + 14 d -> 400' "/api/doctors?$MAIN&availableFrom=$beyond" "$patient" 400 ValidationFailed
t 'availableTo beyond now + 14 d -> 400' "/api/doctors?$MAIN&availableTo=$beyond" "$patient" 400 ValidationFailed
t 'availableTo equal to availableFrom -> 400' "/api/doctors?$MAIN&availableFrom=$q_from&availableTo=$q_from" "$patient" 400 ValidationFailed
t 'availableTo before availableFrom -> 400' "/api/doctors?$MAIN&availableFrom=$q_to&availableTo=$q_from" "$patient" 400 ValidationFailed
t 'availableFrom without an offset -> 400' "/api/doctors?$MAIN&availableFrom=${tomorrow}T21:30:00" "$patient" 400 ValidationFailed
t 'availableFrom not a date -> 400' "/api/doctors?$MAIN&availableFrom=tomorrow" "$patient" 400 ValidationFailed
t 'availableTo longer than 40 characters -> 400' "/api/doctors?$MAIN&availableTo=${tomorrow}T21:30:00.000000000000000000000000000000Z" "$patient" 400 ValidationFailed
skip 'AV-R16 span > 14 days is unreachable over HTTP (both bounds must lie in [now, now + 14 d]); the exactly-14-day boundary is covered by the unit tests'

# ================================================================================================================================
echo; echo '== slice 2: profile =='
dget '/api/doctors/8201' "$patient"
assert_resp 'profile: patient, bookable doctor -> 200 with nextAvailableSlots <= 5 and no admin status' 200 \
  "b.data.userId===8201 && Array.isArray(b.data.nextAvailableSlots) && b.data.nextAvailableSlots.length===5 && !('status' in b.data) && b.data.nextAvailableAt===b.data.nextAvailableSlots[0].startsAt && b.data.nextAvailableSlots.every(s=>s.startsAt&&s.endsAt&&s.startsAtLocal&&s.endsAtLocal&&s.timezone) && !('verificationStatus' in b.data) && !('suspendedAt' in b.data)"
profile_first="$(jv "$tmp/body" 'Date.parse(b.data.nextAvailableAt)')"
fetch_oracle 8201
[ "$profile_first" = "$(oracle first 8201)" ] && ok 'profile: nextAvailableAt equals the oracle first free slot (exact, not the index)' || bad 'profile: nextAvailableAt differs from the oracle'
dget '/api/doctors/8203' "$patient"
assert_resp 'profile: preview uses the shortest ACTIVE type (30 min of 60/30, inactive 15 ignored); consultationTypes active only' 200 \
  "b.data.nextAvailableSlots.length===5 && b.data.nextAvailableSlots.every(s=>Date.parse(s.endsAt)-Date.parse(s.startsAt)===30*60000) && b.data.consultationTypes.length===2 && b.data.consultationTypes.every(c=>c.isActive)"
t 'profile: patient, not accepting (8206) -> 404' '/api/doctors/8206' "$patient" 404 NotFound
t 'profile: patient, suspended (8207) -> 404' '/api/doctors/8207' "$patient" 404 NotFound
t 'profile: patient, unknown id -> 404' '/api/doctors/8999' "$patient" 404 NotFound
dget '/api/doctors/8201' "$admin"
assert_resp 'profile: admin, bookable -> 200, status=bookable, 5 slots' 200 "b.data.status==='bookable' && b.data.nextAvailableSlots.length===5"
dget '/api/doctors/8206' "$admin"
assert_resp 'profile: admin, non-bookable (not accepting) -> 200, status=not_bookable, empty slots, nextAvailableAt null' 200 \
  "b.data.userId===8206 && b.data.status==='not_bookable' && b.data.nextAvailableSlots.length===0 && b.data.nextAvailableAt===null && b.data.isAcceptingPatients===false && !('suspendedAt' in b.data) && !('suspensionReason' in b.data)"
dget '/api/doctors/8207' "$admin"
assert_resp 'profile: admin, suspended -> 200, status=not_bookable, no suspension field exposed' 200 "b.data.status==='not_bookable' && b.data.nextAvailableSlots.length===0 && !('suspendedAt' in b.data) && !('suspensionReason' in b.data) && !('isSuspended' in b.data)"
dget '/api/doctors/8205' "$admin"
assert_resp 'profile: admin, bookable doctor with no working hours -> bookable, empty slots, null' 200 "b.data.status==='bookable' && b.data.nextAvailableSlots.length===0 && b.data.nextAvailableAt===null"
t 'profile: admin, unknown id -> 404' '/api/doctors/8999' "$admin" 404 NotFound
for u in 8240 8241 8243; do
  t "profile: patient, non-bookable $u (sync pending / no active type / application submitted) -> 404" "/api/doctors/$u" "$patient" 404 NotFound
  t "profile: admin, non-bookable $u -> 200 status=not_bookable with empty preview" "/api/doctors/$u" "$admin" 200 "b.data.status==='not_bookable' && b.data.nextAvailableSlots.length===0 && b.data.nextAvailableAt===null"
done
t 'profile: patient, soft-deleted doctor (8242) -> 404' '/api/doctors/8242' "$patient" 404 NotFound
t 'profile: admin, soft-deleted doctor (8242) -> 404 (live profiles only)' '/api/doctors/8242' "$admin" 404 NotFound
t 'profile: admin, doctor without an active type (8241) lists no consultation types' '/api/doctors/8241' "$admin" 200 'b.data.consultationTypes.length===0'
for bad_id in abc 0 -5 1.5 007x 99999999999999999999999; do
  t "profile: path id '$bad_id' -> 404 (patient)" "/api/doctors/$bad_id" "$patient" 404 NotFound
done
t "profile: path id 'abc' -> 404 (admin)" '/api/doctors/abc' "$admin" 404 NotFound
# timezone
dget '/api/doctors/8201?timezone=Africa/Cairo' "$patient"
assert_resp 'profile: timezone=Africa/Cairo renders slots in that zone (offset +02:00 or +03:00)' 200 \
  "b.data.nextAvailableSlots.every(s=>s.timezone==='Africa/Cairo' && /[+](02|03):00$/.test(s.startsAtLocal) && /Z$/.test(s.startsAt)) && b.data.timezone==='UTC'"
dget '/api/doctors/8201?timezone=Pacific/Auckland' "$admin"
assert_resp 'profile: admin with timezone=Pacific/Auckland renders in that zone' 200 "b.data.nextAvailableSlots.every(s=>s.timezone==='Pacific/Auckland' && /[+](12|13):00$/.test(s.startsAtLocal))"
dget '/api/doctors/8201' "$patient_tokyo"
assert_resp 'profile: no timezone param -> rendered in the patient profile zone (Asia/Tokyo, +09:00)' 200 "b.data.nextAvailableSlots.length===5 && b.data.nextAvailableSlots.every(s=>s.timezone==='Asia/Tokyo' && /[+]09:00$/.test(s.startsAtLocal))"
dget '/api/doctors/8201?timezone=Africa/Cairo' "$patient_tokyo"
assert_resp 'profile: explicit timezone beats the patient profile zone' 200 "b.data.nextAvailableSlots.every(s=>s.timezone==='Africa/Cairo')"
dget '/api/doctors/8201' "$patient"
assert_resp 'profile: patient without a patient profile defaults to UTC' 200 "b.data.nextAvailableSlots.every(s=>s.timezone==='UTC' && /Z$/.test(s.startsAtLocal))"
dget '/api/doctors/8201' "$admin"
assert_resp 'profile: admin (no patient profile) defaults to UTC' 200 "b.data.nextAvailableSlots.every(s=>s.timezone==='UTC' && /Z$/.test(s.startsAtLocal))"
t 'profile: timezone=Invalid/Zone -> 400' '/api/doctors/8201?timezone=Invalid/Zone' "$patient" 400 ValidationFailed
t 'profile: timezone of 65 characters -> 400' "/api/doctors/8201?timezone=$(printf 'a%.0s' $(seq 1 65))" "$patient" 400 ValidationFailed
t 'profile: unknown query parameter -> 400' '/api/doctors/8201?foo=1' "$patient" 400 ValidationFailed
t 'profile: invalid timezone on a non-bookable doctor is still 400 (validation before lookup)' '/api/doctors/8206?timezone=Invalid/Zone' "$patient" 400 ValidationFailed

# ================================================================================================================================
echo; echo '== slice 2: Identity hydration (Case 2) =='
ident() { curl -fsS "$FAKE_IDENTITY_URL/control/$1" >/dev/null; }
identstat() { curl -fsS "$FAKE_IDENTITY_URL/control/stats"; }
flush_identity_cache() { [ -z "$REDIS_URL" ] || rds cleanup82 >/dev/null; }
if curl -fsS "$FAKE_IDENTITY_URL/control/stats" >/dev/null 2>&1; then
  ident reset; flush_identity_cache
  dget "/api/doctors?$MAIN&sort=price&limit=100" "$patient"
  assert_resp 'hydration: names and avatars hydrated, profileHydrated=true' 200 \
    "b.data.every(x=>x.profileHydrated===true && x.displayName==='Synthetic QA Doctor '+x.userId && x.avatarUrl==='https://avatars.example.test/qa/'+x.userId+'.png')"
  identstat > "$tmp/stats"
  jt "$tmp/stats" 'b.userCalls===1 && b.lastIdsCount===6' && ok 'hydration: ONE batched Identity call for the page (6 distinct ids)' || bad "hydration batching: $(cat "$tmp/stats")"
  if [ -n "$REDIS_URL" ]; then
    dget "/api/doctors?$MAIN&sort=price&limit=100" "$patient"; identstat > "$tmp/stats"
    jt "$tmp/stats" 'b.userCalls===1' && ok 'hydration: second identical page is served from the identity:user:* cache (no new Identity call)' || bad "hydration cache: $(cat "$tmp/stats")"
  fi
  # non-active Identity status hides the doctor from search
  ident reset; flush_identity_cache; curl -fsS "$FAKE_IDENTITY_URL/control/user?id=8208&status=suspended" >/dev/null
  dget "/api/doctors?$MAIN&sort=price&limit=100" "$patient"
  assert_resp 'hydration: a doctor whose Identity status is not active is dropped from search (defence in depth), count reflects the drop' 200 \
    "!b.data.some(x=>x.userId===8208) && b.data.length===5 && b.meta.count===5"
  dget '/api/doctors/8208' "$admin"
  assert_resp 'profile: admin still sees the doctor whose Identity status is suspended (status only hides from search)' 200 "b.data.userId===8208"
  ident reset; flush_identity_cache
  # Identity DOWN: connection dropped for the batch call
  curl -fsS "$FAKE_IDENTITY_URL/control/mode?users=down" >/dev/null
  start_ms="$(node -e 'process.stdout.write(String(Date.now()))')"
  dget "/api/doctors?$MAIN&sort=price&limit=100" "$patient"
  took=$(( $(node -e 'process.stdout.write(String(Date.now()))') - start_ms ))
  assert_resp "Identity down: search still 200, displayName/avatarUrl null, profileHydrated=false, doctors, fees and slots intact (${took} ms)" 200 \
    "b.data.length===6 && b.data.every(x=>x.displayName===null && x.avatarUrl===null && x.profileHydrated===false && x.consultationFee.amount>0) && b.data.map(x=>x.userId).join(',')==='$PO'"
  dget '/api/doctors/8201' "$patient"
  assert_resp 'Identity down: profile still 200 with profileHydrated=false and the slot preview' 200 "b.data.profileHydrated===false && b.data.displayName===null && b.data.nextAvailableSlots.length===5"
  [ "$took" -lt 8000 ] && ok "Identity down: search answered within the 8 s sanity bound (${took} ms)" || bad "Identity down: search took ${took} ms"
  # Identity SLOW (> 2 s client timeout)
  curl -fsS "$FAKE_IDENTITY_URL/control/mode?users=slow" >/dev/null; flush_identity_cache
  start_ms="$(node -e 'process.stdout.write(String(Date.now()))')"
  dget "/api/doctors?$MAIN&sort=price&limit=100" "$patient"
  took=$(( $(node -e 'process.stdout.write(String(Date.now()))') - start_ms ))
  assert_resp "Identity slow (4 s): search 200 with profileHydrated=false (${took} ms)" 200 "b.data.length===6 && b.data.every(x=>x.profileHydrated===false)"
  ident reset; flush_identity_cache
  dget "/api/doctors?$MAIN&sort=price&limit=100" "$patient"
  assert_resp 'Identity back up: hydration resumes (no negative caching)' 200 "b.data.every(x=>x.profileHydrated===true)"
else
  skip "hydration cases: $FAKE_IDENTITY_URL/control/stats not served (start scripts/availability-qa-fake-identity.mjs, not the schedules fake)"
fi

# ================================================================================================================================
if [ -n "$REDIS_URL" ]; then
  echo; echo '== slice 2: freshness, index, worker loops (Redis up) =='
  idx_score() { rds raw zscore next-available:index "$1"; }
  in_refresh() { rds raw sismember next-available:refresh "$1"; }
  worker_ready=1; [ -n "${DATABASE_URL:-}" ] || worker_ready=0
  WORKER_LOG_DIR="$tmp"
  worker_once() { # worker_once <loop>; sets wcode
    (cd "$ROOT" && $WORKER_CMD --once "$1" >"$tmp/worker-$1.log" 2>&1) && wcode=0 || wcode=$?
  }

  # --- inline miss cap on a cold index (25 doctors, worker down) ---
  rds cleanup82 >/dev/null
  dget '/api/doctors?specialty=qa-avail-c&sort=earliest_availability&limit=100' "$patient"
  assert_resp "cold index, worker down: 25 doctors returned, exactly ${INLINE_CAP} computed inline (cap), the rest null and last" 200 \
    "b.data.length===25 && b.data.filter(x=>x.nextAvailableAt!==null).length===Math.min(25,$INLINE_CAP) && b.data.slice(Math.min(25,$INLINE_CAP)).every(x=>x.nextAvailableAt===null) && b.data.slice(Math.min(25,$INLINE_CAP)).map(x=>x.userId).join()===b.data.map(x=>x.userId).filter(u=>u>8210+Math.min(25,$INLINE_CAP)-1).join()"
  dget '/api/doctors?specialty=qa-avail-c&sort=earliest_availability&limit=100' "$patient"
  assert_resp 'cold index, second request: the remaining misses are computed (all 25 have nextAvailableAt)' 200 "b.data.length===25 && b.data.every(x=>x.nextAvailableAt!==null)"

  # --- 8 parallel searches on a cold index: all 200 and identical (in-process single-flight, guarded writes) ---
  rds cleanup82 >/dev/null
  pids=()
  for i in 1 2 3 4 5 6 7 8; do
    ( curl -sS -o "$tmp/par-$i.json" -w '%{http_code}' -H "Authorization: Bearer $patient" -H "X-Request-Id: $(uuid)" "$CARE_URL/api/doctors?$MAIN&limit=100" > "$tmp/par-$i.code" 2>/dev/null ) &
    pids+=($!)
  done
  wait "${pids[@]}"
  SEARCH_N=$((SEARCH_N + 8))
  par_ok=1; for i in 1 2 3 4 5 6 7 8; do [ "$(cat "$tmp/par-$i.code")" = 200 ] || par_ok=0; done
  par_same=1; ref="$(jv "$tmp/par-1.json" 'JSON.stringify(b.data.map(x=>[x.userId,x.nextAvailableAt]))')"
  for i in 2 3 4 5 6 7 8; do [ "$(jv "$tmp/par-$i.json" 'JSON.stringify(b.data.map(x=>[x.userId,x.nextAvailableAt]))')" = "$ref" ] || par_same=0; done
  [ "$par_ok" = 1 ] && [ "$par_same" = 1 ] && ok '8 parallel searches on a cold index: all 200 with identical (id, nextAvailableAt) lists' || bad "parallel cold searches: all200=$par_ok identical=$par_same"

  # --- ZSET state after the first full search of spec a ---
  rds cleanup82 >/dev/null
  dget "/api/doctors?$MAIN&limit=100" "$patient"
  s1="$(idx_score 8201)"; s5="$(idx_score 8205)"; s6="$(idx_score 8206)"
  if [ "$s1" = "$(oracle first 8201)" ] && [ "${s5%%.*}" = 1000000000000000 ] && [ -z "$s6" ]; then ok 'index after a lazy search: 8201 score = first slot ms, 8205 = NONE_SCORE (1e15), non-bookable 8206 absent'; else bad "index scores: 8201=$s1 (want $(oracle first 8201)) 8205=$s5 8206=$s6"; fi
  fm="$(rds ttl free-map:8201)"
  { [ "$fm" -gt 0 ] && [ "$fm" -le 600 ]; } && ok "free-map:8201 written with TTL ${fm}s (<= 600)" || bad "free-map:8201 TTL $fm"

  # --- API write -> index entry removed immediately, refresh set holds the doctor, order changes lazily (worker down) ---
  before_first="$(oracle first 8201)"
  ver_b="$(rds get slots-ver:8201)"; ver_b="${ver_b:-0}"
  days=""; for d in 1 2 3 4 5 6 7; do days="${days:+$days,}{\"weekday\":$d,\"intervals\":[{\"startTime\":\"22:00\",\"endTime\":\"23:00\"}]}"; done
  call PUT /api/doctors/me/working-hours "$doc8201" "{\"days\":[$days]}"
  assert_resp 'API: doctor 8201 replaces working hours with 22:00-23:00' 200 'b.data.days.length===7'
  ver_a="$(rds get slots-ver:8201)"; ver_a="${ver_a:-0}"
  if [ "$ver_a" -gt "$ver_b" ] && [ -z "$(idx_score 8201)" ] && [ "$(in_refresh 8201)" = 1 ]; then ok "invalidation: slots-ver:8201 $ver_b -> $ver_a, index member removed, doctor queued in next-available:refresh"; else bad "invalidation state: ver $ver_b->$ver_a score='$(idx_score 8201)' refresh=$(in_refresh 8201)"; fi
  fetch_oracle 8201
  after_first="$(oracle first 8201)"
  [ "$after_first" != "$before_first" ] && ok 'oracle: the first free slot of 8201 moved after the hours change' || bad 'oracle: first slot did not move'
  exp="$(oracle order earliest_availability "$ALL8")"
  tids 'worker down, lazy repair: the very next search shows the new order and the new nextAvailableAt' "/api/doctors?$MAIN&limit=100" "$patient" "$exp" \
    "Date.parse(b.data.find(x=>x.userId===8201).nextAvailableAt)===$after_first"
  [ "$(idx_score 8201)" = "$after_first" ] && ok 'lazy repair wrote the recomputed score back to the index' || bad "lazy repair score $(idx_score 8201) want $after_first"

  # --- refresh loop drains the queue without any search ---
  call PUT /api/doctors/me/working-hours "$doc8201" '{"days":[{"weekday":1,"intervals":[{"startTime":"08:00","endTime":"12:00"}]},{"weekday":2,"intervals":[{"startTime":"08:00","endTime":"12:00"}]},{"weekday":3,"intervals":[{"startTime":"08:00","endTime":"12:00"}]},{"weekday":4,"intervals":[{"startTime":"08:00","endTime":"12:00"}]},{"weekday":5,"intervals":[{"startTime":"08:00","endTime":"12:00"}]},{"weekday":6,"intervals":[{"startTime":"08:00","endTime":"12:00"}]},{"weekday":7,"intervals":[{"startTime":"08:00","endTime":"12:00"}]}]}'
  assert_resp 'API: doctor 8201 restores 08:00-12:00' 200 'b.data.days.length===7'
  fetch_oracle 8201
  if [ "$worker_ready" = 1 ]; then
    [ -z "$(idx_score 8201)" ] && [ "$(in_refresh 8201)" = 1 ] && ok 'before the worker: member removed and queued' || bad 'before the worker: unexpected index/refresh state'
    worker_once availability-refresh
    if [ "$wcode" = 0 ] && [ "$(rds raw scard next-available:refresh)" = 0 ] && [ "$(idx_score 8201)" = "$(oracle first 8201)" ]; then ok 'worker --once availability-refresh: exit 0, queue drained, 8201 recomputed to the oracle first slot with no search'; else bad "refresh --once: exit $wcode scard=$(rds raw scard next-available:refresh) score=$(idx_score 8201) want $(oracle first 8201): $(tail -3 "$tmp/worker-availability-refresh.log" | cut -c1-200)"; fi
    worker_once availability-refresh
    [ "$wcode" = 0 ] && ok 'worker --once availability-refresh on an empty queue: exit 0' || bad "refresh --once (empty queue) exit $wcode"
  else
    skip 'refresh/sweep worker cases: DATABASE_URL (worker env) not exported'
  fi

  # --- lost invalidation: SQL-only change (no listener) is repaired by one sweep ---
  rds cleanup82 >/dev/null
  dget "/api/doctors?$MAIN&limit=100" "$patient"          # index warm for spec a
  fetch_oracle 8201 8202 8203 8204 8208
  declare -A H_S=([8201]=08:00 [8202]=14:00 [8203]=20:00 [8204]=20:00 [8208]=10:00) H_E=([8201]=12:00 [8202]=18:00 [8203]=22:00 [8204]=22:00 [8208]=11:00)
  # pick the doctor with the farthest first slot so the stale value is certainly still in the future
  victim=8203; far=0
  for u in 8201 8202 8203 8204 8208; do f="$(oracle first "$u")"; [ "$f" -gt "$far" ] && { far="$f"; victim=$u; }; done
  now_ms="$(node -e 'process.stdout.write(String(Date.now()))')"
  sql "UPDATE working_hours SET start_time = '03:00', end_time = '04:00' WHERE doctor_profile_id = ${PID_OF[$victim]} AND deleted_at IS NULL" >/dev/null
  rds raw zadd next-available:index 1 8206 >/dev/null     # a non-bookable member the sweep must remove
  old_cache="$(rds keys "slots:$victim:")"; [ -z "$old_cache" ] || printf '%s\n' "$old_cache" | while read -r k; do rds raw del "$k" >/dev/null; done
  stale_before="$(oracle first "$victim")"
  dget "/api/doctors?$MAIN&limit=100" "$patient"
  got_stale="$(jv "$tmp/body" "Date.parse(b.data.find(x=>x.userId===$victim).nextAvailableAt)")"
  if [ $((stale_before - now_ms)) -gt 120000 ]; then
    [ "$got_stale" = "$stale_before" ] && ok "lost invalidation: SQL-only change to $victim is NOT visible yet (stale index value served, within one sweep of staleness)" || bad "stale value expected $stale_before got $got_stale"
  else
    skip "stale-read assertion for $victim (first slot within 2 minutes of now)"
  fi
  if [ "$worker_ready" = 1 ]; then
    worker_once availability-sweep
    fetch_oracle "$victim"
    swept="$(rds get next-available:swept-at)"
    now2="$(node -e 'process.stdout.write(String(Date.now()))')"
    if [ "$wcode" = 0 ] && [ -n "$swept" ] && [ $((now2 - swept)) -lt 120000 ] && [ "$(idx_score "$victim")" = "$(oracle first "$victim")" ] && [ -z "$(idx_score 8206)" ]; then ok "worker --once availability-sweep: exit 0, swept-at stamped, $victim repaired to the oracle value, stray non-bookable member 8206 removed"; else bad "sweep --once: exit $wcode swept-at='$swept' score=$(idx_score "$victim") want $(oracle first "$victim") 8206=$(idx_score 8206): $(tail -3 "$tmp/worker-availability-sweep.log" | cut -c1-200)"; fi
    exp="$(oracle order earliest_availability "$ALL8")"
    tids "after the sweep: search order matches the oracle again (victim $victim moved to 03:00 hours)" "/api/doctors?$MAIN&limit=100" "$patient" "$exp" "Date.parse(b.data.find(x=>x.userId===$victim).nextAvailableAt)===$(oracle first "$victim")"
    grep -q 'availability_sweep_done' "$tmp/worker-availability-sweep.log" && ok 'sweep log carries availability_sweep_done (counts only)' || bad 'sweep log lacks availability_sweep_done'
    # "incomplete" outcomes exit 1 and never stamp swept-at: lock held by another session, then Redis unreachable for the worker
    swept_before="$(rds get next-available:swept-at)"
    psql "$CARE_OWNER_DATABASE_URL" -XAtq -c "SELECT pg_advisory_lock(hashtextextended('0', 1104)); SELECT pg_sleep(45)" >/dev/null 2>&1 &
    LOCK_PID=$!
    sleep 2
    worker_once availability-sweep
    release_lock
    if [ "$wcode" = 1 ] && grep -q worker_once_incomplete "$tmp/worker-availability-sweep.log" && [ "$(rds get next-available:swept-at)" = "$swept_before" ]; then ok 'sweep singleton: session advisory lock (namespace 1104, id 0) held elsewhere -> --once exits 1 (incomplete), swept-at not advanced'; else bad "sweep with lock held: exit $wcode swept-at changed=$([ "$(rds get next-available:swept-at)" = "$swept_before" ] && echo no || echo yes): $(tail -2 "$tmp/worker-availability-sweep.log" | cut -c1-200)"; fi
    sleep 1
    (cd "$ROOT" && REDIS_URL=redis://127.0.0.1:6399/14 $WORKER_CMD --once availability-sweep >"$tmp/worker-sweep-noredis.log" 2>&1) && wcode=0 || wcode=$?
    if [ "$wcode" = 1 ] && grep -q worker_once_incomplete "$tmp/worker-sweep-noredis.log"; then ok 'sweep with Redis unreachable: --once exits 1 (incomplete), no crash'; else bad "sweep without Redis: exit $wcode: $(tail -2 "$tmp/worker-sweep-noredis.log" | cut -c1-200)"; fi
    (cd "$ROOT" && REDIS_URL=redis://127.0.0.1:6399/14 $WORKER_CMD --once availability-refresh >"$tmp/worker-refresh-noredis.log" 2>&1) && wcode=0 || wcode=$?
    [ "$wcode" = 0 ] || [ "$wcode" = 1 ] && ok "refresh with Redis unreachable: --once ends cleanly (exit $wcode), no crash" || bad "refresh without Redis: exit $wcode"
  fi
  # restore the victim's hours (SQL, no listener) and drop its derived entries so later cases start clean
  sql "UPDATE working_hours SET start_time = '${H_S[$victim]}', end_time = '${H_E[$victim]}' WHERE doctor_profile_id = ${PID_OF[$victim]} AND deleted_at IS NULL" >/dev/null
  rds raw zrem next-available:index "$victim" >/dev/null; rds raw del "free-map:$victim" >/dev/null
  k2="$(rds keys "slots:$victim:")"; [ -z "$k2" ] || printf '%s\n' "$k2" | while read -r k; do rds raw del "$k" >/dev/null; done
  fetch_oracle 8201 8202 8203 8204 8205 8208

  # --- a long-running worker keeps the index fresh with no search at all ---
  if [ "$worker_ready" = 1 ]; then
    (cd "$ROOT" && exec $WORKER_CMD >"$tmp/worker-long.log" 2>&1) &
    WORKER_PID=$!
    for _ in $(seq 1 60); do grep -q 'worker_started' "$tmp/worker-long.log" 2>/dev/null && break; sleep 1; done
    if grep -q 'worker_started' "$tmp/worker-long.log"; then
      grep -q 'availability-refresh' "$tmp/worker-long.log" && grep -q 'availability-sweep' "$tmp/worker-long.log" && ok 'long-running worker: worker_started lists availability-refresh and availability-sweep' || bad 'long-running worker: loops missing from worker_started'
      # boot sweep populates the whole index (no request ever made for it)
      for _ in $(seq 1 40); do [ -n "$(idx_score 8208)" ] && break; sleep 1; done
      [ -n "$(idx_score 8201)" ] && [ -n "$(idx_score 8208)" ] && ok 'long-running worker: the boot sweep filled the index with no search request' || bad 'long-running worker: index not filled by the boot sweep'
      # API write -> refresh loop (2 s) recomputes without any search
      call PUT /api/doctors/me/working-hours "$doc8202" '{"days":[{"weekday":1,"intervals":[{"startTime":"05:00","endTime":"06:00"}]},{"weekday":2,"intervals":[{"startTime":"05:00","endTime":"06:00"}]},{"weekday":3,"intervals":[{"startTime":"05:00","endTime":"06:00"}]},{"weekday":4,"intervals":[{"startTime":"05:00","endTime":"06:00"}]},{"weekday":5,"intervals":[{"startTime":"05:00","endTime":"06:00"}]},{"weekday":6,"intervals":[{"startTime":"05:00","endTime":"06:00"}]},{"weekday":7,"intervals":[{"startTime":"05:00","endTime":"06:00"}]}]}'
      assert_resp 'API (worker running): doctor 8202 moves to 05:00-06:00' 200 'b.data.days.length===7'
      fetch_oracle 8202
      t0="$(node -e 'process.stdout.write(String(Date.now()))')"; got=""
      for _ in $(seq 1 50); do got="$(idx_score 8202)"; [ "$got" = "$(oracle first 8202)" ] && [ "$(in_refresh 8202)" = 0 ] && break; sleep 0.5; done
      dt=$(( $(node -e 'process.stdout.write(String(Date.now()))') - t0 ))
      [ "$got" = "$(oracle first 8202)" ] && ok "long-running worker: refresh loop recomputed 8202 with no search (${dt} ms after the write)" || bad "refresh loop did not update 8202 (score '$got', want $(oracle first 8202))"
      tids 'search after the worker refresh: order matches the oracle' "/api/doctors?$MAIN&limit=100" "$patient" "$(oracle order earliest_availability "$ALL8")"
      grep -q 'availability_refresh_done' "$tmp/worker-long.log" && ok 'worker log carries availability_refresh_done' || bad 'worker log lacks availability_refresh_done'
    else
      bad "long-running worker did not log worker_started within 60 s: $(tail -3 "$tmp/worker-long.log" | cut -c1-200)"
    fi
    worker_stop
    sleep 1
  else
    skip 'long-running worker cases: DATABASE_URL (worker env) not exported'
  fi

fi

# raw_name_probes <label>: odd `name` values (lex-range metacharacters, NUL, U+10FFFF, lone surrogates, invalid UTF-8, bidi override) must end in
# a handled 200 or 400 with the envelope and the request id echoed, never a 5xx (the prefix is sent to Redis as a lex range).
raw_name_probes() {
  local raw failures=""
  for raw in '%5Ba' '%28%28' '%25%25' '%2B%2B' '..' '%2A%2A' '%F4%8F%BF%BF%F4%8F%BF%BF' '%ED%A0%80%ED%A0%80' '%C0%AF%C0%AF' '%00%00' 'a%00b' '%E2%80%AE%E2%80%AE'; do
    dget "/api/doctors?$MAIN&name=$raw&limit=100" "$patient"
    if { [ "$status" = 200 ] || [ "$status" = 400 ]; } && rid_echoed && jt "$tmp/body" "typeof b.success==='boolean'"; then :; else failures="${failures}${raw}=>${status} "; fi
  done
  if [ -z "$failures" ]; then ok "$1"; else bad "$1: $failures"; fi
}
u() { node -e 'process.stdout.write(process.argv[1].replace(/<([0-9a-f]{4})>/gi,(m,h)=>String.fromCharCode(parseInt(h,16))))' "$1"; }   # u 'Jos<00e9>' prints the real characters (the script stays ASCII)

# ================================================================================================================================
# Slice 3: name index and name filter (AV-R27..AV-R29). Redis up only; the Redis-down answers are in the Redis-down section below.
# The fake Identity names are `Synthetic QA Doctor <id>`; `rename` goes through /control/user?id=&name=.
# ================================================================================================================================
if [ -n "$REDIS_URL" ]; then
  echo; echo '== slice 3: name index and name filter (Redis up) =='
  if [ "$worker_ready" = 1 ] && curl -fsS "$FAKE_IDENTITY_URL/control/stats" >/dev/null 2>&1; then
    nq() { node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$1"; }
    sweep_s3() { # sweep_s3 <tag>: one full --once sweep (sets wcode); the log is kept as worker-s3-<tag>.log for the privacy scan
      worker_once availability-sweep; cp "$tmp/worker-availability-sweep.log" "$tmp/worker-s3-$1.log"
    }
    s3_log_has() { grep -q "$2" "$tmp/worker-s3-$1.log"; }
    zlex() { rds raw zlexcount name-index "[$1" "[$1~"; }   # members whose normalised name starts with $1
    name_path() { printf '/api/doctors?%s&name=%s&sort=price&limit=100' "$1" "$(nq "$2")"; }
    NDEG='["nameFilter"]'
    # walk_path <label> <base path incl. limit> <expected ids csv> <expected pages> <js over b each page>
    walk_path() {
      local label="$1" base="$2" want="$3" want_pages="$4" extra="$5" cursor="" got="" pages=0 flags=""
      while :; do
        dget "$base${cursor:+&cursor=$cursor}" "$patient"
        [ "$status" = 200 ] || { bad "$label page $((pages+1)): status $status $(head -c 150 "$tmp/body")"; return; }
        rid_echoed || flags="${flags}rid;"
        jt "$tmp/body" "b.meta.count===b.data.length && b.meta.hasMore===(b.meta.nextCursor!==null) && ($extra)" || flags="${flags}meta;"
        got="${got:+$got,}$(jv "$tmp/body" 'b.data.map(x=>x.userId).join(",")')"
        pages=$((pages+1))
        [ "$pages" -ne 2 ] || [ "$(jv "$tmp/body" 'b.data.length>0')" = true ] || flags="${flags}page2empty;"
        cursor="$(jv "$tmp/body" 'b.meta.nextCursor??""')"
        [ -n "$cursor" ] || break
        [ "$pages" -lt 10 ] || { flags="${flags}runaway;"; break; }
      done
      if [ "$got" = "$want" ] && [ "$pages" = "$want_pages" ] && [ -z "$flags" ]; then ok "$label: $pages pages, ids $got, hasMore/nextCursor exact, request id echoed"; else bad "$label: got '$got' (want '$want') pages=$pages flags=$flags"; fi
    }

    ident reset; rds cleanupnames >/dev/null
    fetch_oracle 8201 8202 8203 8204 8205 8208
    N_BOOKABLE="$(sql "SELECT count(*) FROM doctor_profiles dp WHERE dp.user_id BETWEEN 8200 AND 8299 AND dp.verification_status='approved' AND dp.identity_sync_status='synced' AND dp.suspended_at IS NULL AND dp.is_accepting_patients AND dp.deleted_at IS NULL AND EXISTS (SELECT 1 FROM consultation_types ct WHERE ct.doctor_profile_id=dp.id AND ct.is_active AND ct.deleted_at IS NULL)")"

    # --- 1. before any sweep the index is absent: headline-only, nameFilter reported -----------------------------------------------
    [ -z "$(rds keys 'name-index')" ] && ok 'S3 before any sweep: no name-index* key exists' || bad 'S3 before any sweep: a name-index* key exists'
    tids 'S3 index absent: a display-name prefix finds nothing and meta.degraded=["nameFilter"]' "$(name_path "$MAIN" 'synthetic qa doctor 8203')" "$patient" '' "$(degjs "$NDEG")"
    tids 'S3 index absent: the headline prefix still matches (8201) and meta.degraded=["nameFilter"]' "$(name_path "$MAIN" 'qa alpha')" "$patient" '8201' "$(degjs "$NDEG")"

    # --- 2. one sweep builds the index -------------------------------------------------------------------------------------------
    sweep_s3 first
    nz="$(rds raw zcard name-index)"; nttl="$(rds ttl name-index)"; bat="$(rds get name-index:built-at)"; nb="$(rds keys 'name-index:building')"
    if [ "$wcode" = 0 ] && [ "$nz" = "$N_BOOKABLE" ] && [ "$nttl" -gt 0 ] && [ "$nttl" -le 900 ] && [ -n "$bat" ] && [ -z "$nb" ] && s3_log_has first availability_name_index_built; then
      ok "S3 sweep builds the index: exit 0, name-index holds $nz members (= the $N_BOOKABLE bookable doctors), TTL ${nttl}s <= 900, built-at stamped, no leftover building key, availability_name_index_built logged"
    else
      bad "S3 sweep build: exit $wcode members=$nz (want $N_BOOKABLE) ttl=$nttl built-at='$bat' building='$nb': $(tail -3 "$tmp/worker-s3-first.log" | cut -c1-200)"
    fi

    # --- 3. index-backed prefix on the display name ---------------------------------------------------------------------------------
    tids 'S3 display-name prefix "synthetic qa doctor 82" within spec a -> all six bookable doctors in price order, NO meta.degraded' "$(name_path "$MAIN" 'synthetic qa doctor 82')" "$patient" "$PO" \
      "$DEG_NONE && b.meta.count===6 && new Set(b.data.map(x=>x.userId)).size===b.data.length"
    tids 'S3 display-name prefix, default sort (earliest) -> the six doctors in oracle order, NO meta.degraded' "/api/doctors?$MAIN&name=$(nq 'synthetic qa doctor 82')&limit=100" "$patient" "$(oracle order earliest_availability "$ALL8")" "$DEG_NONE"
    tids 'S3 narrower display-name prefix "synthetic qa doctor 8203" -> 8203 only' "$(name_path "$MAIN" 'synthetic qa doctor 8203')" "$patient" '8203' "$DEG_NONE"
    tids 'S3 case-insensitive: SYNTHETIC QA DOCTOR 8203 -> 8203' "$(name_path "$MAIN" 'SYNTHETIC QA DOCTOR 8203')" "$patient" '8203' "$DEG_NONE"
    tids 'S3 whitespace is trimmed and collapsed: "  Synthetic   QA Doctor 8203 " -> 8203' "$(name_path "$MAIN" '  Synthetic   QA Doctor 8203 ')" "$patient" '8203' "$DEG_NONE"
    tids 'S3 a name that is not a prefix ("qa doctor 8203") -> empty, still NO meta.degraded' "$(name_path "$MAIN" 'qa doctor 8203')" "$patient" '' "$DEG_NONE"
    tids 'S3 the headline prefix still matches with the index present (qa alpha -> 8201), NO meta.degraded' "$(name_path "$MAIN" 'qa alpha')" "$patient" '8201' "$DEG_NONE"
    tids 'S3 admin sees the same index-backed match' "$(name_path "$MAIN" 'synthetic qa doctor 8203')" "$admin" '8203' "$DEG_NONE"

    # --- 4. union of display-name and headline matches, no duplicates ------------------------------------------------------------------
    sql "UPDATE doctor_profiles SET headline = 'Synthetic QA Doctor 8203 Delta' WHERE user_id = 8204; UPDATE doctor_profiles SET headline = 'Synthetic QA Doctor 8202 Beta' WHERE user_id = 8202" >/dev/null
    tids 'S3 union: 8203 matches by display name and 8204 by headline only -> both, price order' "$(name_path "$MAIN" 'synthetic qa doctor 8203')" "$patient" "$(oracle order price '8203,8204')" "$DEG_NONE && b.meta.count===2"
    tids 'S3 union without duplicates: 8202 matches by BOTH its display name and its headline -> listed once' "$(name_path "$MAIN" 'synthetic qa doctor 8202')" "$patient" '8202' "$DEG_NONE && b.meta.count===1"
    tids 'S3 union without duplicates over the whole prefix: six distinct doctors' "$(name_path "$MAIN" 'synthetic qa doctor 82')" "$patient" "$PO" "$DEG_NONE && b.meta.count===6"
    sql "UPDATE doctor_profiles SET headline = 'QA Delta Dermatology' WHERE user_id = 8204; UPDATE doctor_profiles SET headline = 'QA Beta Cardiology' WHERE user_id = 8202" >/dev/null

    # --- 5. intersection with the candidate set -------------------------------------------------------------------------------------
    sql "UPDATE doctor_profiles SET is_accepting_patients = false WHERE user_id = 8208" >/dev/null     # SQL only: the index is not told
    [ "$(zlex 'synthetic qa doctor 8208')" = 1 ] && ok 'S3 intersection precondition: the name index still holds 8208 after it stopped accepting patients' || bad 'S3 intersection precondition: 8208 missing from the index'
    tids 'S3 intersection: 8208 (in the index, no longer a candidate) is absent from a matching name search' "$(name_path "$MAIN" 'synthetic qa doctor 8208')" "$patient" '' "$DEG_NONE"
    tids 'S3 intersection: the broad prefix returns the five remaining candidates, not 8208' "$(name_path "$MAIN" 'synthetic qa doctor 82')" "$patient" '8202,8205,8203,8204,8201' "$DEG_NONE"
    sql "UPDATE doctor_profiles SET is_accepting_patients = true WHERE user_id = 8208" >/dev/null
    tids 'S3 intersection: once accepting again 8208 is back (same index, no rebuild)' "$(name_path "$MAIN" 'synthetic qa doctor 8208')" "$patient" '8208' "$DEG_NONE"
    [ "$(zlex 'synthetic qa doctor 8206')" = 0 ] && [ "$(zlex 'synthetic qa doctor 8207')" = 0 ] && ok 'S3 non-bookable doctors (8206 not accepting, 8207 suspended) were never indexed' || bad 'S3 a non-bookable doctor is in the name index'
    tids 'S3 a non-bookable doctor whose Identity name matches (8206) is absent' "$(name_path "$MAIN" 'synthetic qa doctor 8206')" "$patient" '' "$DEG_NONE"

    # --- 6. combined with other filters ------------------------------------------------------------------------------------------------
    tids 'S3 name + specialty qa-avail-b -> 8203, 8204' "$(name_path 'specialty=qa-avail-b' 'synthetic qa doctor 82')" "$patient" '8203,8204' "$DEG_NONE"
    tids 'S3 name + specialty qa-avail-b, narrower prefix -> 8204' "$(name_path 'specialty=qa-avail-b' 'synthetic qa doctor 8204')" "$patient" '8204' "$DEG_NONE"
    tids 'S3 name + specialty: a matching name outside the specialty (cap doctors are in qa-avail-c) -> empty' "$(name_path "$MAIN" 'synthetic qa doctor 821')" "$patient" '' "$DEG_NONE"
    tids 'S3 name + specialty + language + fee range -> 8202, 8208, 8205' "$(name_path "$MAIN&language=ar&minFee=100&maxFee=150" 'synthetic qa doctor 82')" "$patient" '8202,8208,8205' "$DEG_NONE"

    # --- 7. pagination: page 2 with nextCursor over a name search --------------------------------------------------------------------------
    walk_path 'S3 pagination name search sort=price limit=4 (qa-avail-c, prefix "synthetic qa doctor 821")' "$(name_path 'specialty=qa-avail-c' 'synthetic qa doctor 821' | sed 's/limit=100/limit=4/')" \
      '8210,8211,8212,8213,8214,8215,8216,8217,8218,8219' 3 "$DEG_NONE"
    walk_path 'S3 pagination name search default sort (earliest) limit=4 (same set)' "/api/doctors?specialty=qa-avail-c&name=$(nq 'synthetic qa doctor 821')&limit=4" \
      '8210,8211,8212,8213,8214,8215,8216,8217,8218,8219' 3 "$DEG_NONE"
    # page 2 of a name search whose cursor is replayed with a different name is a position, not a grant (200, never 5xx)
    dget "$(name_path 'specialty=qa-avail-c' 'synthetic qa doctor 821' | sed 's/limit=100/limit=4/')" "$patient"; c3="$(jv "$tmp/body" 'b.meta.nextCursor')"
    t 'S3 a name-search cursor replayed with another name is accepted as a position (200, never 5xx)' "$(name_path 'specialty=qa-avail-c' 'synthetic qa doctor 8215' | sed 's/limit=100/limit=4/')&cursor=$c3" "$patient" 200 'Array.isArray(b.data)'

    # --- 8. validation -----------------------------------------------------------------------------------------------------------------
    t 'S3 name of 1 character -> 400 (index present)' "/api/doctors?$MAIN&name=a" "$patient" 400 ValidationFailed
    jt "$tmp/body" "b.error.details.some(d=>d.field==='name')" && ok 'S3 one-character name: details[].field = name' || bad "S3 name detail: $(head -c 200 "$tmp/body")"
    t 'S3 name with a control character -> 400 (index present)' "/api/doctors?$MAIN&name=synthetic%0Aqa" "$patient" 400 ValidationFailed

    raw_name_probes 'S3 raw name probes (lex metacharacters, NUL, U+10FFFF, lone surrogates, invalid UTF-8, bidi override) with the index present: handled 200/400, never 5xx'

    # --- 9. rename: the old name matches until the next DUE rebuild ---------------------------------------------------------------------------
    curl -fsS "$FAKE_IDENTITY_URL/control/user?id=8203&name=Renamed%20QA%20Physician" >/dev/null
    tids 'S3 rename at Identity: before the next due rebuild the OLD name still matches (derived index, stale by at most the refresh period)' "$(name_path "$MAIN" 'synthetic qa doctor 8203')" "$patient" '8203' "$DEG_NONE"
    tids 'S3 rename at Identity: the NEW name does not match yet' "$(name_path "$MAIN" 'renamed qa')" "$patient" '' "$DEG_NONE"
    sweep_s3 fresh
    if [ "$wcode" = 0 ] && ! s3_log_has fresh availability_name_index_built; then ok 'S3 a sweep inside the refresh period (built-at fresh) does not rebuild: exit 0, no availability_name_index_built'; else bad "S3 fresh sweep rebuilt or failed: exit $wcode"; fi
    tids 'S3 after that sweep the old name still matches (no rebuild was due)' "$(name_path "$MAIN" 'synthetic qa doctor 8203')" "$patient" '8203' "$DEG_NONE"
    rds raw del name-index:built-at >/dev/null; rds raw del identity:user:8203 >/dev/null     # make the rebuild due; the builder reads through the 300 s identity cache
    sweep_s3 rename
    if [ "$wcode" = 0 ] && s3_log_has rename availability_name_index_built; then ok 'S3 due rebuild (built-at deleted, identity:user:8203 cache deleted): exit 0, availability_name_index_built'; else bad "S3 due rebuild: exit $wcode: $(tail -3 "$tmp/worker-s3-rename.log" | cut -c1-200)"; fi
    tids 'S3 after the rebuild the NEW name matches (8203, hydrated with the new name), NO meta.degraded' "$(name_path "$MAIN" 'renamed qa')" "$patient" '8203' "$DEG_NONE && b.data[0].displayName==='Renamed QA Physician'"
    tids 'S3 after the rebuild the OLD name no longer matches' "$(name_path "$MAIN" 'synthetic qa doctor 8203')" "$patient" '' "$DEG_NONE"

    # --- 10. Identity down + due rebuild: the previous build is kept and still served ------------------------------------------------------------
    ttl_before="$(rds ttl name-index)"
    curl -fsS "$FAKE_IDENTITY_URL/control/mode?users=down" >/dev/null
    rds cleanupidentity >/dev/null; rds raw del name-index:built-at >/dev/null
    sweep_s3 down
    ttl_after="$(rds ttl name-index)"; bat_after="$(rds get name-index:built-at)"
    if [ "$wcode" = 0 ] && s3_log_has down availability_name_index_stale && ! s3_log_has down availability_name_index_built && [ "$ttl_after" -gt 0 ] && [ "$ttl_after" -le "$ttl_before" ] && [ -z "$bat_after" ]; then
      ok "S3 Identity down + due rebuild: sweep still exit 0, availability_name_index_stale logged, previous build kept (TTL ${ttl_before}s -> ${ttl_after}s, not extended), built-at not re-stamped"
    else
      bad "S3 Identity down rebuild: exit $wcode ttl $ttl_before -> $ttl_after built-at='$bat_after': $(tail -3 "$tmp/worker-s3-down.log" | cut -c1-200)"
    fi
    tids 'S3 Identity down: the previous build is still served (renamed qa -> 8203) with NO meta.degraded' "$(name_path "$MAIN" 'renamed qa')" "$patient" '8203' "$DEG_NONE"
    ident reset; rds cleanupidentity >/dev/null          # Identity back up (this also restores the original name of 8203)
    sweep_s3 recover
    if [ "$wcode" = 0 ] && s3_log_has recover availability_name_index_built && [ -n "$(rds get name-index:built-at)" ]; then ok 'S3 Identity back up: the next sweep rebuilds (built-at was left absent) and re-stamps'; else bad "S3 recovery rebuild: exit $wcode"; fi
    tids 'S3 after recovery the original name matches again' "$(name_path "$MAIN" 'synthetic qa doctor 8203')" "$patient" '8203' "$DEG_NONE"
    tids 'S3 after recovery the renamed value is gone' "$(name_path "$MAIN" 'renamed qa')" "$patient" '' "$DEG_NONE"

    # --- 11. only Identity-active users are indexed ------------------------------------------------------------------------------------------------
    curl -fsS "$FAKE_IDENTITY_URL/control/user?id=8205&status=suspended" >/dev/null
    rds cleanupidentity >/dev/null; rds raw del name-index:built-at >/dev/null
    sweep_s3 status
    if [ "$wcode" = 0 ] && [ "$(zlex 'synthetic qa doctor 8205')" = 0 ] && [ "$(zlex 'synthetic qa doctor 8201')" = 1 ]; then ok 'S3 an Identity-suspended user (8205) is not indexed on rebuild; the others are'; else bad "S3 status filter: exit $wcode 8205=$(zlex 'synthetic qa doctor 8205') 8201=$(zlex 'synthetic qa doctor 8201')"; fi
    ident reset; rds cleanupidentity >/dev/null; rds raw del name-index:built-at >/dev/null
    sweep_s3 restore
    [ "$wcode" = 0 ] && [ "$(zlex 'synthetic qa doctor 8205')" = 1 ] && ok 'S3 after Identity reactivates 8205, the next due rebuild indexes it again' || bad "S3 status restore: exit $wcode"

    # --- 11b. Unicode: NFC/NFD and case folding on both sides, Arabic prefix --------------------------------------------------------------------------
    curl -fsS "$FAKE_IDENTITY_URL/control/user?id=8204&name=$(nq "$(u 'Jos<00e9> QA Physician')")" >/dev/null
    curl -fsS "$FAKE_IDENTITY_URL/control/user?id=8201&name=$(nq "$(u '<062f>. <0623><062d><0645><062f> QA')")" >/dev/null
    rds cleanupidentity >/dev/null; rds raw del name-index:built-at >/dev/null
    sweep_s3 unicode
    if [ "$wcode" = 0 ] && s3_log_has unicode availability_name_index_built; then ok 'S3 Unicode names (accented Latin, Arabic) indexed on a due rebuild: exit 0'; else bad "S3 Unicode rebuild: exit $wcode"; fi
    tids 'S3 Unicode: NFC prefix "jos<e acute> qa" -> 8204' "$(name_path "$MAIN" "$(u 'jos<00e9> qa')")" "$patient" '8204' "$DEG_NONE"
    tids 'S3 Unicode: NFD query (e + combining acute) matches the NFC name -> 8204' "$(name_path "$MAIN" "$(u 'jose<0301> qa')")" "$patient" '8204' "$DEG_NONE"
    tids 'S3 Unicode: upper-case E-acute (JOS<E acute>) -> 8204' "$(name_path "$MAIN" "$(u 'JOS<00c9>')")" "$patient" '8204' "$DEG_NONE"
    tids 'S3 Unicode: the unaccented "jose qa" is not a prefix of the accented name -> empty' "$(name_path "$MAIN" 'jose qa')" "$patient" '' "$DEG_NONE"
    tids 'S3 Unicode: Arabic prefix (2 code points, dot, space, 2 letters) -> 8201' "$(name_path "$MAIN" "$(u '<062f>. <0623><062d>')")" "$patient" '8201' "$DEG_NONE"
    ident reset; rds cleanupidentity >/dev/null; rds raw del name-index:built-at >/dev/null
    sweep_s3 unicoderestore
    tids 'S3 Unicode restore: after the next rebuild the original name of 8204 matches again and the accented one does not' "$(name_path "$MAIN" 'synthetic qa doctor 8204')" "$patient" '8204' "$DEG_NONE"

    # --- 12. index expired / deleted: headline-only fallback again --------------------------------------------------------------------------------
    rds raw pexpire name-index 1 >/dev/null; sleep 0.3
    tids 'S3 index expired (PEXPIRE 1): a display-name prefix finds nothing, meta.degraded=["nameFilter"]' "$(name_path "$MAIN" 'synthetic qa doctor 8203')" "$patient" '' "$(degjs "$NDEG")"
    tids 'S3 index expired: the headline prefix still matches (8201), meta.degraded=["nameFilter"]' "$(name_path "$MAIN" 'qa alpha')" "$patient" '8201' "$(degjs "$NDEG")"
    rds raw del name-index:built-at >/dev/null
    sweep_s3 afterexpiry
    tids 'S3 the next sweep rebuilds an expired index: name matches again, NO meta.degraded' "$(name_path "$MAIN" 'synthetic qa doctor 8203')" "$patient" '8203' "$DEG_NONE"
    rds raw del name-index >/dev/null; rds raw del name-index:built-at >/dev/null
    [ -z "$(rds keys 'name-index')" ] && ok 'S3 name-index and name-index:built-at deleted' || bad 'S3 name-index keys still present after DEL'
    tids 'S3 index deleted: display-name prefix finds nothing, meta.degraded=["nameFilter"]' "$(name_path "$MAIN" 'synthetic qa doctor 8203')" "$patient" '' "$(degjs "$NDEG")"
    tids 'S3 index deleted: headline prefix matches 8201, meta.degraded=["nameFilter"]' "$(name_path "$MAIN" 'qa alpha')" "$patient" '8201' "$(degjs "$NDEG")"
    tids 'S3 searches without a name filter never report nameFilter, with or without the index' "/api/doctors?$MAIN&sort=price&limit=100" "$patient" "$PO" "$DEG_NONE"
    ident reset; rds cleanupnames >/dev/null
  else
    skip 'slice 3 name-index cases: worker env (DATABASE_URL) not exported or the availability fake Identity control surface is not served'
  fi
fi

# ================================================================================================================================
echo; echo '== slice 2: write-through (booking and accepting toggle reach search and profile) =='
fetch_oracle 8201 8202 8203 8204 8205 8208
dget "/api/doctors?$MAIN&limit=100" "$patient"            # warm: 8208 has an index entry (Redis up)
first_ms="$(oracle first 8208)"
second_ms="$(node -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).sort((a,b)=>a-b);process.stdout.write(String(s[1]))' "$tmp/starts-8208.json")"
first_iso="$(node -e 'process.stdout.write(new Date(Number(process.argv[1])).toISOString())' "$first_ms")"
book_body="$(printf '{"doctorId":8208,"typeId":%s,"startsAt":"%s","complaintText":"Synthetic availability QA visit","patientTimezone":"UTC"}' "${TYPE_OF[8208]}" "$first_iso")"
new_key; call POST /api/consultations "$patient" "$book_body" "$NEW_KEY"
assert_resp 'booking the first free slot of 8208 -> 201' 201 'b.data.id>0'
cid2="$(jv "$tmp/body" 'b.data.id')"
if [ -n "$REDIS_URL" ]; then [ -z "$(rds raw zscore next-available:index 8208)" ] && ok 'booking removed 8208 from the rank index immediately (listener fan-in)' || bad 'booking left a stale 8208 index entry'; fi
dget "/api/doctors?$MAIN&limit=100" "$patient"
assert_resp 'search right after the booking: 8208 nextAvailableAt is the SECOND slot (no wait for a sweep)' 200 "Date.parse(b.data.find(x=>x.userId===8208).nextAvailableAt)===$second_ms"
dget '/api/doctors/8208' "$patient"
assert_resp 'profile right after the booking: preview starts at the second slot and excludes the booked one' 200 "Date.parse(b.data.nextAvailableAt)===$second_ms && !b.data.nextAvailableSlots.some(s=>Date.parse(s.startsAt)===$first_ms)"
new_key; call PATCH "/api/consultations/$cid2/cancel" "$admin" '{"reason":"Synthetic QA admin cancel"}' "$NEW_KEY"
assert_resp 'admin cancels the booking on behalf of the patient -> 200' 200 "b.data.id===$cid2"
dget "/api/doctors?$MAIN&limit=100" "$patient"
assert_resp 'search after the cancel: the first slot is free again' 200 "Date.parse(b.data.find(x=>x.userId===8208).nextAvailableAt)===$first_ms"

ALL7="$(oracle order "$(eff earliest_availability)" '8201,8203,8204,8205,8208')"
ALL7_FULL="$(oracle order "$(eff earliest_availability)" "$ALL8")"
call PATCH /api/doctors/me "$doc8202" '{"isAcceptingPatients":false}'
assert_resp 'doctor 8202 stops accepting patients -> 200' 200 'b.data.isAcceptingPatients===false'
exp7="$(oracle order "$(eff earliest_availability)" '8201,8203,8204,8205,8208')"
tids '8202 vanishes from search at once' "/api/doctors?$MAIN&limit=100" "$patient" "$exp7"
[ -z "$REDIS_URL" ] || { [ -z "$(rds raw zscore next-available:index 8202)" ] && ok '8202 removed from the rank index by the doctor-change listener' || bad '8202 still indexed after the toggle'; }
t 'patient profile of 8202 is now 404' '/api/doctors/8202' "$patient" 404 NotFound
t 'admin profile of 8202 is now status=not_bookable' '/api/doctors/8202' "$admin" 200 "b.data.status==='not_bookable' && b.data.nextAvailableSlots.length===0"
call PATCH /api/doctors/me "$doc8202" '{"isAcceptingPatients":true}'
assert_resp 'doctor 8202 accepts patients again -> 200' 200 'b.data.isAcceptingPatients===true'
tids '8202 is back in search at once' "/api/doctors?$MAIN&limit=100" "$patient" "$ALL7_FULL"

# ================================================================================================================================
if [ -z "$REDIS_URL" ]; then
  echo; echo '== slice 2: Redis down (this Care server cannot reach Redis) =='
  exp="$(oracle order price "$ALL8")"
  dget "/api/doctors?$MAIN&limit=100" "$patient"
  assert_resp 'Redis down: default sort -> 200, meta.degraded=["sort"], price order' 200 "b.data.map(x=>x.userId).join(',')==='$exp' && $(degjs '["sort"]')"
  assert_resp 'Redis down: rows get nextAvailableAt computed inline (equal to the oracle), the no-hours doctor null' 200 \
    "b.data.filter(x=>x.nextAvailableAt!==null).length===5 && b.data.find(x=>x.userId===8205).nextAvailableAt===null"
  ok_first=1
  for u in 8201 8202 8203 8204 8208; do
    want="$(oracle first "$u")"; got="$(jv "$tmp/body" "Date.parse(b.data.find(x=>x.userId===$u).nextAvailableAt)")"
    [ "$want" = "$got" ] || { ok_first=0; echo "  mismatch $u oracle=$want got=$got"; }
  done
  [ "$ok_first" = 1 ] && ok 'Redis down: inline nextAvailableAt equals the oracle for all 5 slotted doctors' || bad 'Redis down: inline nextAvailableAt mismatch'
  tids 'Redis down: sort=price has no degraded marker' "/api/doctors?$MAIN&sort=price&limit=100" "$patient" "$PO" "$DEG_NONE"
  tids 'Redis down: sort=experience has no degraded marker' "/api/doctors?$MAIN&sort=experience&limit=100" "$patient" "$XO" "$DEG_NONE"
  exp_all="$(oracle order price "$ALL8")"
  tids 'Redis down: window + default sort -> filter ignored, meta.degraded=["sort","availabilityFilter"] (ordered)' "/api/doctors?$MAIN&availableFrom=${tomorrow}T21:45:00Z&availableTo=${tomorrow}T22:30:00Z&limit=100" "$patient" "$exp_all" "$(degjs '["sort","availabilityFilter"]')"
  tids 'Redis down: window + sort=price -> meta.degraded=["availabilityFilter"]' "/api/doctors?$MAIN&availableFrom=${tomorrow}T21:45:00Z&availableTo=${tomorrow}T22:30:00Z&sort=price&limit=100" "$patient" "$PO" "$(degjs '["availabilityFilter"]')"
  tids 'Redis down: window + name + default sort -> all three markers in the documented order' "/api/doctors?$MAIN&name=qa%20alpha&availableFrom=${tomorrow}T21:45:00Z&limit=100" "$patient" '8201' "$(degjs '["sort","availabilityFilter","nameFilter"]')"
  tids 'S3 Redis down: a display-name prefix finds nothing (no index reachable), meta.degraded=["nameFilter"] exactly (sort=price)' "/api/doctors?$MAIN&name=synthetic%20qa%20doctor%2082&sort=price&limit=100" "$patient" '' "$(degjs '["nameFilter"]')"
  tids 'S3 Redis down: the headline prefix still matches (8201), search is 200 (never 5xx), meta.degraded=["nameFilter"]' "/api/doctors?$MAIN&name=qa%20alpha&sort=price&limit=100" "$patient" '8201' "$(degjs '["nameFilter"]')"
  raw_name_probes 'S3 Redis down: raw name probes (lex metacharacters, NUL, U+10FFFF, lone surrogates, invalid UTF-8) are handled 200/400, never 5xx'
  t 'Redis down: window validation still applies (past availableFrom -> 400)' "/api/doctors?$MAIN&availableFrom=2020-01-01T00:00:00Z" "$patient" 400 ValidationFailed
  # page walk in degraded mode
  walk earliest_availability "$exp_all"
  dget "/api/doctors?$MAIN&limit=2" "$patient"
  assert_resp 'Redis down: degraded page 1 carries meta.degraded=["sort"] and a cursor' 200 "$(degjs '["sort"]') && typeof b.meta.nextCursor==='string'"
  dcur="$(jv "$tmp/body" 'b.meta.nextCursor')"
  t 'Redis down: degraded cursor continues the price order on page 2' "/api/doctors?$MAIN&limit=2&cursor=$dcur" "$patient" 200 "b.data.map(x=>x.userId).join(',')==='$(echo "$exp_all" | cut -d, -f3,4)' && $(degjs '["sort"]')"
  t 'Redis down: degraded cursor replayed with sort=price -> 400' "/api/doctors?$MAIN&sort=price&limit=2&cursor=$dcur" "$patient" 400 ValidationFailed
  [ -z "$CURSOR_FILE" ] || { grep -v '^DEGRADED_CURSOR=' "$CURSOR_FILE" 2>/dev/null > "$tmp/cursors" || true; echo "DEGRADED_CURSOR=$dcur" >> "$tmp/cursors"; cp "$tmp/cursors" "$CURSOR_FILE"; }
  if [ -z "$EARLIEST_CURSOR" ] && [ -n "$CARE_UP_URL" ]; then
    up_status="$(curl -sS -o "$tmp/upbody" -w '%{http_code}' -H "Authorization: Bearer $patient" -H "X-Request-Id: $(uuid)" "$CARE_UP_URL/api/doctors?$MAIN&limit=2")"
    [ "$up_status" != 200 ] || EARLIEST_CURSOR="$(jv "$tmp/upbody" 'b.meta.nextCursor??""')"
  fi
  if [ -n "$EARLIEST_CURSOR" ]; then
    t 'Redis down: an `earliest` cursor issued by a healthy server is 400 here (client restarts the list)' "/api/doctors?$MAIN&limit=2&cursor=$EARLIEST_CURSOR" "$patient" 400 ValidationFailed
    jt "$tmp/body" "b.error.details.some(d=>d.field==='cursor')" && ok 'earliest-cursor rejection names the cursor field' || bad "earliest cursor details: $(head -c 200 "$tmp/body")"
  else
    skip 'earliest cursor while Redis is down: neither EARLIEST_CURSOR nor CARE_UP_URL set'
  fi
  # profile and slots do not depend on Redis
  dget '/api/doctors/8201' "$patient"
  assert_resp 'Redis down: profile 200 with 5 slots computed from Postgres' 200 'b.data.nextAvailableSlots.length===5'
  dget '/api/doctors/8206' "$admin"
  assert_resp 'Redis down: admin profile of a non-bookable doctor 200' 200 "b.data.status==='not_bookable'"
fi

# ================================================================================================================================
echo; echo '== slice 2/3: privacy (server log, worker logs, Postgres) =='
if [ -n "$CARE_LOG_FILE" ] && [ -r "$CARE_LOG_FILE" ]; then
  hits="$(grep -c -i -e 'Synthetic QA Doctor' -e 'avatars.example.test' -e 'qa alpha' -e 'renamed qa' -e 'qa doctor 82' "$CARE_LOG_FILE" || true)"
  [ "$hits" = 0 ] && ok 'server log: no hydrated display name, avatar URL or name-filter value' || bad "server log contains $hits fixture name/avatar/name-query line(s)"
  errs="$(grep -c -e '"level":"error"' -e '"status":5[0-9][0-9]' "$CARE_LOG_FILE" || true)"
  [ "$errs" = 0 ] && ok 'server log: no error-level or 5xx entries' || bad "server log has $errs error-level or 5xx entries"
  tok="$(grep -c 'eyJ' "$CARE_LOG_FILE" || true)"
  [ "$tok" = 0 ] && ok 'server log: no bearer token material' || bad "server log has $tok line(s) with JWT material"
  wh=0; for f in "$tmp"/worker-*.log; do [ -e "$f" ] && wh=$((wh + $(grep -c -i -e 'Synthetic QA Doctor' -e 'avatars.example.test' -e 'renamed qa' "$f" || true))); done
  [ "$wh" = 0 ] && ok 'worker logs: no display names, avatar URLs or renamed values (slice 3 sweeps included)' || bad "worker logs contain $wh name/avatar line(s)"
else
  skip 'privacy log scan: CARE_LOG_FILE not set or unreadable'
fi
# AV-R29: names exist only in Redis, never in Postgres (the whole fixture database is dumped and scanned; synthetic headlines do not contain these strings)
if command -v pg_dump >/dev/null 2>&1 && pg_dump --data-only "$CARE_OWNER_DATABASE_URL" > "$tmp/pgdump.sql" 2>"$tmp/pgdump.err" && [ -s "$tmp/pgdump.sql" ]; then
  dump_hits="$(grep -c -i -e 'synthetic qa doctor' -e 'renamed qa physician' -e 'avatars.example.test' "$tmp/pgdump.sql" || true)"
  [ "$dump_hits" = 0 ] && ok 'postgres: a full data dump of the test database contains no Identity display name or avatar URL' || bad "postgres dump contains $dump_hits display-name/avatar line(s)"
  rm -f "$tmp/pgdump.sql"
else
  skip 'postgres name scan: pg_dump not available or failed'
fi

# ================================================================================================================================
if [ "$SKIP_RATE_LIMIT" != 1 ]; then
  echo; echo '== slice 2: rate limit (profile route, per IP, runs last) =='
  [ -z "$REDIS_URL" ] || rds rlreset >/dev/null
  got429=0; n=0
  for i in $(seq 1 75); do
    n=$i
    rid="$(uuid)"
    code="$(curl -sS -o "$tmp/body" -D "$tmp/headers" -w '%{http_code}' -H "X-Request-Id: $rid" "$CARE_URL/api/doctors/8201")"
    if [ "$code" = 429 ]; then got429=1; break; fi
  done
  if [ "$got429" = 1 ] && rid_echoed && jt "$tmp/body" "b.success===false && b.error.code==='RateLimited' && b.error.requestId==='$rid'"; then
    ok "rate limit: profile route answered 429 RateLimited on request $n of this probe ($([ -n "$REDIS_URL" ] && echo 'counters reset first: the 61st request in the minute is limited' || echo 'per-instance fallback limit is 30 per minute and earlier profile calls already count')); Retry-After: $(tr -d '\r' < "$tmp/headers" | grep -i '^retry-after' | head -1 | cut -d: -f2 | tr -d ' ')"
  else
    bad "rate limit: no 429 RateLimited within 75 requests (last status $code)"
  fi
  [ -z "$REDIS_URL" ] || rds rlreset >/dev/null
fi

[ "$failed" = 0 ]
