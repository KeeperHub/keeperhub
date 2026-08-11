#!/bin/sh
set -e

# Cron runner for the execution digest: GET the /api/internal/execution-digest
# endpoint authenticated with HMAC. Pass the full URL as the first argument.

URL="$1"

if [ -z "$URL" ]; then
  echo '{"error":"missing URL argument"}' >&2
  exit 1
fi

if [ -z "$INTERNAL_SERVICE_HMAC_SECRET" ]; then
  echo '{"error":"INTERNAL_SERVICE_HMAC_SECRET not set"}' >&2
  exit 1
fi

CALLER="scheduler"
METHOD="GET"
TIMESTAMP=$(date +%s)
BODY_DIGEST=$(printf '' | openssl dgst -sha256 | awk '{print $2}')
PATHNAME=$(printf '%s' "$URL" | sed 's|https\?://[^/]*||')
SIGNING_STRING=$(printf '%s\n%s\n%s\n%s\n%s' "$METHOD" "$PATHNAME" "$CALLER" "$BODY_DIGEST" "$TIMESTAMP")
SIGNATURE=$(printf '%s' "$SIGNING_STRING" | openssl dgst -sha256 -hmac "$INTERNAL_SERVICE_HMAC_SECRET" | awk '{print $2}')

echo "Environment variables are ready"

curl -sS \
  -w '\n{"http_code":%{http_code},"time_total":%{time_total}}' \
  -H "X-KH-Caller: ${CALLER}" \
  -H "X-KH-Timestamp: ${TIMESTAMP}" \
  -H "X-KH-Signature: ${SIGNATURE}" \
  "$URL"
