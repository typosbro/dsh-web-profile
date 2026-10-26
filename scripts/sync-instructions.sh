#!/usr/bin/env bash
# Install the user-global operator instructions into the Harness home.
#
# The agent-instructions plugin reads $DSH_HOME/AGENTS.md at the first request of
# every session, in every project. Authoring lives in instructions/AGENTS.md; this
# script is the only deployment path, so a rebuild cannot silently lose the contract.
set -euo pipefail

REPO_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="${DSH_HOME:-$HOME/.dsh}"
SRC="$REPO_DIR/instructions/AGENTS.md"

[ -f "$SRC" ] || { printf 'missing %s\n' "$SRC" >&2; exit 1; }

mkdir -p "$DEST"
if [ -f "$DEST/AGENTS.md" ] && ! cmp -s "$SRC" "$DEST/AGENTS.md"; then
  cp "$DEST/AGENTS.md" "$DEST/AGENTS.md.bak.$(date +%Y%m%d-%H%M%S)"
  printf 'backed up existing %s/AGENTS.md\n' "$DEST"
fi
install -m 0644 "$SRC" "$DEST/AGENTS.md"
printf 'synced global instructions -> %s/AGENTS.md\n' "$DEST"
