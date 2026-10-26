#!/usr/bin/env bash
# The repository's own gate.
#
# The stop-gate plugin runs this before a turn may end when the session's working
# directory is this repo. Until 2026-10-26 this file did not exist, so the repo that
# ships the stop gate had nothing for it to run — the gate was decoration here.
#
# Cheap, deterministic, no network. Exit 2 blocks the turn; any other non-zero exit is
# a plain failure the caller reports.
set -uo pipefail

cd "$(dirname -- "${BASH_SOURCE[0]}")/.." || exit 1
fail=0

# 1. Shell syntax.
while IFS= read -r f; do
  bash -n "$f" || { echo "shell syntax: $f" >&2; fail=1; }
done < <(find . -name '*.sh' -not -path './node_modules/*' -not -path '*/node_modules/*' -not -path './.git/*')

# 2. ESM syntax. .mjs only: .js files here live under packages whose type is decided
#    by their own package.json, and node --check would guess wrong on some of them.
while IFS= read -r f; do
  node --check "$f" || { echo "js syntax: $f" >&2; fail=1; }
done < <(find . -name '*.mjs' -not -path '*/node_modules/*' -not -path './.git/*')

# 3. Composition. A sandbox that cannot write the profile root must not read as a
#    compose failure: the night-batch child sandbox hits EPERM on the profile
#    cordis.yml and would otherwise report a false defect.
if ! out=$(dsh --profile web --dump-config 2>&1 >/dev/null); then
  case "$out" in
    *EPERM* | *"Operation not permitted"*) : ;;
    *)
      printf 'profile does not compose: %s\n' "$(printf '%s' "$out" | head -3)" >&2
      fail=1
      ;;
  esac
fi

exit "$fail"
