#!/bin/sh
# Kong entrypoint for the OpenMAIC SaaS stack.
# volumes/api/kong.yml is a template with $VAR placeholders (anon/service keys,
# dashboard credentials). Render it with the container env into the declarative
# config path Kong reads, then hand off to the stock Kong entrypoint.
set -e

TEMPLATE=/home/kong/temp.yml
RENDERED="${KONG_DECLARATIVE_CONFIG:-/usr/local/kong/kong.yml}"

# eval-echo expands $VARS from the environment (same trick as supabase/docker;
# JWTs contain no shell-special chars beyond alnum/.-_ so this is safe here).
eval "echo \"$(cat "$TEMPLATE")\"" > "$RENDERED"

exec /docker-entrypoint.sh kong docker-start
