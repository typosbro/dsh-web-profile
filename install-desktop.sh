#!/usr/bin/env bash
# Install the portable web rows into the dsh Desktop app's `desktop` profile.
#
# The Desktop app owns ~/.dsh/profiles/desktop and the CLI refuses that profile by
# name, so this script does not use `dsh`: it copies the same plugin directories the
# `web` profile uses and merges the same rows into the app's patch layer inside a
# marked block. Re-running replaces the block; --uninstall removes it cleanly.
#
#   ./install-desktop.sh                     install or refresh
#   ./install-desktop.sh --remote-host HOST  also allow token-free access from HOST
#                                            (e.g. a tailnet name), so a phone can
#                                            keep a durable URL instead of a
#                                            per-process ?token= link
#   ./install-desktop.sh --uninstall         remove the block and directories
#
# Works on macOS only, because that is where the Desktop app runs. On Linux use
# ./bootstrap.sh plus `dsh web --trusted-host HOST`.
set -euo pipefail

REPO_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE_DIR="$DSH_HOME/profiles/desktop"
APP="${APP:-/Applications/DeepSeek Harness.app}"
MARK_BEGIN="# >>> dsh-web-profile >>>"
MARK_END="# <<< dsh-web-profile <<<"
PLUGIN_DIRS=(mobile-shell web-pwa gate remote-auth session-message)

MODE="install"
REMOTE_HOST=""
while [ $# -gt 0 ]; do
  case "$1" in
    --uninstall) MODE="uninstall" ;;
    --remote-host) REMOTE_HOST="${2:-}"; shift ;;
    --remote-host=*) REMOTE_HOST="${1#*=}" ;;
    -h|--help) sed -n '2,17p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) printf 'error: unknown argument: %s\n' "$1" >&2; exit 1 ;;
  esac
  shift
done

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || die "this installer targets macOS; use ./bootstrap.sh on Linux"
[ -d "$APP" ] || die "dsh Desktop app not found at $APP (override with APP=...)"
[ -d "$PROFILE_DIR" ] || die "no desktop profile at $PROFILE_DIR — open the Desktop app once, then re-run"
command -v python3 >/dev/null || die "python3 is required for the patch merge"

if [ "$MODE" = "uninstall" ]; then
  say "uninstall"
  python3 - "$PROFILE_DIR/cordis.patch.yml" "$MARK_BEGIN" "$MARK_END" <<'PY'
import sys, pathlib, re
path, begin, end = sys.argv[1:4]
p = pathlib.Path(path)
if not p.exists():
    print("  no patch layer; nothing to remove")
    raise SystemExit(0)
text = p.read_text()
pattern = re.compile(r"\n?" + re.escape(begin) + r".*?" + re.escape(end) + r"\n", re.S)
if not pattern.search(text):
    print("  no managed block; nothing to remove")
    raise SystemExit(0)
p.write_text(pattern.sub("\n", text, count=1).rstrip("\n") + "\n")
print("  removed the managed block from", path)
PY
  for d in "${PLUGIN_DIRS[@]}"; do
    rm -rf "$PROFILE_DIR/$d"
    printf '  removed %s\n' "$PROFILE_DIR/$d"
  done
  say "done"
  printf 'Quit and reopen the Desktop app for the removal to take effect.\n'
  exit 0
fi

say "copy plugin directories"
for d in "${PLUGIN_DIRS[@]}"; do
  [ -d "$REPO_DIR/profiles/web/$d" ] || die "missing $REPO_DIR/profiles/web/$d"
  rm -rf "$PROFILE_DIR/$d"
  cp -R "$REPO_DIR/profiles/web/$d" "$PROFILE_DIR/$d"
  printf '  %s\n' "$PROFILE_DIR/$d"
done

say "merge rows into the app-managed patch layer"
BACKUP="$PROFILE_DIR/cordis.patch.yml.bak.$(date +%Y%m%d-%H%M%S)"
cp "$PROFILE_DIR/cordis.patch.yml" "$BACKUP"
printf '  backup: %s\n' "$BACKUP"

python3 - "$PROFILE_DIR/cordis.patch.yml" "$MARK_BEGIN" "$MARK_END" "$REMOTE_HOST" <<'PY'
import sys, pathlib, re
path, begin, end, remote_host = sys.argv[1:5]
p = pathlib.Path(path)
text = p.read_text()

# Drop any previous managed block so re-running is idempotent.
pattern = re.compile(r"\n?" + re.escape(begin) + r".*?" + re.escape(end) + r"\n", re.S)
text = pattern.sub("\n", text).rstrip("\n")

# The patch layer is a top-level YAML sequence. An empty flow sequence (`[]`)
# cannot receive block entries, so replace it.
if text.strip() in ("", "[]"):
    text = ""

block = begin + """
# Managed by dsh-web-profile/install-desktop.sh — edits inside this block are
# replaced on the next run. Remove it with `./install-desktop.sh --uninstall`.
- insert:
    - id: mobile-shell
      name: ./mobile-shell/index.mjs
- insert:
    - id: web-pwa
      name: ./web-pwa/host.mjs
- insert:
    - id: stop-gate
      name: ./gate/index.mjs
- insert:
    - id: session-message
      name: ./session-message/index.mjs
"""
rows = 4
if remote_host:
    block += """- insert:
    - id: remote-auth
      name: ./remote-auth/index.mjs
- id: connection
  name: '@deepseek-ai/dsh-client-connection'
  config:
    trustedHosts: !!js "[...(ctx.webStartup?.trustedHosts ?? []), '%s']"
""" % remote_host
    rows += 2
block += end + "\n"
p.write_text((text + ("\n" if text else "") + block))
print("  merged %d rows%s" % (rows, (" (incl. --remote-host %s)" % remote_host) if remote_host else ""))
PY

say "done"
cat <<EOF
The rows are in place. Now quit and reopen the Desktop app.

Verify after reopening: the GUI should be phone-friendly below ~980px wide, serve
/dsh-pwa/manifest.webmanifest, and run a repository gate before ending a turn in a
repo that exposes scripts/agent-gate.sh or a package.json "gate" script.
EOF
if [ -n "$REMOTE_HOST" ]; then
  cat <<EOF

Remote access enabled for: $REMOTE_HOST
Expose the loopback port to your tailnet:

  tailscale serve --bg 57985
  tailscale serve status

Then open https://$REMOTE_HOST/ from the phone. Anything on the tailnet that can
reach that name can also reach this GUI, which can run commands — restrict it with
Tailscale ACLs if the tailnet has other users.
EOF
fi
printf '\nRemove everything with: ./install-desktop.sh --uninstall\n'
