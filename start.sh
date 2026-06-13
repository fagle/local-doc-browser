#!/usr/bin/env sh
cd "$(dirname "$0")" || exit 1
exec node --watch dev-server.mjs 5173 "$@"
