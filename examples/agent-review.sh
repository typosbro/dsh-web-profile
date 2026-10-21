#!/usr/bin/env bash
# agent-review.sh — the diff-level review stage the stop hook runs after a green gate.
#
# Copy to <repo>/scripts/agent-review.sh and make it executable. It receives no arguments and
# runs with the repository as cwd. Exit non-zero to block the end of the turn; print the reason
# on stderr so the model can act on it.
#
# What this checks is deliberately narrow: things a test suite cannot catch and a human reviewer
# should not have to. It fails on leaked credentials, conflict markers, and debugger statements;
# it warns (without failing) about source changes with no test change.
set -euo pipefail

fail=0
warn=0
note() { printf '%s\n' "$*" >&2; }
bad()  { note "review: $*"; fail=1; }
soft() { note "review (warning): $*"; warn=1; }

# Work against the working tree, including staged and unstaged changes.
DIFF=$(git diff HEAD -- . 2>/dev/null || true)
[ -n "$DIFF" ] || exit 0

# 1. Credentials that should never reach a commit.
if printf '%s' "$DIFF" | grep -nE '^\+.*(sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|oc_sk_[A-Za-z0-9]{10,}|-----BEGIN (RSA |OPENSSH |EC )?PRIVATE KEY-----)' >&2; then
  bad "a credential-looking string was added; remove it and rotate the key if it was real"
fi

# 2. Unresolved merge state.
if printf '%s' "$DIFF" | grep -nE '^\+(<{7}|={7}|>{7})' >&2; then
  bad "merge conflict markers were added"
fi

# 3. Debug leftovers.
if printf '%s' "$DIFF" | grep -nE '^\+.*\bdebugger\b' >&2; then
  bad "a debugger statement was added"
fi

# 4. Source changes without a test change. A warning, not a failure: not every change needs one.
changed=$(printf '%s\n' "$DIFF" | sed -n 's|^+++ b/||p' | grep -v '^/dev/null$' || true)
if [ -n "$changed" ]; then
  src=$(printf '%s\n' "$changed" | grep -E '\.(ts|tsx|js|jsx|py|go|rs|rb|java|kt)$' | grep -vE '(^|/)(test|tests|spec|__tests__)/|\.(test|spec)\.' || true)
  tests=$(printf '%s\n' "$changed" | grep -E '(^|/)(test|tests|spec|__tests__)/|\.(test|spec)\.' || true)
  if [ -n "$src" ] && [ -z "$tests" ]; then
    soft "source changed with no test change: $(printf '%s' "$src" | head -3 | tr '\n' ' ')"
  fi
fi

exit "$fail"
