#!/bin/sh
set -eu

PI_WEB_SOURCE_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
PI_WEB_HOSTNAME="${PI_WEB_HOSTNAME:-127.0.0.1}"
PI_WEB_PORT="${PI_WEB_PORT:-30141}"

# The global npm package is an optional upstream fallback. Production Ultron
# instances always run the checked-out source and its committed .next build.
if [ "${PI_WEB_USE_GLOBAL:-0}" = "1" ]; then
	GLOBAL_PI_WEB="${PI_WEB_GLOBAL_BIN:-/Users/Admin/.local/bin/pi-web}"
	exec "$GLOBAL_PI_WEB" -H "$PI_WEB_HOSTNAME" --no-open
fi

cd "$PI_WEB_SOURCE_ROOT"
exec node node_modules/next/dist/bin/next start -H "$PI_WEB_HOSTNAME" -p "$PI_WEB_PORT"

