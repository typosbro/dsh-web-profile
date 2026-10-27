#!/usr/bin/env bash
# Mirror this repo's skills into the Harness user skill root.
#
# Skills must be installed in a stable root (~/.dsh/skills), not only inside a
# project checkout: the filesystem skill provider scans the nearest `.git`
# ancestor as the project root, so repo-local skills vanish the moment a session
# starts in another directory. Authoring lives here; deployment lands there.
set -euo pipefail

REPO_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="${DSH_HOME:-$HOME/.dsh}/skills"

# Per skill, never --delete at the root: the same root also holds the portable skills that
# agent-kit installs (../agent-kit/install.sh dsh).
mkdir -p "$DEST"
n=0
for src in "$REPO_DIR"/skills/*/; do
  rsync -a --delete --exclude .DS_Store "$src" "$DEST/$(basename "$src")/"
  n=$((n + 1))
done
printf 'synced %s DSH-only skills -> %s\n' "$n" "$DEST"
