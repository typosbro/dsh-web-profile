#!/usr/bin/env bash
# Install this profile into a DSH home. Idempotent for a clean home; replaces an
# existing `web` profile only when FORCE=1 (a timestamped backup is kept either way).
#
#   ./bootstrap.sh                 install into $HOME/.dsh
#   DSH_HOME=/opt/dsh ./bootstrap.sh
#   FORCE=1 ./bootstrap.sh         replace an existing web profile
#   WITH_PLAYWRIGHT=1 ./bootstrap.sh   also download the Chromium Playwright build
set -euo pipefail

REPO_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE_NAME="${PROFILE_NAME:-web}"
DSH_VERSION="${DSH_VERSION:-0.2.1-rc.2}"
CACHE_DIR="${XDG_CACHE_HOME:-$HOME/.cache}"
FORCE="${FORCE:-0}"
WITH_PLAYWRIGHT="${WITH_PLAYWRIGHT:-0}"

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

say "preflight"
command -v node >/dev/null || die "node is not installed (need >= 22)"
command -v pnpm >/dev/null || die "pnpm is not installed (corepack enable)"
command -v rsync >/dev/null || die "rsync is not installed"
command -v python3 >/dev/null || die "python3 is not installed"
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' \
  || die "node $(node -v) is too old; DSH needs >= 22"
NODE_BIN="$(command -v node)"
say "node $NODE_BIN, pnpm $(pnpm -v), DSH_HOME $DSH_HOME"

say "harness"
if ! command -v dsh >/dev/null 2>&1 || [ "$(dsh --version 2>/dev/null || true)" != "$DSH_VERSION" ]; then
  npm install --global "@deepseek-ai/dsh@$DSH_VERSION"
else
  printf 'dsh %s already installed\n' "$DSH_VERSION"
fi

say "profile"
PROFILE_DIR="$DSH_HOME/profiles/$PROFILE_NAME"
if [ -e "$PROFILE_DIR" ]; then
  [ "$FORCE" = "1" ] || die "$PROFILE_DIR exists; re-run with FORCE=1 (a backup is kept)"
  BACKUP="$PROFILE_DIR.bak.$(date +%Y%m%d-%H%M%S)"
  mv "$PROFILE_DIR" "$BACKUP"
  printf 'backed up existing profile to %s\n' "$BACKUP"
fi
mkdir -p "$DSH_HOME/profiles" "$DSH_HOME/plugins" "$DSH_HOME/presets" \
         "$CACHE_DIR/dsh-browser-profile" "$CACHE_DIR/dsh-browser-out"
rsync -a --delete "$REPO_DIR/profiles/web/" "$PROFILE_DIR/"
rsync -a --delete --exclude node_modules --exclude .git "$REPO_DIR/plugins/" "$DSH_HOME/plugins/"
rsync -a --delete --exclude node_modules --exclude .git "$REPO_DIR/presets/" "$DSH_HOME/presets/"

say "skills"
"$REPO_DIR/scripts/sync-skills.sh"

say "instructions"
"$REPO_DIR/scripts/sync-instructions.sh"

say "claude code"
"$REPO_DIR/scripts/sync-claude.sh"

say "paths"
python3 - "$DSH_HOME" "$NODE_BIN" "$CACHE_DIR" "$DSH_HOME/plugins" <<'PY'
import pathlib, sys

home, node, cache, plugins = sys.argv[1:5]
tokens = {
    "@DSH_HOME@": home,
    "@NODE_BIN@": node,
    "@CACHE_DIR@": cache,
    "@PLUGIN_DIR@": plugins,
}
roots = [pathlib.Path(home, "profiles", "web"), pathlib.Path(home, "plugins")]
stdlib = {".yml", ".yaml", ".json", ".mjs", ".js", ".sh"}
for root in roots:
    for path in root.rglob("*"):
        if not path.is_file() or path.suffix not in stdlib or "node_modules" in path.parts:
            continue
        text = path.read_text()
        text2 = text
        for key, value in tokens.items():
            text2 = text2.replace(key, value)
        if text2 != text:
            path.write_text(text2)
PY

say "commands"
BIN_DIR="${BIN_DIR:-$HOME/.local/bin}"
mkdir -p "$BIN_DIR"
for pair in "repo-map:scripts/repo-map.mjs" "context-audit:scripts/context-audit.mjs" "wt:scripts/wt.sh"; do
  name="${pair%%:*}"; target="$REPO_DIR/${pair#*:}"
  chmod +x "$target"
  ln -sf "$target" "$BIN_DIR/$name"
  printf '  %s -> %s\n' "$BIN_DIR/$name" "$target"
done

say "dependencies"
( cd "$PROFILE_DIR" && pnpm install --frozen-lockfile --reporter=append-only )

if [ "$WITH_PLAYWRIGHT" = "1" ]; then
  say "playwright chromium"
  ( cd "$PROFILE_DIR" && pnpm exec playwright install chromium )
fi

say "doctor"
"$REPO_DIR/doctor.sh"

say "done"
cat <<EOF
Start the GUI:   dsh web
Then open:       http://127.0.0.1:3080/

Model access is not installed by this script. Set DEEPSEEK_API_KEY in
$DSH_HOME/.env (native DeepSeek route), or add an OpenAI-compatible provider with
examples/providers.cordis.patch.yml. See docs/models.md.
EOF
