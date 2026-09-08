---
title: "Slack Plugin"
description: "Send messages to Slack channels via a bot token."
---

# Slack Plugin

Send messages to Slack channels using a bot token and the Slack `chat.postMessage` API.

## Actions

| Action | Description |
|--------|-------------|
| Send Slack Message | Send a message to a Slack channel |

## Setup

1. Create a Slack app at [api.slack.com/apps](https://api.slack.com/apps) (or use an existing one)
2. Under **OAuth & Permissions**, add the `chat:write` bot token scope
3. Install the app to your workspace and copy the **Bot User OAuth Token** (starts with `xoxb-`)
4. Invite the bot to the target channel (`/invite @your-bot-name` in Slack)
5. In KeeperHub, go to **Settings > Organization > Connections** and add a Slack connection
6. Paste the Bot Token and save

## Send Slack Message

Post a message to a Slack channel.

**Inputs:** Channel (name like `#general` or a channel ID), Message (supports `{{NodeName.field}}` variables)

**Outputs:** `success`, `ts` (message timestamp), `channel` (channel ID), `error`

**When to use:** Alert your team about on-chain events, notify on balance changes, report workflow results, send security alerts.

**Example workflow:**
```
Schedule (every 5 min)
  -> Get Native Token Balance (treasury)
  -> Condition: balance < 10 ETH
  -> Slack: "Treasury balance low: {{CheckBalance.balance}} ETH"
```
