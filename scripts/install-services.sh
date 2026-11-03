#!/usr/bin/env bash
# Install the launchd plists that live in services/launchd.
#
#   ./scripts/install-services.sh                 write the sidecar plists
#   ./scripts/install-services.sh --load          write them and launchctl bootstrap
#   ./scripts/install-services.sh --with-harness  also write the dsh-web plist
#
# The harness plist is never loaded by this script. A restart of the running
# Harness is an owner action: on 2026-10-26 a self-armed reload job killed web
# sessions six times in nine minutes. The file is written so a reboot can start
# it, but `launchctl bootstrap` for it is refused here.
set -euo pipefail

REPO_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
SRC_DIR="$REPO_DIR/services/launchd"
DEST_DIR="$HOME/Library/LaunchAgents"
TAILNET_HOST="${TAILNET_HOST:-localhost}"
TAILNET_IP="${TAILNET_IP:-127.0.0.1}"

LOAD=0
WITH_HARNESS=0
for arg in "$@"; do
  case "$arg" in
    --load) LOAD=1 ;;
    --with-harness) WITH_HARNESS=1 ;;
    -h|--help) sed -n '2,12p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) printf 'error: unknown argument %s\n' "$arg" >&2; exit 1 ;;
  esac
done

[ -d "$SRC_DIR" ] || { printf 'error: %s missing\n' "$SRC_DIR" >&2; exit 1; }
mkdir -p "$DEST_DIR"

install_one() {
  local name="$1"
  local src="$SRC_DIR/$name.plist"
  local dst="$DEST_DIR/$name.plist"
  [ -f "$src" ] || return 0
  sed -e "s|@HOME@|$HOME|g" \
      -e "s|@TAILNET_HOST@|$TAILNET_HOST|g" \
      -e "s|@TAILNET_IP@|$TAILNET_IP|g" \
      "$src" > "$dst"
  chmod 644 "$dst"
  printf '  wrote %s\n' "$dst"
  if [ "$LOAD" = "1" ]; then
    launchctl bootout "gui/$UID/$name" 2>/dev/null || true
    launchctl bootstrap "gui/$UID" "$dst" && printf '  loaded %s\n' "$name" || true
  fi
}

printf '==> launchd plists\n'
for name in \
  com.voicemode.whisper \
  com.voicemode.kokoro \
  com.typosbro.dsh-voice-bridge \
  com.typosbro.career-ops-scan \
  com.typosbro.career-ops-funding
do
  install_one "$name"
done

if [ "$WITH_HARNESS" = "1" ]; then
  install_one com.typosbro.dsh-web
  printf '\n  dsh-web plist written but NOT loaded (a harness restart is an owner action).\n'
  printf '  After the next reboot it starts itself. To load it by hand, as the owner:\n'
  printf '    launchctl bootstrap gui/%s "%s/com.typosbro.dsh-web.plist"\n' "$UID" "$DEST_DIR"
else
  printf '\n  harness plist skipped (--with-harness writes the file; never loaded here).\n'
fi

if [ "$LOAD" != "1" ]; then
  cat <<EOF

Load them yourself when ready:
  launchctl bootstrap gui/\$UID "$DEST_DIR/com.voicemode.whisper.plist"
  launchctl bootstrap gui/\$UID "$DEST_DIR/com.voicemode.kokoro.plist"
  launchctl bootstrap gui/\$UID "$DEST_DIR/com.typosbro.dsh-voice-bridge.plist"
EOF
fi
