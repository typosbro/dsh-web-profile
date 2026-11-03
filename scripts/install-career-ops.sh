#!/usr/bin/env bash
# Install the private career-ops repository and its scheduled jobs.
#
#   ./scripts/install-career-ops.sh                clone (if absent) + install deps
#   ./scripts/install-career-ops.sh --skip-clone   no GitHub access; only check/wire
#
# career-ops is a private repo, so it is not vendored in this public backup:
#   source  git@github.com:career-ops-hq/career-ops.git  ->  ~/Documents/private/career-ops
#   data    ~/agent-memory/career-ops                     (never in either repo)
#   backups ~/.career-ops/backups
# Requires SSH access to GitHub. Safe to re-run: an existing clone is only fetched.
set -euo pipefail

REPO_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="${CAREER_OPS_DIR:-$HOME/Documents/private/career-ops}"
REMOTE="${CAREER_OPS_REMOTE:-git@github.com:career-ops-hq/career-ops.git}"
DATA_DIR="${CAREER_OPS_DATA:-$HOME/agent-memory/career-ops}"
BACKUP_DIR="$HOME/.career-ops/backups"
SKIP_CLONE=0
for arg in "$@"; do
  case "$arg" in
    --skip-clone) SKIP_CLONE=1 ;;
    -h|--help) sed -n '2,13p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) printf 'error: unknown argument %s\n' "$arg" >&2; exit 1 ;;
  esac
done

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
note() { printf '  %s\n' "$*"; }

say "preflight"
command -v node >/dev/null || { printf 'error: node missing\n' >&2; exit 1; }
command -v git >/dev/null || { printf 'error: git missing\n' >&2; exit 1; }

say "repository"
if [ -d "$TARGET/.git" ]; then
  note "existing clone at $TARGET"
  if ! git -C "$TARGET" fetch --quiet origin 2>/dev/null; then
    note "fetch failed (no SSH access?) — continuing with the local checkout"
  fi
  note "on $(git -C "$TARGET" rev-parse --short HEAD 2>/dev/null || echo unknown)"
elif [ "$SKIP_CLONE" = "1" ]; then
  note "--skip-clone: expected an existing checkout at $TARGET"
else
  mkdir -p "$(dirname "$TARGET")"
  git clone "$REMOTE" "$TARGET"
fi

say "dependencies"
if [ -f "$TARGET/package.json" ]; then
  if command -v pnpm >/dev/null; then
    ( cd "$TARGET" && pnpm install --reporter=append-only )
  else
    ( cd "$TARGET" && npm install --no-audit --no-fund )
  fi
else
  note "no package.json in $TARGET (nothing to install here)"
fi

say "data and backups"
note "career-ops data:     $DATA_DIR (outside git; back it up separately)"
note "userdata backups:    $BACKUP_DIR"
if command -v npm >/dev/null 2>&1 && [ -f "$TARGET/scan.mjs" ]; then
  note "scheduled jobs: com.typosbro.career-ops-scan / -funding"
  note "install their plists with ./scripts/install-services.sh (they run scan.mjs)"
else
  note "no scan.mjs found; check the private repo's docs for the job entrypoint"
fi

say "done"
cat <<EOF
Next (owner actions):
  1. Fill $TARGET/.env or the config the private repo documents.
  2. Restore user data from $BACKUP_DIR if this is a fresh machine.
  3. Load the two career-ops jobs:
       ./scripts/install-services.sh --load
EOF
