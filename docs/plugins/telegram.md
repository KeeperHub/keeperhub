---
title: "Telegram Plugin"
description: "Send messages to Telegram chats via bot API."
---

# Telegram Plugin

Send messages to Telegram chats or groups using a bot token.

## Actions

| Action | Description |
|--------|-------------|
| Send Message | Send a text message to a Telegram chat |

## Setup

1. Message [@BotFather](https://t.me/BotFather) on Telegram to create a bot
2. Copy the bot token
3. Add the bot to your target chat/group
4. Get the chat ID (message the bot, then check `https://api.telegram.org/bot<token>/getUpdates`)
5. In KeeperHub, go to **Connections > Add Connection > Telegram**
6. Enter the bot token and save

## Send Message

Send a text message to a Telegram chat or group.

**Inputs:** Chat ID, Message (supports `{{NodeName.field}}` variables)

**Outputs:** `success`, `error`

**When to use:** Personal alerts for critical events, mobile-friendly notifications, real-time DeFi position updates.

**Example workflow:**
```
Schedule (every hour)
  -> Read Contract: Aave healthFactor()
  -> Condition: healthFactor < 1.2
  -> Telegram: "URGENT: Health factor {{ReadContract.result}} - add collateral now"
```
