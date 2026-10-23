#!/usr/bin/env bash
# Verify an installed profile before blaming the model. Read-only: starts nothing,
# changes nothing, prints one line per check and exits non-zero on a hard failure.
set -uo pipefail

DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE_NAME="${PROFILE_NAME:-web}"
PROFILE_DIR="$DSH_HOME/profiles/$PROFILE_NAME"
REPO_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
export DSH_HOME
FAIL=0
WARN=0

ok()   { printf '  ok    %s\n' "$*"; }
warn() { printf '  warn  %s\n' "$*"; WARN=$((WARN + 1)); }
bad()  { printf '  FAIL  %s\n' "$*"; FAIL=$((FAIL + 1)); }

printf '\nDSH profile doctor — %s\n' "$PROFILE_DIR"

command -v dsh >/dev/null 2>&1 && ok "dsh $(dsh --version 2>/dev/null)" || bad "dsh not on PATH"
command -v node >/dev/null 2>&1 && ok "node $(node -v)" || bad "node missing"
command -v pnpm >/dev/null 2>&1 && ok "pnpm $(pnpm -v)" || warn "pnpm missing (needed only to reinstall)"

[ -f "$PROFILE_DIR/cordis.patch.yml" ] && ok "patch layer present" || bad "cordis.patch.yml missing"
[ -f "$PROFILE_DIR/gate/index.mjs" ] && ok "stop-gate plugin present" || warn "stop-gate plugin missing"
grep -q "@DSH_HOME@" "$PROFILE_DIR/cordis.patch.yml" 2>/dev/null \
  && bad "unsubstituted @DSH_HOME@ token in the installed patch" \
  || ok "paths substituted"

if [ -f "$PROFILE_DIR/package.json" ]; then
  grep -q '"@playwright/mcp"' "$PROFILE_DIR/package-lock.json" 2>/dev/null \
    || grep -q 'playwright/mcp' "$PROFILE_DIR/pnpm-lock.yaml" 2>/dev/null \
    && ok "playwright MCP pinned in the lockfile" || warn "no lockfile entry for @playwright/mcp"
fi

TIMEOUT_BIN=""
command -v timeout >/dev/null 2>&1 && TIMEOUT_BIN="timeout 120"
[ -z "$TIMEOUT_BIN" ] && command -v gtimeout >/dev/null 2>&1 && TIMEOUT_BIN="gtimeout 120"

if ( cd "$PROFILE_DIR" && $TIMEOUT_BIN dsh --profile "$PROFILE_NAME" --dump-config >/tmp/dsh-doctor-dump.$$ 2>/tmp/dsh-doctor-err.$$ ); then
  ok "profile composes ($(wc -l </tmp/dsh-doctor-dump.$$) lines)"
  for row in remote-auth stop-gate session-message; do
    grep -q "$row" "/tmp/dsh-doctor-dump.$$" && ok "row: $row" || warn "row missing: $row"
  done
else
  bad "profile does not compose: $(head -3 /tmp/dsh-doctor-err.$$ | tr '\n' ' ')"
fi
rm -f /tmp/dsh-doctor-dump.$$ /tmp/dsh-doctor-err.$$

if command -v google-chrome >/dev/null 2>&1 || command -v google-chrome-stable >/dev/null 2>&1 \
   || command -v chromium >/dev/null 2>&1 || command -v chrome >/dev/null 2>&1; then
  ok "system Chrome/Chromium found"
else
  warn "no system Chrome/Chromium; browser tools need one (or set WITH_PLAYWRIGHT=1)"
fi

if [ -n "${DEEPSEEK_API_KEY:-}" ] || [ -s "$DSH_HOME/.env" ] || [ -s "$DSH_HOME/.credentials.yaml" ]; then
  ok "model credentials present (value not read)"
else
  warn "no credentials found; set DEEPSEEK_API_KEY or a provider key"
fi

printf '\n%d failure(s), %d warning(s)\n\n' "$FAIL" "$WARN"
[ "$FAIL" -eq 0 ]
