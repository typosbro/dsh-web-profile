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
[ -f "$DSH_HOME/AGENTS.md" ] && grep -q '^# Operator mode' "$DSH_HOME/AGENTS.md" \
  && ok "global operator instructions installed" \
  || warn "global operator instructions missing or stale (run agent-kit/install.sh dsh)"

KIT_DIR="${AGENT_KIT_DIR:-$(dirname "$REPO_DIR")/agent-kit}"
if [ -x "$KIT_DIR/install.sh" ]; then
  "$KIT_DIR/install.sh" --check dsh >/dev/null 2>&1 \
    && ok "agent-kit instructions and skills in sync" \
    || warn "agent-kit drift (run $KIT_DIR/install.sh --check dsh)"
else
  warn "agent-kit missing at $KIT_DIR (clone typosbro/agent-kit)"
fi

# Agent-OS tooling shipped in this repo (optional; a fresh clone should have it).
for tool in scripts/night-batch.sh scripts/usage-meter.mjs scripts/context-audit.mjs; do
  [ -x "$REPO_DIR/$tool" ] && ok "tool: $tool" || warn "tool missing or not executable: $tool"
done
[ -f "$DSH_HOME/skills/consult-codex/SKILL.md" ] \
  && ok "skill: consult-codex (agent-kit)" || warn "skill missing: consult-codex (agent-kit)"
[ -f "$REPO_DIR/profiles/headless/headless-providers.cordis.patch.yml" ] \
  && ok "headless provider overlay present" || warn "headless provider overlay missing"
[ -f "$PROFILE_DIR/gate/index.mjs" ] && ok "stop-gate plugin present" || warn "stop-gate plugin missing"
grep -q "@DSH_HOME@" "$PROFILE_DIR/cordis.patch.yml" 2>/dev/null \
  && bad "unsubstituted @DSH_HOME@ token in the installed patch" \
  || ok "paths substituted"

# A self-armed reload job killed the harness every 90s on 2026-10-26 (six turns lost).
# It must never be loaded: a restart is an owner action, not something a turn schedules.
if launchctl list 2>/dev/null | grep -q 'dsh-reload'; then
  bad "a dsh-reload job is loaded — it kickstarts the web service on a timer (run: launchctl remove <label>)"
else
  ok "no self-armed harness reload job"
fi
if grep -Rqs 'kickstart' "$HOME/Library/LaunchAgents" 2>/dev/null; then
  bad "a LaunchAgent under ~/Library/LaunchAgents runs kickstart — a self-armed reload would outlive a logout"
else
  ok "no LaunchAgent runs kickstart"
fi

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
  grep -q 'maxDepth: 2' "/tmp/dsh-doctor-dump.$$" \
    && ok "orchestrator preset: subagent maxDepth 2" \
    || warn "orchestrator preset: no maxDepth 2 (Web preset editor may override the file)"
  grep -q 'fetchProvider: http' "/tmp/dsh-doctor-dump.$$" \
    && ok "web fetch provider named explicitly" \
    || bad "web fetch provider ambiguous: web_fetch will fail (see plugins/web-search/cordis.patch.yml)"
  grep -q 'dsh-hooks-claude-code' "/tmp/dsh-doctor-dump.$$" \
    && bad "dead hook bridge mounted (hooks/ was removed 2026-10-26)" \
    || ok "no dead hook bridge"
  grep -q 'preset-worker' "/tmp/dsh-doctor-dump.$$" \
    && ok "worker preset registered" \
    || warn "worker preset not registered"
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

# Credential sources: the CLI reads ~/.dsh/.env, the running web process reads the
# credential store. Drift between them is what made headless fail while the web app
# worked. Compare without printing either value.
ENV_GO="$(grep -m1 '^OPENCODE_GO_API_KEY=' "$DSH_HOME/.env" 2>/dev/null | cut -d= -f2-)"
STORE_GO="$(awk '/^[[:space:]]*OPENCODE_GO_API_KEY:/{sub(/^[[:space:]]*OPENCODE_GO_API_KEY:[[:space:]]*/,"");print;exit}' "$DSH_HOME/.credentials.yaml" 2>/dev/null | tr -d '\"'"'"'')"
if [ -n "$ENV_GO" ] && [ -n "$STORE_GO" ]; then
  [ "$ENV_GO" = "$STORE_GO" ] \
    && ok "env and credential store agree" \
    || warn "env and credential store disagree: CLI reads .env, web reads the store"
fi

grep -q 'opencode-go' "$DSH_HOME/profiles/headless/cordis.patch.yml" 2>/dev/null \
  && ok "headless route patched" \
  || warn "headless route not patched (night batch cannot authenticate)"
[ -f "$DSH_HOME/hooks/hooks.json" ] \
  && warn "dead hook file present at ~/.dsh/hooks/hooks.json (bridge is not mounted)" \
  || ok "no dead hook file"

# --- restored stack: profiles, voice, Discord, services -----------------------
WEB_PKG="$DSH_HOME/profiles/web/package.json"
if grep -q '"@local/voice-mode"' "$WEB_PKG" 2>/dev/null; then
  ok "voice-mode plugin linked in the web profile"
else
  warn "voice-mode plugin missing from the web profile (run ./bootstrap.sh)"
fi
if grep -q '"@addozhang/dsh-discord"' "$WEB_PKG" 2>/dev/null; then
  ok "Discord text adapter installed in the web profile"
else
  warn "Discord adapter missing (./bootstrap.sh; then Settings -> Discord for the token)"
fi
if [ -f "$DSH_HOME/profiles/web/cordis.patch.yml" ] \
   && ! grep -q 'allowedGuildIds: \[\]' "$DSH_HOME/profiles/web/cordis.patch.yml"; then
  ok "Discord guild allowlist configured"
else
  warn "Discord guild allowlist is empty (Settings -> Discord)"
fi
if [ -f "$DSH_HOME/profiles/superagent/package.json" ]; then
  ok "superagent profile installed"
  if [ -d "$DSH_HOME/profiles/superagent/plugin/lib" ] \
     || [ -d "$DSH_HOME/profiles/superagent/node_modules/dsh-superagent/lib" ]; then
    ok "superagent plugin present and built (lib/)"
  else
    warn "superagent plugin missing its built lib/"
  fi
  grep -q '@DSH_HOME@' "$DSH_HOME/profiles/superagent/cordis.patch.yml" 2>/dev/null \
    && bad "unsubstituted @DSH_HOME@ token in the superagent patch" \
    || ok "superagent paths substituted"
else
  warn "superagent profile not installed (bootstrap installs it)"
fi
if [ -d "$DSH_HOME/services/voice-bridge/src" ]; then
  ok "voice bridge sidecar staged (WITH_SERVICES=1)"
  [ -f "$HOME/.config/dsh-superagent/voice-bridge.json" ] \
    && ok "voice bridge config present" \
    || warn "voice bridge config missing (~/.config/dsh-superagent/voice-bridge.json)"
else
  warn "voice bridge not staged (WITH_SERVICES=1 ./bootstrap.sh)"
fi
if command -v curl >/dev/null 2>&1 && curl -s -m 2 http://127.0.0.1:3080/voice-mode/status >/dev/null 2>&1; then
  ok "local voice routes answer on :3080"
else
  warn "local voice routes not reachable (is dsh web running?)"
fi

# Supply chain: community plugins must be pinned exactly (docs/supply-chain.md).
UNPINNED="$(python3 - "$WEB_PKG" <<'PY'
import json, sys
try:
    deps = json.load(open(sys.argv[1])).get('dependencies') or {}
except Exception:
    raise SystemExit
ranged = [name for name, spec in deps.items()
          if isinstance(spec, str) and (spec.startswith('^') or spec.startswith('~'))]
print(' '.join(ranged))
PY
)"
if [ -n "$UNPINNED" ]; then
  warn "community dependencies use version ranges: $UNPINNED (pin exact; docs/supply-chain.md)"
else
  ok "all profile dependencies pinned exactly"
fi

printf '\n%d failure(s), %d warning(s)\n\n' "$FAIL" "$WARN"
[ "$FAIL" -eq 0 ]
