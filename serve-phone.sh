#!/usr/bin/env bash
# Point Tailscale Serve at the dsh Desktop app's current loopback port.
#
# WHY. The app binds 127.0.0.1 on a port it chooses at launch, and `tailscale serve`
# remembers the port it was given. If the app comes back on a different port after a
# restart, the phone URL silently proxies to nothing. Re-run this after any restart.
#
#   ./serve-phone.sh              discover the port and point Serve at it
#   ./serve-phone.sh 57985        use an explicit port
#   HTTP_PORT=9000 ./serve-phone.sh   serve on a different tailnet port
#
# Uses --http, not HTTPS: `tailscale serve` over HTTPS blocks until Serve is enabled
# for the whole tailnet in the admin console and prints an enable URL instead of
# failing, which looks like a hang. HTTP starts immediately and still rides inside
# WireGuard, so the traffic is encrypted on the wire either way.
set -euo pipefail

TS="$(command -v tailscale || echo /opt/homebrew/bin/tailscale)"
[ -x "$TS" ] || { echo "error: tailscale CLI not found" >&2; exit 1; }

HTTP_PORT="${HTTP_PORT:-8080}"
PORT="${1:-}"

if [ -z "$PORT" ]; then
  # The app's own loopback listener: the DeepSeek process bound to 127.0.0.1.
  PORT="$(lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null \
    | awk '/DeepSeek/ && /127\.0\.0\.1:/{n=split($9,a,":"); print a[n]}' \
    | sort -u | head -1)"
fi

[ -n "$PORT" ] || { echo "error: could not find the app's loopback port; pass it explicitly" >&2; exit 1; }
case "$PORT" in *[!0-9]*) echo "error: not a port number: $PORT" >&2; exit 1 ;; esac

echo "==> serving http://<this-node>:${HTTP_PORT}/ -> http://127.0.0.1:${PORT}"
"$TS" serve --bg --yes --http="$HTTP_PORT" "$PORT"
echo
"$TS" serve status
