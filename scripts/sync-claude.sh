#!/usr/bin/env bash
# Install the Claude Code user config from this repo into ~/.claude.
#
# Authoring lives in claude/ (CLAUDE.md, settings.json, hooks/) and skills/ (the subset named
# in claude/skills.txt); this script is the only deployment path, so a dead disk or a new
# machine loses nothing that is not also on the remote. Differing live files are backed up
# before they are replaced. Claude Code's own state (history, sessions, projects, plugins,
# the claude.ai-managed skills/synced/) is not touched.
#
#   scripts/sync-claude.sh          install
#   scripts/sync-claude.sh --check  report drift between repo and ~/.claude, exit 1 on any
#                                   (live edits, e.g. from /config, belong back in claude/)
set -euo pipefail

REPO_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$REPO_DIR/claude"
DEST="${CLAUDE_HOME:-$HOME/.claude}"
CHECK=0
[ "${1:-}" = "--check" ] && CHECK=1

[ -f "$SRC/CLAUDE.md" ] || { printf 'missing %s/CLAUDE.md\n' "$SRC" >&2; exit 1; }

FILES=(CLAUDE.md settings.json)
for f in "$SRC"/hooks/*; do FILES+=("hooks/$(basename "$f")"); done
SKILLS=()
while IFS= read -r s; do [ -n "$s" ] && SKILLS+=("$s"); done < "$SRC/skills.txt"

if [ "$CHECK" = 1 ]; then
  DRIFT=0
  for f in "${FILES[@]}"; do
    cmp -s "$SRC/$f" "$DEST/$f" || { printf 'drift  %s\n' "$f"; DRIFT=1; }
  done
  for s in "${SKILLS[@]}"; do
    diff -rq "$REPO_DIR/skills/$s" "$DEST/skills/$s" >/dev/null 2>&1 \
      || { printf 'drift  skills/%s\n' "$s"; DRIFT=1; }
  done
  [ "$DRIFT" = 0 ] && printf 'claude config in sync with %s\n' "$REPO_DIR"
  exit "$DRIFT"
fi

STAMP="$(date +%Y%m%d-%H%M%S)"
mkdir -p "$DEST/hooks" "$DEST/skills"
for f in "${FILES[@]}"; do
  if [ -f "$DEST/$f" ] && ! cmp -s "$SRC/$f" "$DEST/$f"; then
    cp "$DEST/$f" "$DEST/$f.bak.$STAMP"
    printf 'backed up existing %s\n' "$f"
  fi
  case "$f" in hooks/*) mode=0755 ;; *) mode=0644 ;; esac
  install -m "$mode" "$SRC/$f" "$DEST/$f"
done
for s in "${SKILLS[@]}"; do
  [ -d "$REPO_DIR/skills/$s" ] || { printf 'skill listed but missing: %s\n' "$s" >&2; exit 1; }
  rsync -a --delete --exclude .DS_Store "$REPO_DIR/skills/$s/" "$DEST/skills/$s/"
done
printf 'synced %s files and %s skills -> %s\n' "${#FILES[@]}" "${#SKILLS[@]}" "$DEST"
