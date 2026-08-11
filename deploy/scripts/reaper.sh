#!/bin/sh
set -e

URL="$1"
# Optional, so the GET callers keep passing a URL and nothing else.
METHOD="${2:-GET}"
BODY="${3:-}"

if [ -z "$URL" ]; then
  echo '{"error":"missing URL argument"}' >&2
  exit 1
fi

if [ -z "$INTERNAL_SERVICE_HMAC_SECRET" ]; then
  echo '{"error":"INTERNAL_SERVICE_HMAC_SECRET not set"}' >&2
  exit 1
fi

CALLER="scheduler"
TIMESTAMP=$(date +%s)
BODY_DIGEST=$(printf '%s' "$BODY" | openssl dgst -sha256 | awk '{print $2}')
PATHNAME=$(printf '%s' "$URL" | sed 's|https\?://[^/]*||')
SIGNING_STRING=$(printf '%s\n%s\n%s\n%s\n%s' "$METHOD" "$PATHNAME" "$CALLER" "$BODY_DIGEST" "$TIMESTAMP")
SIGNATURE=$(printf '%s' "$SIGNING_STRING" | openssl dgst -sha256 -hmac "$INTERNAL_SERVICE_HMAC_SECRET" | awk '{print $2}')

echo "Environment variables are ready"

# Capture the response (body + the -w trailer carrying the HTTP status) so we
# can both surface it for logs AND react to the status. curl -sS has no -f, so
# a 4xx/5xx is delivered with exit 0; without the check below a persistent auth
# (401, e.g. an HMAC-secret mismatch that rejects before the handler runs) or
# server (500) failure would leave the CronJob green while the job's work is
# silently undone. Fail the job on any non-2xx (and on an unparseable status)
# so Kubernetes records a failed job and the cluster's CronJob-failure alerting
# can page. Applies to every cron that runs this script, not just the scan.
if [ -n "$BODY" ]; then
  RESPONSE=$(curl -sS \
    -w '\n{"http_code":%{http_code},"time_total":%{time_total}}' \
    -X "$METHOD" \
    -H "X-KH-Caller: ${CALLER}" \
    -H "X-KH-Timestamp: ${TIMESTAMP}" \
    -H "X-KH-Signature: ${SIGNATURE}" \
    -H "Content-Type: application/json" \
    --data-raw "$BODY" \
    "$URL")
else
  RESPONSE=$(curl -sS \
    -w '\n{"http_code":%{http_code},"time_total":%{time_total}}' \
    -X "$METHOD" \
    -H "X-KH-Caller: ${CALLER}" \
    -H "X-KH-Timestamp: ${TIMESTAMP}" \
    -H "X-KH-Signature: ${SIGNATURE}" \
    "$URL")
fi

printf '%s\n' "$RESPONSE"

HTTP_CODE=$(printf '%s\n' "$RESPONSE" | tail -n1 | sed -n 's/.*"http_code":\([0-9]\{1,\}\).*/\1/p')

case "$HTTP_CODE" in
  2[0-9][0-9]) ;;
  *)
    echo "{\"error\":\"non-2xx response\",\"http_code\":\"${HTTP_CODE}\",\"url\":\"${URL}\"}" >&2
    exit 1
    ;;
esac
