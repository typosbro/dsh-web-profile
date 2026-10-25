#!/usr/bin/env bash
# night-batch — dry-run-first skeleton for unattended headless agent batches.
#
# Reads an explicit task list, enforces hard caps, refuses task text that looks like
# an outbound send, and writes one brief per task under docs/agent-os/runs/<stamp>/.
# Defaults to DRY RUN: it prints the plan and starts nothing. `--run` executes.
#
# Design rules (do not relax without an owner review):
#   - One task per non-blank, non-comment line in the task file; hard cap on count.
#   - Per-task wall-clock cap and a total wall-clock budget; the batch stops early
#     and marks remaining tasks skipped instead of overrunning the night.
#   - No external sends: the script itself never notifies anyone, and it refuses a
#     task file whose text mentions send/email/webhook/slack/tweet/publish/deploy/
#     transfer/charge. This is a coarse guard, not a sandbox.
#   - No secrets in the task file; briefs are written to the repo only.
#   - `--run` is required to execute anything; CI and reviewers can run dry.
#
# Usage:
#   ./scripts/night-batch.sh --tasks docs/agent-os/night-batch.tasks.example.md
#   ./scripts/night-batch.sh --tasks <file> --run --max-tasks 4
#
# Options:
#   --tasks FILE          task list (required)
#   --run                 execute (default: dry run)
#   --max-tasks N         hard cap on tasks (default: $NIGHT_MAX_TASKS or 8)
#   --task-timeout SEC    per-task cap (default: $NIGHT_TASK_TIMEOUT or 900)
#   --total-timeout SEC   whole-batch cap (default: $NIGHT_TOTAL_TIMEOUT or 3600)
#   --out DIR             run-output root (default: docs/agent-os/runs)
#   --patch FILE          headless overlay (default: profiles/headless/headless-providers.cordis.patch.yml)
#   -h, --help
#
# schedule_create later: see docs/agent-os/README.md — a daily 02:30 Asia/Seoul
# schedule can wake a durable session whose prompt runs this script with --run.
set -uo pipefail

REPO_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
TASKS_FILE=""
RUN=0
MAX_TASKS="${NIGHT_MAX_TASKS:-8}"
TASK_TIMEOUT="${NIGHT_TASK_TIMEOUT:-900}"
TOTAL_TIMEOUT="${NIGHT_TOTAL_TIMEOUT:-3600}"
OUT_ROOT="${NIGHT_OUT_ROOT:-$REPO_DIR/docs/agent-os/runs}"
PATCH_FILE="$REPO_DIR/profiles/headless/headless-providers.cordis.patch.yml"

die() { printf 'night-batch: %s\n' "$*" >&2; exit 2; }
usage() { sed -n '2,30p' "$0" | sed 's/^#\{0,1\} \{0,1\}//'; exit 0; }

require_value() { # $1 = option name, $2 = its value (may be empty); exits when absent
  if [ -z "${2:-}" ]; then die "$1 needs a value"; fi
}
while [ $# -gt 0 ]; do
  case "$1" in
    --tasks)         require_value --tasks "${2:-}";         TASKS_FILE="$2"; shift 2 ;;
    --run)           RUN=1; shift ;;
    --max-tasks)     require_value --max-tasks "${2:-}";     MAX_TASKS="$2"; shift 2 ;;
    --task-timeout)  require_value --task-timeout "${2:-}";  TASK_TIMEOUT="$2"; shift 2 ;;
    --total-timeout) require_value --total-timeout "${2:-}"; TOTAL_TIMEOUT="$2"; shift 2 ;;
    --out)           require_value --out "${2:-}";           OUT_ROOT="$2"; shift 2 ;;
    --patch)         require_value --patch "${2:-}";         PATCH_FILE="$2"; shift 2 ;;
    -h|--help)       usage ;;
    *)               die "unknown option: $1 (see --help)" ;;
  esac
done

for n in MAX_TASKS TASK_TIMEOUT TOTAL_TIMEOUT; do
  case "${!n}" in ''|*[!0-9]*) die "$n must be a positive integer" ;; esac
  [ "${!n}" -gt 0 ] || die "$n must be > 0"
done
[ -n "$TASKS_FILE" ] || die "--tasks FILE is required (see docs/agent-os/night-batch.tasks.example.md)"
[ -f "$TASKS_FILE" ] || die "task file not found: $TASKS_FILE"
[ -d "$REPO_DIR" ] || die "cannot resolve repo root"

# --- parse and guard the task list -----------------------------------------
TASKS=()
while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in ''|'#'*) continue ;; esac
  stripped="$(printf '%s' "$line" | sed -e 's/^[[:space:]]*[-*][[:space:]]*//' -e 's/[[:space:]]*$//')"
  [ -n "$stripped" ] || continue
  TASKS+=("$stripped")
done < "$TASKS_FILE"

[ "${#TASKS[@]}" -gt 0 ] || die "task file has no tasks: $TASKS_FILE"

DENY_RE='(^|[^a-z])(send|sent|email|e-mail|slack|webhook|tweet|publish|deploy|transfer|charge|invoice|dm)([^a-z]|$)'
BAD=0
i=0
while [ "$i" -lt "${#TASKS[@]}" ]; do
  if printf '%s' "${TASKS[$i]}" | tr 'A-Z' 'a-z' | grep -Eq "$DENY_RE"; then
    printf 'night-batch: task %d mentions an outbound action, refusing the file: %s\n' "$((i+1))" "${TASKS[$i]}" >&2
    BAD=1
  fi
  i=$((i+1))
done
[ "$BAD" -eq 0 ] || die "task file rejected by the no-external-sends guard; rewrite the task or run it manually"

if [ "${#TASKS[@]}" -gt "$MAX_TASKS" ]; then
  printf 'night-batch: %d tasks found, cap is %d — extra tasks will be skipped\n' "${#TASKS[@]}" "$MAX_TASKS" >&2
fi
PLANNED=$(( ${#TASKS[@]} < MAX_TASKS ? ${#TASKS[@]} : MAX_TASKS ))

# --- dry run ---------------------------------------------------------------
STAMP="$(date +%Y-%m-%dT%H%M)"
RUN_DIR="$OUT_ROOT/$STAMP"

printf '\nnight-batch plan (dry run unless --run)\n'
printf '  repo:          %s\n' "$REPO_DIR"
printf '  tasks:         %s (%d found, %d planned, cap %d)\n' "$TASKS_FILE" "${#TASKS[@]}" "$PLANNED" "$MAX_TASKS"
printf '  caps:          %ss per task, %ss total\n' "$TASK_TIMEOUT" "$TOTAL_TIMEOUT"
printf '  headless patch: %s (%s)\n' "$PATCH_FILE" "$([ -f "$PATCH_FILE" ] && echo present || echo MISSING)"
printf '  output:        %s\n' "$RUN_DIR"
printf '  external sends: blocked by guard (coarse)\n\n'

i=0
while [ "$i" -lt "$PLANNED" ]; do
  printf '  %2d. %s\n' "$((i+1))" "$(printf '%s' "${TASKS[$i]}" | cut -c1-110)"
  i=$((i+1))
done
[ "${#TASKS[@]}" -gt "$PLANNED" ] && printf '  ... %d task(s) skipped by the cap\n' "$(( ${#TASKS[@]} - PLANNED ))"

if [ "$RUN" -eq 0 ]; then
  printf '\nDry run: pass --run to execute. Nothing was started.\n'
  exit 0
fi

# --- execute ---------------------------------------------------------------
command -v dsh >/dev/null 2>&1 || die "dsh not on PATH; cannot --run"
[ -f "$PATCH_FILE" ] || die "headless patch missing: $PATCH_FILE (see profiles/headless/README.md)"

mkdir -p "$RUN_DIR" || die "cannot create $RUN_DIR"
START_EPOCH=$(date +%s)
FAILED=0

# Runs the child in its own process group and TERMs the whole group on timeout, so
# agent-spawned commands cannot outlive the cap. No `timeout` on macOS by default.
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
  "$@"
}

{
  printf '# Night batch %s\n\n' "$STAMP"
  printf '- repo: `%s`\n- tasks: `%s`\n- caps: %ss/task, %ss total\n\n' "$REPO_DIR" "$TASKS_FILE" "$TASK_TIMEOUT" "$TOTAL_TIMEOUT"
  printf '| # | status | duration | brief | task |\n|---|---|---|---|---|\n'
} > "$RUN_DIR/SUMMARY.md"

i=0
while [ "$i" -lt "$PLANNED" ]; do
  NOW=$(date +%s)
  ELAPSED=$(( NOW - START_EPOCH ))
  NUM=$(printf '%02d' "$((i+1))")
  if [ "$ELAPSED" -ge "$TOTAL_TIMEOUT" ]; then
    printf '| %s | skipped (total cap hit at %ss) | — | — | %s |\n' "$NUM" "$ELAPSED" "$(printf '%s' "${TASKS[$i]}" | tr '|\n' '  ')" >> "$RUN_DIR/SUMMARY.md"
    i=$((i+1)); continue
  fi
  TASK="${TASKS[$i]}"
  BRIEF="$RUN_DIR/$NUM-brief.md"
  RAW="$RUN_DIR/$NUM-events.jsonl"
  ERR="$RUN_DIR/$NUM-stderr.log"
  T_START=$(date +%s)
  REMAINING_BUDGET=$(( TOTAL_TIMEOUT - ELAPSED ))
  EFFECTIVE_TIMEOUT="$TASK_TIMEOUT"
  if [ "$REMAINING_BUDGET" -lt "$EFFECTIVE_TIMEOUT" ]; then EFFECTIVE_TIMEOUT="$REMAINING_BUDGET"; fi
  printf 'night-batch: [%s] %s (cap %ss)\n' "$NUM" "$(printf '%s' "$TASK" | cut -c1-80)" "$EFFECTIVE_TIMEOUT" >&2
  run_with_timeout "$EFFECTIVE_TIMEOUT" \
    dsh --profile headless --patch "$PATCH_FILE" --json "$TASK" \
    > "$RAW" 2> "$ERR"
  RC=$?
  DUR=$(( $(date +%s) - T_START ))
  if [ "$RC" -eq 0 ]; then
    STATUS="ok"
  elif [ "$RC" -eq 124 ] || [ "$RC" -eq 142 ]; then
    STATUS="timeout(${EFFECTIVE_TIMEOUT}s)"; FAILED=1
  else
    STATUS="failed(exit $RC)"; FAILED=1
  fi
  {
    printf '# %s — task %s\n\n' "$NUM" "$STATUS"
    printf '- task: %s\n- duration: %ss\n- exit: %s\n- raw events: `%s`\n- stderr: `%s`\n' \
      "$TASK" "$DUR" "$RC" "${RAW#$RUN_DIR/}" "${ERR#$RUN_DIR/}"
    printf '\n## Final answer\n\n'
    # dsh headless --json contract: opens with `session`, closes with `final`
    # ({type:"final", text}); text/thinking/tool_call/tool_result in between.
    jq -r 'select(.type=="final") | .text' "$RAW" 2>/dev/null | tail -n 40 || true
    jq -r 'select(.type=="error") | (.code // "error") + ": " + (.message // "")' "$RAW" 2>/dev/null | tail -n 5 || true
    printf '\n---\n_brief generated by scripts/night-batch.sh; verify before acting._\n'
  } > "$BRIEF"
  printf '| %s | %s | %ss | `%s` | %s |\n' "$NUM" "$STATUS" "$DUR" "${BRIEF#$RUN_DIR/}" "$(printf '%s' "$TASK" | tr '|\n' '  ')" >> "$RUN_DIR/SUMMARY.md"
  i=$((i+1))
done

REMAINING=$(( ${#TASKS[@]} - PLANNED ))
[ "$REMAINING" -gt 0 ] && printf '\n_%d task(s) skipped by --max-tasks._\n' "$REMAINING" >> "$RUN_DIR/SUMMARY.md"
printf '\nnight-batch done: %s (failed=%d)\n' "$RUN_DIR" "$FAILED" >&2
exit "$FAILED"
