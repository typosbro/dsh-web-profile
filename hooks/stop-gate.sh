#!/usr/bin/env bash
#
# Stop hook for the DeepSeek Harness, mounted through the Claude Code hook bridge.
#
# Runs the current repository's own checks and blocks the end of the turn when one fails, so a
# turn cannot end on "looks done" when a check was available. The repository opts in by
# exposing a script; nothing runs in a repository that has not opted in.
#
# Contract (see dsh-hook-protocol): the payload arrives on stdin as JSON. Exit 2 blocks the
# stop and stderr becomes the steering reason. Any other exit code is non-blocking.
#
# Opt-in order, all optional and run in this order:
#   1. <repo>/scripts/agent-gate.sh      — the repository's own full gate
#   2. package.json "gate" script        — full gate
#   3. package.json "gate:fast" script   — fast gate
#   4. <repo>/scripts/agent-review.sh    — diff-level review stage, runs after a passing gate
# Nothing found means exit 0 immediately.
#
# Two guards keep this from becoming a tax or a loop:
#   - A clean git tree skips every check. Nothing changed, nothing to check.
#   - At most two forced continuations per session before the hook stands down, so a
#     pre-existing breakage cannot trap the turn forever.

set -u

STATE_DIR="/tmp/dsh-stop-gate"
MAX_BLOCKS=2

INPUT=$(cat 2>/dev/null || true)
DIR=$(printf '%s' "$INPUT" | jq -r '.cwd // empty' 2>/dev/null || true)
SESSION=$(printf '%s' "$INPUT" | jq -r '.session_id // empty' 2>/dev/null || true)

[ -n "$DIR" ] || DIR="$PWD"
[ -d "$DIR" ] || exit 0
[ -n "$SESSION" ] || SESSION="nosession"

# Hooks may run with a scrubbed environment. Put the user-local bin first (node,
# pnpm, dsh live there on a default install) and, when node is already resolved,
# its own directory too, so a custom runtime location keeps working.
case ":$PATH:" in
  *":$HOME/.local/bin:"*) ;;
  *) PATH="$HOME/.local/bin:$PATH" ;;
esac
if NODE_BIN=$(command -v node 2>/dev/null) && [ -n "$NODE_BIN" ]; then
  NODE_DIR=$(dirname "$NODE_BIN")
  case ":$PATH:" in
    *":$NODE_DIR:"*) ;;
    *) PATH="$NODE_DIR:$PATH" ;;
  esac
fi
export PATH

mkdir -p "$STATE_DIR" 2>/dev/null || STATE_DIR="/tmp"
COUNT_FILE="$STATE_DIR/stop-gate-$(printf '%s' "$SESSION" | tr -c 'A-Za-z0-9_-' '_')"

# Nothing changed since the last commit means nothing this turn could have broken.
if git -C "$DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  if [ -z "$(git -C "$DIR" status --porcelain 2>/dev/null)" ]; then
    rm -f "$COUNT_FILE"
    exit 0
  fi
fi

GATE_LABEL=""
if [ -f "$DIR/scripts/agent-gate.sh" ]; then
  GATE_LABEL="scripts/agent-gate.sh"
  run_gate() { ( cd "$DIR" && bash scripts/agent-gate.sh ); }
elif [ -f "$DIR/package.json" ] && jq -e '.scripts.gate // empty' "$DIR/package.json" >/dev/null 2>&1; then
  command -v pnpm >/dev/null 2>&1 || exit 0
  GATE_LABEL="pnpm gate"
  run_gate() { ( cd "$DIR" && pnpm -s gate ); }
elif [ -f "$DIR/package.json" ] && jq -e '.scripts["gate:fast"] // empty' "$DIR/package.json" >/dev/null 2>&1; then
  command -v pnpm >/dev/null 2>&1 || exit 0
  GATE_LABEL="pnpm gate:fast"
  run_gate() { ( cd "$DIR" && pnpm -s gate:fast ); }
fi

REVIEW_LABEL=""
if [ -f "$DIR/scripts/agent-review.sh" ]; then
  REVIEW_LABEL="scripts/agent-review.sh"
fi

[ -n "$GATE_LABEL" ] || [ -n "$REVIEW_LABEL" ] || exit 0

OUT=$(mktemp 2>/dev/null) || exit 0

# Shared block path: count, cap, then steer the model with the tail of the output.
block_on() {
  local label="$1" count
  count=$(cat "$COUNT_FILE" 2>/dev/null || echo 0)
  case "$count" in ''|*[!0-9]*) count=0 ;; esac
  count=$((count + 1))
  if [ "$count" -gt "$MAX_BLOCKS" ]; then
    rm -f "$COUNT_FILE" "$OUT"
    exit 0
  fi
  printf '%s' "$count" > "$COUNT_FILE"
  {
    printf 'The check failed: %s in %s\n' "$label" "$DIR"
    printf 'This turn cannot end until it passes, or until the hook has blocked twice.\n'
    printf 'Run the same command yourself to see the full output. The tail follows.\n\n'
    tail -n 40 "$OUT"
  } >&2
  rm -f "$OUT"
  exit 2
}

if [ -n "$GATE_LABEL" ] && ! run_gate >"$OUT" 2>&1; then
  block_on "$GATE_LABEL"
fi

# The review stage sees a green gate; it is for judgement a test suite cannot express:
# diff scope, missing tests, unsafe edits.
if [ -n "$REVIEW_LABEL" ] && ! ( cd "$DIR" && bash scripts/agent-review.sh ) >"$OUT" 2>&1; then
  block_on "$REVIEW_LABEL"
fi

rm -f "$OUT" "$COUNT_FILE"
exit 0
