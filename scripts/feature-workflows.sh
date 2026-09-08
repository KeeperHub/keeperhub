#!/bin/bash

# Get INTERNAL_SERVICE_HMAC_SECRET from SSM:
# Prod:    aws ssm get-parameter --name "/eks/techops-prod/keeperhub/internal-service-hmac-secret" --with-decryption --query "Parameter.Value" --output text
# Staging: aws ssm get-parameter --name "/eks/techops-staging/keeperhub/internal-service-hmac-secret" --with-decryption --query "Parameter.Value" --output text

if [[ -z "$INTERNAL_SERVICE_HMAC_SECRET" ]]; then
  echo "Error: INTERNAL_SERVICE_HMAC_SECRET env var not found"
  exit 1
fi

BASE_URL="https://app.keeperhub.com/api/hub/featured"
CALLER="hub"
METHOD="POST"
PATHNAME="/api/hub/featured"

feature_workflow() {
  local body="$1"
  local label="$2"
  local TIMESTAMP
  TIMESTAMP=$(date +%s)
  local BODY_DIGEST
  BODY_DIGEST=$(printf '%s' "$body" | openssl dgst -sha256 | awk '{print $2}')
  local SIGNING_STRING
  SIGNING_STRING=$(printf '%s\n%s\n%s\n%s\n%s' "$METHOD" "$PATHNAME" "$CALLER" "$BODY_DIGEST" "$TIMESTAMP")
  local SIGNATURE
  SIGNATURE=$(printf '%s' "$SIGNING_STRING" | openssl dgst -sha256 -hmac "$INTERNAL_SERVICE_HMAC_SECRET" | awk '{print $2}')

  curl -sf -X POST "$BASE_URL" \
    -H "Content-Type: application/json" \
    -H "X-KH-Caller: ${CALLER}" \
    -H "X-KH-Timestamp: ${TIMESTAMP}" \
    -H "X-KH-Signature: ${SIGNATURE}" \
    -d "$body" || echo "Failed to feature workflow ${label}"
  echo ""
}

feature_workflow '{"workflowId": "5tqrbugkrfzt4tm5yfs29", "featured": true, "category": "Getting Started", "featuredOrder": 1}' "5tqrbugkrfzt4tm5yfs29"
feature_workflow '{"workflowId": "2cpr56tiriijndr4hmiua", "featured": true, "category": "Getting Started", "featuredOrder": 2}' "2cpr56tiriijndr4hmiua"
feature_workflow '{"workflowId": "nhggiz2hn76gbqhiw9d2z", "featured": true, "category": "Getting Started", "featuredOrder": 3}' "nhggiz2hn76gbqhiw9d2z"
feature_workflow '{"workflowId": "qf8nxbxhdsqie2r3u1pb2", "featured": true, "category": "Getting Started", "featuredOrder": 4}' "qf8nxbxhdsqie2r3u1pb2"
