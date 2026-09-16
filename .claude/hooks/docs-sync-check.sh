#!/usr/bin/env bash
# Stop hook — vcare cross-repo docs sync guard.
# Runs at the end of every turn in a spoke repo and checks the three sibling repos:
#   1. hub freshness (vcare-hub/scripts/check-freshness.sh)
#   2. retired terms (.claude/hooks/retired-terms.txt) in binding/shared files and hub architecture docs
#   3. drift between each spoke's service card / contract and the hub's synced copies
#   4. doc placement (hub ADR 0008): `service: platform` docs live only in the hub
# Problems → {"decision":"block"} so Claude fixes them (once per stop; a repeat stop only warns the user).
set -uo pipefail

input="$(cat 2>/dev/null || true)"
root="${CLAUDE_PROJECT_DIR:-$(pwd)}"
base="$(cd "$root/.." && pwd)"
hub="$base/vcare-hub"
problems=()

# 1. Hub freshness
if [[ -f "$hub/scripts/check-freshness.sh" ]]; then
  if ! out="$(bash "$hub/scripts/check-freshness.sh" 2>&1)"; then
    problems+=("hub freshness failed: $(printf '%s\n' "$out" | grep -E '^(STALE|MISSING)' | head -5 | tr '\n' ' ')")
  fi
fi

# 2. Retired terms in files that must never describe superseded design
terms="$root/.claude/hooks/retired-terms.txt"
if [[ -f "$terms" ]]; then
  pattern_file="$(mktemp)"
  grep -vE '^[[:space:]]*(#|$)' "$terms" > "$pattern_file"
  targets=()
  for spoke in vcare-identity-api vcare-care-api; do
    for p in CLAUDE.md .claude/skills .claude/agents .claude/commands docs/service-card.md; do
      [[ -e "$base/$spoke/$p" ]] && targets+=("$base/$spoke/$p")
    done
  done
  for p in architecture glossary.md INDEX.md; do
    [[ -e "$hub/$p" ]] && targets+=("$hub/$p")
  done
  if [[ -s "$pattern_file" && ${#targets[@]} -gt 0 ]]; then
    hits="$(grep -rnE -f "$pattern_file" "${targets[@]}" 2>/dev/null | sed "s#^$base/##" | head -8)"
    [[ -n "$hits" ]] && problems+=("retired terms found: $(printf '%s\n' "$hits" | cut -c1-160 | tr '\n' ' ')")
  fi
  rm -f "$pattern_file"
fi

# 3. Hub synced copies vs spokes (reproduces scripts/sync-from-spoke.sh transformation)
check_sync() {
  local service="$1" spoke="$2"
  local card="$base/$spoke/docs/service-card.md" hubcard="$hub/catalog/$service.card.md"
  local contract="$base/$spoke/contracts/openapi.yaml" hubcontract="$hub/contracts/$service.openapi.yaml"
  if [[ -f "$contract" && -f "$hubcontract" ]] && ! cmp -s "$contract" "$hubcontract"; then
    problems+=("hub contract for $service is stale: run (cd ../vcare-hub && scripts/sync-from-spoke.sh $service ../$spoke)")
  fi
  if [[ -f "$card" && -f "$hubcard" ]]; then
    local rel="../../$spoke"
    if ! diff -q <(sed -E "s#\]\(\.\./#](${rel}/#g; s#\]\(\./#](${rel}/docs/#g" "$card") <(tail -n +2 "$hubcard") >/dev/null; then
      problems+=("hub card for $service is stale: run (cd ../vcare-hub && scripts/sync-from-spoke.sh $service ../$spoke)")
    fi
  fi
}
[[ -d "$hub" ]] && { check_sync identity-service vcare-identity-api; check_sync care-service vcare-care-api; }

# 4. Doc placement: platform-scope docs never in a spoke; hub architecture/ and adr/ docs are platform-scope
for spoke in vcare-identity-api vcare-care-api; do
  [[ -d "$base/$spoke/docs" ]] || continue
  while IFS= read -r f; do
    [[ -n "$f" ]] && problems+=("platform-scope doc in a spoke, move it to the hub (hub ADR 0008, docs-placement skill): ${f#$base/}")
  done < <(grep -rlE '^service:[[:space:]]*platform' "$base/$spoke/docs" 2>/dev/null | head -5)
done
if [[ -d "$hub" ]]; then
  for d in architecture adr; do
    compgen -G "$hub/$d/*.md" >/dev/null || continue
    while IFS= read -r f; do
      [[ -n "$f" ]] && problems+=("hub doc without service: platform, service-scope content belongs in its spoke (hub ADR 0008): ${f#$base/}")
    done < <(grep -LE '^service:[[:space:]]*platform' "$hub/$d"/*.md 2>/dev/null | head -5)
  done
fi

[[ ${#problems[@]} -eq 0 ]] && exit 0

msg="$(printf '%s | ' "${problems[@]}")"
msg="${msg% | }"
msg="$(printf '%s' "$msg" | tr '\t\r\n' '   ' | sed 's/\\/\\\\/g; s/"/\\"/g')"

if printf '%s' "$input" | grep -qE '"stop_hook_active"[[:space:]]*:[[:space:]]*true'; then
  printf '{"systemMessage":"vcare docs sync check still failing: %s"}\n' "$msg"
else
  printf '{"decision":"block","reason":"vcare docs are out of sync across repos: %s. Update every affected doc in identity, care, and hub (see memory keep-all-repos-docs-in-sync), re-sync the hub, bump last_verified, or extend .claude/hooks/retired-terms.txt if a hit is intentional."}\n' "$msg"
fi
exit 0
