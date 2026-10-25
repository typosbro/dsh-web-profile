#!/usr/bin/env bash
# consult-codex — ask OpenAI Codex for one independent answer, then exit.
#
# Why this exists: the harness's own route is OpenCode Go. Codex is a second,
# independent quota pool and a different model family, which makes it useful for
# adversarial review and for verifying a claim with a model that did not make it.
# The wrapper fixes the call shape so a skill can rely on it.
#
# Verified against codex-cli 0.162.1 (2026-10-25):
#   codex exec --skip-git-repo-check -m gpt-6.1-sol -C "$PWD" --json "..."
#
# Usage:
#   consult-codex.sh "question"                  one-shot prompt; prints final message
#   consult-codex.sh --review [PATH ...]         review the git diff against HEAD
#   consult-codex.sh --diff <file|->             review a unified diff ("-" = stdin)
#   consult-codex.sh --raw "question"            print raw JSONL events, no parsing
#
# Options:
#   --model NAME      Codex model (default: $CONSULT_CODEX_MODEL or gpt-6.1-sol)
#   --cwd DIR         working directory handed to Codex (default: $PWD)
#   --timeout SEC     wall-clock cap (default: $CONSULT_CODEX_TIMEOUT or 600)
#
# Env: CONSULT_CODEX_MODEL, CONSULT_CODEX_TIMEOUT, CONSULT_CODEX_MAX_DIFF_BYTES
#
# Exit codes: 0 answer, 2 usage/no-diff/guard, 124 timeout, 127 codex missing,
# 1 codex or parse failure. Read-only: this wrapper never edits files, never
# installs anything, and never writes config.
set -uo pipefail

MODEL="${CONSULT_CODEX_MODEL:-gpt-6.1-sol}"
TIMEOUT="${CONSULT_CODEX_TIMEOUT:-600}"
MAX_DIFF_BYTES="${CONSULT_CODEX_MAX_DIFF_BYTES:-200000}"
CWD="$PWD"
MODE="prompt"
DIFF_SOURCE=""
RAW=0
PROMPT=""
POSITIONAL=()

die() { printf 'consult-codex: %s\n' "$*" >&2; exit "${EXIT:-1}"; }

usage() { sed -n '2,32p' "$0" | sed 's/^#\{0,1\} \{0,1\}//'; exit 0; }

require_value() { # $1 = option name, $2 = its value (may be empty); exits when absent
  if [ -z "${2:-}" ]; then EXIT=2 die "$1 needs a value"; fi
}
while [ $# -gt 0 ]; do
  case "$1" in
    --model)   require_value --model "${2:-}";   MODEL="$2"; shift 2 ;;
    --cwd)     require_value --cwd "${2:-}";     CWD="$2";   shift 2 ;;
    --timeout) require_value --timeout "${2:-}"; TIMEOUT="$2"; shift 2 ;;
    --review)  MODE="review"; shift ;;
    --diff)    require_value --diff "${2:-}";    MODE="diff"; DIFF_SOURCE="$2"; shift 2 ;;
    --raw)     RAW=1; shift ;;
    -h|--help) usage ;;
    --)        shift; while [ $# -gt 0 ]; do POSITIONAL+=("$1"); shift; done ;;
    -*)        EXIT=2 die "unknown option: $1 (see --help)" ;;
    *)         POSITIONAL+=("$1"); shift ;;
  esac
done

[ -n "$MODEL" ] || EXIT=2 die "empty --model"
case "$TIMEOUT" in ''|*[!0-9]*) EXIT=2 die "--timeout must be an integer number of seconds" ;; esac
[ -d "$CWD" ] || EXIT=2 die "--cwd is not a directory: $CWD"

command -v codex >/dev/null 2>&1 \
  || EXIT=127 die "codex not on PATH; this wrapper expects codex-cli (see ~/.codex/config.toml)"

if [ "$RAW" -eq 0 ] && ! command -v jq >/dev/null 2>&1; then
  EXIT=1 die "jq is required to parse codex --json output (use --raw to bypass parsing)"
fi

# --- assemble the prompt -----------------------------------------------------
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/consult-codex.XXXXXX")" || EXIT=1 die "mktemp failed"
trap 'rm -rf "$TMP_DIR"' EXIT
PROMPT_FILE="$TMP_DIR/prompt.txt"
OUT_FILE="$TMP_DIR/out.jsonl"
ERR_FILE="$TMP_DIR/err.txt"

truncate_note() {
  if [ "$(wc -c < "$1" | tr -d ' ')" -gt "$MAX_DIFF_BYTES" ]; then
    printf '\n[... diff truncated at %s bytes; remainder omitted ...]\n' "$MAX_DIFF_BYTES"
  fi
}

case "$MODE" in
  review)
    git -C "$CWD" rev-parse --is-inside-work-tree >/dev/null 2>&1 \
      || EXIT=2 die "--review requires a git working tree (cwd: $CWD)"
    if [ "${#POSITIONAL[@]}" -gt 0 ]; then
      git -C "$CWD" diff HEAD -- "${POSITIONAL[@]}" > "$TMP_DIR/diff.txt" 2>/dev/null
    else
      git -C "$CWD" diff HEAD > "$TMP_DIR/diff.txt" 2>/dev/null
    fi
    [ -s "$TMP_DIR/diff.txt" ] || EXIT=2 die "no diff against HEAD — nothing to review"
    BRANCH="$(git -C "$CWD" rev-parse --abbrev-ref HEAD 2>/dev/null || echo detached)"
    {
      printf 'You are an independent code reviewer. Review the unified diff below from repository %s (branch %s).\n' "$(basename "$CWD")" "$BRANCH"
      printf 'Report only material findings as a terse list: severity (P1/P2/P3), file:line, what is wrong, concrete fix.\n'
      printf 'Do not report style nits, do not propose unrelated refactors. If nothing material is wrong, reply exactly: NO MATERIAL FINDINGS\n\n'
      printf 'Diff:\n```diff\n'
      head -c "$MAX_DIFF_BYTES" "$TMP_DIR/diff.txt"
      truncate_note "$TMP_DIR/diff.txt"
      printf '\n```\n'
    } > "$PROMPT_FILE"
    ;;
  diff)
    [ -n "$DIFF_SOURCE" ] || EXIT=2 die "--diff needs a file path or - for stdin"
    if [ "$DIFF_SOURCE" = "-" ]; then
      cat > "$TMP_DIR/diff.txt"
    else
      [ -f "$DIFF_SOURCE" ] || EXIT=2 die "diff file not found: $DIFF_SOURCE"
      cp "$DIFF_SOURCE" "$TMP_DIR/diff.txt"
    fi
    [ -s "$TMP_DIR/diff.txt" ] || EXIT=2 die "empty diff"
    {
      printf 'You are an independent code reviewer. Review the unified diff below.\n'
      printf 'Report only material findings as a terse list: severity (P1/P2/P3), file:line, what is wrong, concrete fix.\n'
      printf 'If nothing material is wrong, reply exactly: NO MATERIAL FINDINGS\n\n'
      printf 'Diff:\n```diff\n'
      head -c "$MAX_DIFF_BYTES" "$TMP_DIR/diff.txt"
      truncate_note "$TMP_DIR/diff.txt"
      printf '\n```\n'
    } > "$PROMPT_FILE"
    ;;
  prompt)
    [ "${#POSITIONAL[@]}" -gt 0 ] || EXIT=2 die "empty prompt — pass a question, or use --review/--diff (see --help)"
    PROMPT="${POSITIONAL[*]}"
    printf '%s' "$PROMPT" > "$PROMPT_FILE"
    ;;
esac

# --- run codex under a wall-clock cap ---------------------------------------
# The prompt goes in on stdin (`codex exec … -`), not argv: a permitted 200 KB diff
# would exceed Linux's ~128 KiB single-argument limit. The timeout runs the child in
# its own process group and TERMs the whole group, so agent-spawned commands cannot
# outlive the cap.
run_with_timeout() { # $1 seconds, rest = command
  local secs="$1"; shift
  if command -v timeout >/dev/null 2>&1; then timeout "$secs" "$@"; return $?; fi
  if command -v gtimeout >/dev/null 2>&1; then gtimeout "$secs" "$@"; return $?; fi
  if command -v perl >/dev/null 2>&1; then
    perl -e '
      my $secs = shift;
      my $pid = fork();
      if ($pid == 0) { setpgrp(0, 0); exec @ARGV; exit 127 }
      $SIG{ALRM} = sub { kill "TERM", -$pid; sleep 2; kill "KILL", -$pid; exit 124 };
      alarm $secs;
      waitpid($pid, 0);
      exit($? >> 8);
    ' "$secs" "$@"
    return $?
  fi
  "$@" <&0
}

START=$(date +%s)
run_with_timeout "$TIMEOUT" codex exec --skip-git-repo-check -m "$MODEL" -C "$CWD" --json - \
  > "$OUT_FILE" 2> "$ERR_FILE" < "$PROMPT_FILE"
RC=$?
ELAPSED=$(( $(date +%s) - START ))

if [ "$RC" -eq 124 ] || [ "$RC" -eq 142 ]; then
  printf 'consult-codex: codex exceeded --timeout %ss (process group terminated)\n' "$TIMEOUT" >&2
  tail -n 5 "$ERR_FILE" >&2 2>/dev/null
  exit 124
fi
if [ "$RC" -ne 0 ]; then
  printf 'consult-codex: codex exited %s after %ss\n' "$RC" "$ELAPSED" >&2
  tail -n 15 "$ERR_FILE" >&2 2>/dev/null
  exit "$RC"
fi
if [ ! -s "$OUT_FILE" ]; then
  printf 'consult-codex: codex produced no output (elapsed %ss)\n' "$ELAPSED" >&2
  tail -n 15 "$ERR_FILE" >&2 2>/dev/null
  exit 1
fi

if [ "$RAW" -eq 1 ]; then
  cat "$OUT_FILE"
  exit 0
fi

# Final assistant message plus the run's token usage; no answer means failure.
ANSWER="$(jq -rs 'map(select(.type=="item.completed" and .item.type=="agent_message") | .item.text) | last // empty' "$OUT_FILE" 2>/dev/null)"
if [ -z "$ANSWER" ]; then
  printf 'consult-codex: no agent_message in codex output (elapsed %ss)\n' "$ELAPSED" >&2
  tail -n 15 "$ERR_FILE" >&2 2>/dev/null
  tail -n 3 "$OUT_FILE" >&2 2>/dev/null
  exit 1
fi

USAGE="$(jq -rs 'map(select(.type=="turn.completed") | .usage) | last // empty' "$OUT_FILE" 2>/dev/null)"
if [ -n "$USAGE" ]; then
  printf '[consult-codex] model=%s in=%s cached=%s out=%s reasoning=%s elapsed=%ss\n' \
    "$MODEL" \
    "$(printf '%s' "$USAGE" | jq -r '.input_tokens // 0' 2>/dev/null)" \
    "$(printf '%s' "$USAGE" | jq -r '.cached_input_tokens // 0' 2>/dev/null)" \
    "$(printf '%s' "$USAGE" | jq -r '.output_tokens // 0' 2>/dev/null)" \
    "$(printf '%s' "$USAGE" | jq -r '.reasoning_output_tokens // 0' 2>/dev/null)" \
    "$ELAPSED" >&2
fi
printf '%s\n' "$ANSWER"
