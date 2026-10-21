#!/usr/bin/env bash
# upgrade.sh — move the harness to a newer release without losing the profile.
#
# Tested path: 0.2.1-alpha.1 -> 0.2.1-rc.2. The rc adds requirements the alpha satisfied
# implicitly, so a plain `npm i -g` is not enough; this script also repairs the profile:
#
#   1. bumps every exact @deepseek-ai/* profile dependency to the target,
#   2. adds the packages that used to arrive transitively (hooks bridge, hook protocol,
#      schemastery),
#   3. installs dependencies of local plugin bundles (pnpm does not install them for link: deps),
#   4. re-composes the profile and refuses to finish if it does not load.
#
# The running `dsh web` process is NOT restarted: a restart kills the session that is hosting
# the upgrade. Run this from a terminal when no turn is in flight, then restart yourself.
#
#   scripts/upgrade.sh 0.2.1-rc.2
#   DRY_RUN=1 scripts/upgrade.sh 0.2.1-rc.2
#   ROLLBACK=1 scripts/upgrade.sh 0.2.1-alpha.1
set -euo pipefail

TARGET="${1:-0.2.1-rc.2}"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE="$DSH_HOME/profiles/web"
DRY_RUN="${DRY_RUN:-0}"
ROLLBACK="${ROLLBACK:-0}"

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
run() { printf '  $ %s\n' "$*"; [ "$DRY_RUN" = 1 ] || "$@"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

[ -d "$PROFILE" ] || die "no profile at $PROFILE"

CURRENT=$(dsh --version 2>/dev/null || echo none)
say "harness $CURRENT -> $TARGET"
[ "$DRY_RUN" = 1 ] || [ "$CURRENT" != "$TARGET" ] || { echo "already on $TARGET"; exit 0; }

BACKUP="$PROFILE.bak.$(date +%Y%m%d-%H%M%S)"
say "backup"
if [ "$DRY_RUN" = 1 ]; then
  printf '  (would copy the profile to %s)\n' "$BACKUP"
else
  rsync -a --exclude node_modules --exclude .plugin-manager "$PROFILE/" "$BACKUP/"
  printf '  profile -> %s\n' "$BACKUP"
  printf '%s\n' "$CURRENT" > "$BACKUP/.previous-version"
fi

say "install harness"
run npm install --global "@deepseek-ai/dsh@$TARGET"

say "repair profile dependencies"
if [ "$DRY_RUN" = 1 ]; then
  echo "  (would bump @deepseek-ai/* pins, add hooks/hook-protocol/schemastery)"
else
  python3 - "$PROFILE/package.json" "$TARGET" <<'PY'
import json, sys
path, target = sys.argv[1], sys.argv[2]
d = json.load(open(path))
deps = d.setdefault("dependencies", {})
changed = []
for name in list(deps):
    value = deps[name]
    if name.startswith("@deepseek-ai/") and isinstance(value, str) and value.startswith("0.2."):
        if value != target:
            deps[name] = target
            changed.append(f"{name} {value} -> {target}")
for name in ("@deepseek-ai/dsh-hooks-claude-code", "@deepseek-ai/dsh-hook-protocol"):
    if name not in deps:
        deps[name] = target
        changed.append(f"{name} (added)")
if "@deepseek-ai/schemastery" not in deps:
    deps["@deepseek-ai/schemastery"] = "^3.18.5"
    changed.append("@deepseek-ai/schemastery (added)")
d["dependencies"] = dict(sorted(deps.items()))
open(path, "w").write(json.dumps(d, indent=2) + "\n")
for line in changed:
    print("  " + line)
if not changed:
    print("  nothing to change")
PY
fi

say "profile dependencies"
run bash -c "cd '$PROFILE' && pnpm install --reporter=append-only"

say "plugin dependencies"
for dir in "$HOME"/dsh-plugins/*/ "$DSH_HOME"/plugins/*/; do
  [ -f "$dir/package.json" ] || continue
  if python3 -c "import json,sys; d=json.load(open('$dir/package.json')); sys.exit(0 if d.get('dependencies') else 1)" 2>/dev/null; then
    run bash -c "cd '$dir' && pnpm install --lockfile=false --reporter=append-only"
  fi
done

say "compose"
if [ "$DRY_RUN" = 1 ]; then
  echo "  (would run: dsh --profile web --dump-config)"
else
  dsh --profile web --dump-config > /tmp/dsh-upgrade-dump.$$ 2>/tmp/dsh-upgrade-err.$$
  rows=$(grep -c '^- id:' /tmp/dsh-upgrade-dump.$$ || true)
  printf '  %s rows composed\n' "$rows"
  rm -f /tmp/dsh-upgrade-dump.$$ /tmp/dsh-upgrade-err.$$
fi

if [ "$ROLLBACK" = 1 ]; then
  say "rollback"
  echo "restore the profile from $BACKUP and reinstall the previous harness:"
  echo "  rm -rf '$PROFILE' && cp -a '$BACKUP' '$PROFILE'"
  echo "  npm install --global '@deepseek-ai/dsh@$(cat "$BACKUP/.previous-version" 2>/dev/null || echo 0.2.1-alpha.1)'"
fi

say "done"
cat <<EOF
Now restart the harness when no turn is in flight:

  # stop the current process, then
  dsh web

A restart ends any live turn. Sessions are persisted, so history survives; the in-flight
response does not. Rollback: ROLLBACK=1 scripts/upgrade.sh <previous-version>
EOF
