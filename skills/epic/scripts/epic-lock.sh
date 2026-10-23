#!/usr/bin/env bash
set -euo pipefail

usage() {
	printf 'usage: %s <acquire|verify|heartbeat|release|status> <lock-dir> [token] [ttl-seconds]\n' "$0" >&2
	exit 64
}

die() {
	printf 'epic-lock: %s\n' "$*" >&2
	exit 1
}

command_name="${1:-}"
lock_dir="${2:-}"
token="${3:-}"
ttl="${4:-900}"

[ -n "$command_name" ] && [ -n "$lock_dir" ] || usage
case "$lock_dir" in
	*/opencode-epic-locks/*.lock|*/codex-epic-locks/*.lock|*/omp-epic-locks/*.lock|*/epic-locks/*.lock) ;;
	*) die "refusing unexpected lock path: $lock_dir" ;;
esac
case "$ttl" in
	''|*[!0-9]*) die "TTL must be a positive integer" ;;
esac
[ "$ttl" -gt 0 ] || die "TTL must be positive"

metadata="$lock_dir/owner"
host_name="$(hostname)"
now="$(date +%s)"

read_field() {
	local field="$1"
	[ -f "$metadata" ] || return 1
	awk -F= -v key="$field" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' "$metadata"
}

write_metadata() {
	local active_token="$1"
	local started_at="$2"
	local temp_file="$lock_dir/.owner.$active_token.tmp"
	{
		printf 'token=%s\n' "$active_token"
		printf 'host=%s\n' "$host_name"
		printf 'pid=%s\n' "$PPID"
		printf 'started_at=%s\n' "$started_at"
		printf 'heartbeat_at=%s\n' "$now"
		printf 'expires_at=%s\n' "$((now + ttl))"
	} >"$temp_file"
	mv "$temp_file" "$metadata"
}

verify_token() {
	local actual
	actual="$(read_field token || true)"
	[ -n "$token" ] || die "token is required"
	[ "$actual" = "$token" ] || die "ownership lost for $lock_dir"
}

acquire() {
	local parent generated stale_host stale_pid stale_expiry stale_started stale_path
	parent="$(dirname "$lock_dir")"
	mkdir -p "$parent"
	generated="${token:-$(uuidgen | tr '[:upper:]' '[:lower:]')}"

	if mkdir "$lock_dir" 2>/dev/null; then
		write_metadata "$generated" "$now"
		printf '%s\n' "$generated"
		return
	fi

	stale_host="$(read_field host || true)"
	stale_pid="$(read_field pid || true)"
	stale_expiry="$(read_field expires_at || true)"
	stale_started="$(stat -f %m "$lock_dir" 2>/dev/null || stat -c %Y "$lock_dir" 2>/dev/null || printf '%s' "$now")"

	if [ "$stale_host" = "$host_name" ] && [ -n "$stale_pid" ] && kill -0 "$stale_pid" 2>/dev/null; then
		die "lock is owned by live local PID $stale_pid"
	fi
	if [ "$stale_host" != "$host_name" ] && [ -n "$stale_expiry" ] && [ "$stale_expiry" -gt "$now" ]; then
		die "cross-host lock has not expired"
	fi
	if [ ! -f "$metadata" ] && [ $((now - stale_started)) -lt 30 ]; then
		die "metadata-less lock is younger than 30 seconds"
	fi

	stale_path="${lock_dir}.stale.${generated}"
	mv "$lock_dir" "$stale_path" || die "lost stale-lock takeover race"
	if ! mkdir "$lock_dir" 2>/dev/null; then
		mv "$stale_path" "$lock_dir" 2>/dev/null || true
		die "lost lock acquisition race"
	fi
	write_metadata "$generated" "$now"
	rm -rf "$stale_path"
	printf '%s\n' "$generated"
}

case "$command_name" in
	acquire)
		acquire
		;;
	verify)
		verify_token
		printf 'owned\n'
		;;
	heartbeat)
		verify_token
		started="$(read_field started_at || printf '%s' "$now")"
		write_metadata "$token" "$started"
		printf '%s\n' "$((now + ttl))"
		;;
	release)
		verify_token
		released="${lock_dir}.released.${token}"
		mv "$lock_dir" "$released" || die "failed ownership-checked release"
		rm -rf "$released"
		printf 'released\n'
		;;
	status)
		[ -f "$metadata" ] || die "lock has no metadata"
		sed -n '1,20p' "$metadata"
		;;
	*)
		usage
		;;
esac
