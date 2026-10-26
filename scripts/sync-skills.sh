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

mkdir -p "$DEST"
rsync -a --delete --exclude .DS_Store "$REPO_DIR/skills/" "$DEST/"
printf 'synced %s skills -> %s\n' \
  "$(find "$DEST" -maxdepth 1 -mindepth 1 -type d | wc -l | tr -d ' ')" "$DEST"
