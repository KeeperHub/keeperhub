---
title: "SendGrid Plugin"
description: "Send emails via SendGrid for workflow notifications and reports."
---

# SendGrid Plugin

Send transactional emails through SendGrid. Useful for formal notifications, reports, and alerts that need email delivery.

## Actions

| Action | Description |
|--------|-------------|
| Send Email | Send an email to one or more recipients |

## Setup

Email works without any setup. By default the Send Email action uses
KeeperHub's own SendGrid key, so there is no connection to create.

To send through your own SendGrid account instead:

1. Create a [SendGrid account](https://sendgrid.com) and verify a sender identity
2. In SendGrid, generate an API key at **Settings > API Keys**
3. On the Send Email node in KeeperHub, uncheck **Use KeeperHub SendGrid API Key**
4. Paste your API key into the **API Key** field

The key is set on the action itself. Email is not offered in
Settings > Organization > Connections, because it needs no shared credential.

## Send Email

Send an email with customizable subject and body.

**Inputs:**
- To (email address) - Required
- From (verified sender) - Optional (uses default sender if not specified)
- Subject - Required
- Body (supports `{{NodeName.field}}` variables) - Required
- CC (email address) - Optional
- BCC (email address) - Optional
- Reply-To (email address) - Optional

**Outputs:** `success`, `id` (on success), `error`

**When to use:** Daily/weekly DeFi position reports, formal security incident notifications, compliance audit trails, stakeholder updates.

**Example workflow:**
```
Schedule (daily at 9:00 UTC)
  -> Get ERC20 Token Balance (treasury USDC)
  -> Get Native Token Balance (treasury ETH)
  -> SendGrid: "Daily Treasury Report - USDC: {{TokenBalance.balance.balance}}, ETH: {{CheckBalance.balance}}"
```
