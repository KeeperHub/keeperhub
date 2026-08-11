# Featuring Workflows on the Hub

## Overview

Featured workflows appear in the "Getting Started" section of the hub. The process has two steps: make the workflow public, then mark it as featured.

## Prerequisites

- Access to the KeeperHub app (to go live with workflows)
- AWS CLI access to retrieve the service API key from SSM

## Step 1: Make Workflows Public

Each workflow must be public before it can appear on the hub. The workflow owner does this from the app:

1. Open the workflow in KeeperHub
2. In the toolbar, click the visibility icon (globe or lock icon, top-right area)
3. Select "Public" from the dropdown -- this opens the "Go Live" overlay
4. Enter a descriptive workflow name and select relevant tags
5. Click "Go Live" to confirm

This sets `visibility: "public"`. Without this, the workflow will not show on the hub regardless of featured status. To edit the name or tags later, use "Public Settings" in the same dropdown.

## Step 2: Get the API Key

Retrieve the hub service API key from AWS SSM:

```bash
# Production
aws ssm get-parameter \
  --name "/eks/techops-prod/keeperhub-hub/keeperhub-api-key" \
  --with-decryption --query "Parameter.Value" --output text

# Staging
aws ssm get-parameter \
  --name "/eks/techops-staging/keeperhub-hub/keeperhub-api-key" \
  --with-decryption --query "Parameter.Value" --output text
```

Export it:

```bash
export HUB_SERVICE_API_KEY="<key>"
```

## Step 3: Update the Script

Edit `feature-workflows.sh` in this directory. Replace the workflow IDs with the ones you want to feature. You can find a workflow's ID in its URL: `app.keeperhub.com/workflows/<workflowId>`.

Each curl line sets:
- `workflowId` -- the workflow to feature
- `featured: true` -- marks it as featured
- `category` -- display category (e.g. "Getting Started")
- `featuredOrder` -- sort order (1 = first)

To unfeature a workflow, set `"featured": false` in the JSON payload.

## Step 4: Run the Script

```bash
bash keeperhub/scripts/feature-workflows.sh
```

The script targets production (`app.keeperhub.com`) by default. For staging, edit `BASE_URL` in the script to point to the staging domain.

## Featuring Protocol-Specific Workflows

The API also supports protocol-level featuring (e.g. featured workflows on a protocol's hub page). Use these fields instead:

```json
{
  "workflowId": "<id>",
  "featuredProtocol": "aave-v3",
  "featuredProtocolOrder": 1
}
```

## Quick Reference: Single Workflow

To feature a single workflow without editing the script:

```bash
# The endpoint authenticates with an HMAC signature (X-KH-* headers), so sign
# the request the same way feature-workflows.sh does.
URL="https://app.keeperhub.com/api/hub/featured"
BODY='{"workflowId": "<id>", "featured": true, "category": "Getting Started", "featuredOrder": 1}'
TS=$(date +%s)
BODY_DIGEST=$(printf '%s' "$BODY" | openssl dgst -sha256 | awk '{print $2}')
SIG=$(printf '%s\n%s\n%s\n%s\n%s' POST /api/hub/featured hub "$BODY_DIGEST" "$TS" \
  | openssl dgst -sha256 -hmac "$INTERNAL_SERVICE_HMAC_SECRET" | awk '{print $2}')
curl -X POST "$URL" \
  -H "Content-Type: application/json" \
  -H "X-KH-Caller: hub" -H "X-KH-Timestamp: $TS" -H "X-KH-Signature: $SIG" \
  -d "$BODY"
```
