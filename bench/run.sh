#!/usr/bin/env bash
# Builds the adapter and measures bench/app.mjs with wrk on Bun and Node.js.
# Usage: bun run bench [bun|node|bun-node ...]   (DURATION=8s, CONNECTIONS=100, PORT=3000)
set -euo pipefail
cd "$(dirname "$0")/.."
command -v wrk >/dev/null || { echo "wrk is required (brew install wrk)" >&2; exit 1; }

DURATION="${DURATION:-8s}"
CONNECTIONS="${CONNECTIONS:-100}"
PORT="${PORT:-3000}"
TARGETS=("$@")
[ ${#TARGETS[@]} -eq 0 ] && TARGETS=(bun node)

bun run build >/dev/null 2>&1

for target in "${TARGETS[@]}"; do
	case "$target" in
	bun) command=(bun bench/app.mjs) runtime=auto ;;
	node) command=(node bench/app.mjs) runtime=auto ;;
	bun-node) command=(bun bench/app.mjs) runtime=node ;;
	*) echo "unknown target: $target" >&2; exit 1 ;;
	esac
	PORT="$PORT" RUNTIME="$runtime" "${command[@]}" &
	server=$!
	trap 'kill $server 2>/dev/null || true' EXIT
	for _ in $(seq 100); do curl -s -o /dev/null "localhost:$PORT/" && break; sleep 0.1; done
	wrk -t4 -c"$CONNECTIONS" -d3s "http://localhost:$PORT/users/42" >/dev/null
	for route in / /users/42 /echo; do
		script=()
		[ "$route" = /echo ] && script=(-s bench/post.lua)
		rps=$(wrk -t4 -c"$CONNECTIONS" -d"$DURATION" ${script[@]+"${script[@]}"} "http://localhost:$PORT$route" | awk '/Requests\/sec/{print $2}')
		printf '%-9s %-10s %10s req/s\n' "$target" "$route" "$rps"
	done
	kill $server 2>/dev/null || true
	wait $server 2>/dev/null || true
done
