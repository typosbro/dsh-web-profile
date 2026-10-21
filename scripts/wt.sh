#!/usr/bin/env bash
# wt.sh — one git worktree per task, so parallel agents cannot edit each other's files.
#
#   wt.sh new <branch> [base]   create ../<repo>.wt/<branch> on a new branch
#   wt.sh list                  list worktrees
#   wt.sh finish <branch>       run the repo gate inside it, then print the merge command
#   wt.sh rm <branch>           remove the worktree (branch is kept)
#
# Worktrees live beside the repository, never inside it: a worktree inside the repo is
# visible to every other agent's file walk and to every glob.
set -euo pipefail

ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || { echo "wt: not inside a git repository" >&2; exit 2; }
NAME=$(basename "$ROOT")
BASE_DIR="${WT_DIR:-$(dirname "$ROOT")/$NAME.wt}"

dir_for() { printf '%s/%s' "$BASE_DIR" "$(printf '%s' "$1" | tr '/' '-')"; }

usage() {
  sed -n '3,9p' "$0" | sed 's/^# \{0,1\}//'
}

run_gate() {
  local dir="$1"
  if [ -f "$dir/scripts/agent-gate.sh" ]; then
    ( cd "$dir" && bash scripts/agent-gate.sh )
  elif [ -f "$dir/package.json" ] && jq -e '.scripts.gate // empty' "$dir/package.json" >/dev/null 2>&1; then
    ( cd "$dir" && pnpm -s gate )
  elif [ -f "$dir/package.json" ] && jq -e '.scripts["gate:fast"] // empty' "$dir/package.json" >/dev/null 2>&1; then
    ( cd "$dir" && pnpm -s gate:fast )
  else
    echo "wt: no gate in $dir; skipping"
  fi
}

case "${1:-}" in
  new)
    branch="${2:?usage: wt.sh new <branch> [base]}"
    base="${3:-HEAD}"
    dir=$(dir_for "$branch")
    mkdir -p "$BASE_DIR"
    git -C "$ROOT" worktree add -b "$branch" "$dir" "$base"
    printf '\nworktree: %s\nbranch:   %s\n' "$dir" "$branch"
    ;;
  list)
    git -C "$ROOT" worktree list
    ;;
  finish)
    branch="${2:?usage: wt.sh finish <branch>}"
    dir=$(dir_for "$branch")
    [ -d "$dir" ] || { echo "wt: no worktree for $branch" >&2; exit 2; }
    run_gate "$dir"
    printf '\ngate passed.\nmerge:  git -C %q merge --no-ff %q\nclean:  %q rm %q\n' "$ROOT" "$branch" "$0" "$branch"
    ;;
  rm)
    branch="${2:?usage: wt.sh rm <branch>}"
    dir=$(dir_for "$branch")
    git -C "$ROOT" worktree remove --force "$dir"
    echo "removed $dir (branch $branch kept)"
    ;;
  *)
    usage
    exit 2
    ;;
esac
