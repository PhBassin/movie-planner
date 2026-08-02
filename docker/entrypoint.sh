#!/bin/sh
set -eu

role="${ROLE:-${1:-web}}"

case "$role" in
  web)
    exec node server/dist/index.js
    ;;
  worker)
    export RUN_MODE="${RUN_MODE:-consumer}"
    exec node scraper/dist/index.js
    ;;
  *)
    printf 'Unknown application role: %s (expected web or worker)\n' "$role" >&2
    exit 64
    ;;
esac
