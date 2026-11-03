#!/usr/bin/env bash
# One-command restore of this DSH home: profiles, plugins, presets, skills, the
# voice stack, and the optional support services.
#
#   ./bootstrap.sh                     install everything that needs no private credentials
#   FORCE=1 ./bootstrap.sh             replace an existing web profile (timestamped backup kept)
#   WITH_PLAYWRIGHT=1 ./bootstrap.sh   also download the Chromium Playwright build
#   WITH_SERVICES=1 ./bootstrap.sh     also stage the voice-bridge + launchd plists
#   WITH_CAREER_OPS=1 ./bootstrap.sh   also clone/install the private career-ops repo
#   WITH_DESKTOP=1 ./bootstrap.sh      also refresh the Desktop app's profile files
#   DSH_HOME=/opt/dsh ./bootstrap.sh   install somewhere else
#
# Read-only about secrets: this script never writes API keys or bot tokens. It
# prints exactly which files the owner still has to fill, at the end.
set -euo pipefail

REPO_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PRIMARY_PROFILE="${PROFILE_NAME:-web}"
DSH_VERSION="${DSH_VERSION:-0.2.1-rc.2}"
CACHE_DIR="${XDG_CACHE_HOME:-$HOME/.cache}"
FORCE="${FORCE:-0}"
WITH_PLAYWRIGHT="${WITH_PLAYWRIGHT:-0}"
WITH_SERVICES="${WITH_SERVICES:-0}"
WITH_CAREER_OPS="${WITH_CAREER_OPS:-0}"
WITH_DESKTOP="${WITH_DESKTOP:-0}"
SERVICES_DIR="$DSH_HOME/services"

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
note() { printf '  %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

say "preflight"
command -v node >/dev/null || die "node is not installed (need >= 22)"
command -v pnpm >/dev/null || die "pnpm is not installed (corepack enable)"
command -v rsync >/dev/null || die "rsync is not installed"
command -v python3 >/dev/null || die "python3 is not installed"
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' \
  || die "node $(node -v) is too old; DSH needs >= 22"
NODE_BIN="$(command -v node)"
say "node $NODE_BIN, pnpm $(pnpm -v), DSH_HOME $DSH_HOME, dsh $DSH_VERSION"

say "harness"
if ! command -v dsh >/dev/null 2>&1 || [ "$(dsh --version 2>/dev/null || true)" != "$DSH_VERSION" ]; then
  npm install --global "@deepseek-ai/dsh@$DSH_VERSION"
else
  printf 'dsh %s already installed\n' "$DSH_VERSION"
fi

mkdir -p "$DSH_HOME/profiles" "$DSH_HOME/plugins" "$DSH_HOME/presets" \
         "$CACHE_DIR/dsh-browser-profile" "$CACHE_DIR/dsh-browser-out"

# install_profile <name> <required|optional>
install_profile() {
  local name="$1" mode="${2:-required}"
  local src="$REPO_DIR/profiles/$name"
  local dst="$DSH_HOME/profiles/$name"
  [ -d "$src" ] || { [ "$mode" = optional ] || die "profile source missing: $src"; return 0; }
  if [ -e "$dst" ]; then
    if [ "$FORCE" != "1" ]; then
      say "profile $name (exists, kept — FORCE=1 to replace)"
      return 0
    fi
    local backup="$dst.bak.$(date +%Y%m%d-%H%M%S)"
    mv "$dst" "$backup"
    note "backed up existing profile to $backup"
  fi
  say "profile $name"
  rsync -a --delete "$src/" "$dst/"
}

install_profile web required
install_profile superagent optional
install_profile headless optional
if [ "$WITH_DESKTOP" = "1" ]; then
  install_profile desktop optional
else
  note "desktop profile skipped (app-managed; use ./install-desktop.sh or WITH_DESKTOP=1)"
fi

say "plugins and presets"
rsync -a --delete --exclude node_modules --exclude .git "$REPO_DIR/plugins/" "$DSH_HOME/plugins/"
rsync -a --delete --exclude node_modules --exclude .git "$REPO_DIR/presets/" "$DSH_HOME/presets/"

say "skills"
"$REPO_DIR/scripts/sync-skills.sh"

say "agent-kit (instructions + portable skills)"
KIT_DIR="${AGENT_KIT_DIR:-$(dirname "$REPO_DIR")/agent-kit}"
[ -x "$KIT_DIR/install.sh" ] \
  || { printf 'agent-kit not found at %s; clone git@github.com:typosbro/agent-kit.git there or set AGENT_KIT_DIR\n' "$KIT_DIR" >&2; exit 1; }
"$KIT_DIR/install.sh" dsh

say "service assets"
if [ "$WITH_SERVICES" = "1" ]; then
  [ -d "$REPO_DIR/services/voice-bridge" ] || die "services/voice-bridge missing from the repo"
  mkdir -p "$SERVICES_DIR"
  rsync -a --delete --exclude node_modules --exclude .git "$REPO_DIR/services/voice-bridge/" "$SERVICES_DIR/voice-bridge/"
  ( cd "$SERVICES_DIR/voice-bridge" && pnpm install --reporter=append-only )
  CONFIG_DIR="$HOME/.config/dsh-superagent"
  mkdir -p "$CONFIG_DIR"
  if [ ! -f "$CONFIG_DIR/voice-bridge.json" ]; then
    cp "$SERVICES_DIR/voice-bridge/config/voice-bridge.example.json" "$CONFIG_DIR/voice-bridge.json"
    chmod 600 "$CONFIG_DIR/voice-bridge.json"
    note "wrote $CONFIG_DIR/voice-bridge.json — fill in guild/channel/operator ids"
  else
    note "kept existing $CONFIG_DIR/voice-bridge.json"
  fi
  if [ ! -f "$CONFIG_DIR/discord-token" ]; then
    install -m 600 /dev/null "$CONFIG_DIR/discord-token"
    note "created empty $CONFIG_DIR/discord-token — put the bot token in it"
  fi
  if [ -x "$REPO_DIR/scripts/install-services.sh" ]; then
    "$REPO_DIR/scripts/install-services.sh"
  else
    note "scripts/install-services.sh not present; launchd plists left alone"
  fi
else
  note "voice bridge and launchd services skipped (WITH_SERVICES=1 to install; models: see services/launchd/README.md)"
fi

if [ "$WITH_CAREER_OPS" = "1" ]; then
  say "career-ops"
  if [ -x "$REPO_DIR/scripts/install-career-ops.sh" ]; then
    "$REPO_DIR/scripts/install-career-ops.sh"
  else
    die "scripts/install-career-ops.sh missing"
  fi
else
  note "career-ops skipped (private repo; WITH_CAREER_OPS=1 runs scripts/install-career-ops.sh)"
fi

say "paths"
python3 - "$DSH_HOME" "$NODE_BIN" "$CACHE_DIR" "$DSH_HOME/plugins" "$SERVICES_DIR" <<'PY'
import pathlib, sys

home, node, cache, plugins, services = sys.argv[1:6]
tokens = {
    "@DSH_HOME@": home,
    "@NODE_BIN@": node,
    "@CACHE_DIR@": cache,
    "@PLUGIN_DIR@": plugins,
    "@SERVICES_DIR@": services,
    "@HOME@": str(pathlib.Path(home).parent),
}
roots = [pathlib.Path(home, "profiles"), pathlib.Path(home, "plugins"),
         pathlib.Path(home, "services")]
stdlib = {".yml", ".yaml", ".json", ".mjs", ".js", ".sh", ".plist", ".md", ".example"}
for root in roots:
    if not root.exists():
        continue
    for path in root.rglob("*"):
        if not path.is_file() or "node_modules" in path.parts:
            continue
        if path.suffix not in stdlib and not path.name.endswith(".example.json"):
            continue
        try:
            text = path.read_text()
        except (UnicodeDecodeError, OSError):
            continue
        text2 = text
        for key, value in tokens.items():
            text2 = text2.replace(key, value)
        if text2 != text:
            path.write_text(text2)
PY

say "commands"
BIN_DIR="${BIN_DIR:-$HOME/.local/bin}"
mkdir -p "$BIN_DIR"
for pair in "context-audit:scripts/context-audit.mjs"; do  # repo-map, wt: agent-kit/install.sh
  name="${pair%%:*}"; target="$REPO_DIR/${pair#*:}"
  chmod +x "$target"
  ln -sf "$target" "$BIN_DIR/$name"
  printf '  %s -> %s\n' "$BIN_DIR/$name" "$target"
done

say "dependencies"
if [ -f "$DSH_HOME/profiles/web/pnpm-lock.yaml" ]; then
  ( cd "$DSH_HOME/profiles/web" && pnpm install --frozen-lockfile --reporter=append-only )
else
  ( cd "$DSH_HOME/profiles/web" && pnpm install --reporter=append-only )
fi
if [ -f "$DSH_HOME/profiles/superagent/package.json" ]; then
  # The superagent plugin is vendored under profiles/superagent/plugin and linked
  # into the profile; its own dependencies live there, so install them first.
  if [ -d "$DSH_HOME/profiles/superagent/plugin" ]; then
    ( cd "$DSH_HOME/profiles/superagent/plugin" && pnpm install --reporter=append-only )
  fi
  ( cd "$DSH_HOME/profiles/superagent" && pnpm install --reporter=append-only )
fi

if [ "$WITH_PLAYWRIGHT" = "1" ]; then
  say "playwright chromium"
  ( cd "$DSH_HOME/profiles/web" && pnpm exec playwright install chromium )
fi

say "doctor"
"$REPO_DIR/doctor.sh"

say "done"
cat <<EOF
Start the GUI:        dsh web            (http://127.0.0.1:3080/)
Start superagent:     dsh --profile superagent --no-open
Voice bridge:         node $SERVICES_DIR/voice-bridge/src/main.js   (needs WITH_SERVICES=1)

Still owner-only, because they are secrets:
  1. Model access:  $DSH_HOME/.env  (DEEPSEEK_API_KEY or OPENCODE_GO_API_KEY),
                    or sign in from Settings -> Models.
  2. Discord text adapter: Settings -> Discord, paste the bot token; it is stored
                    in the Host credential service, not in this repo.
  3. Discord voice bridge: $HOME/.config/dsh-superagent/discord-token (mode 600)
                    and the ids in voice-bridge.json.
  4. career-ops:    private repo, WITH_CAREER_OPS=1 (needs GitHub SSH access).

Docs: README.md (what is backed up), docs/models.md (providers),
services/launchd/README.md (model services), profiles/superagent/README.md.
EOF
