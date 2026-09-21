---
title: "Notification Connections"
description: "Configure Email, Discord, Slack, Telegram, PagerDuty, and Webhook connections for KeeperHub notifications."
---

# Notification Connections

KeeperHub supports multiple notification channels. Configure connections to enable notification nodes in your workflows.

## Accessing Connections

1. Open Settings from the user menu
2. Under Organization, select **Connections**
3. View existing connections or add new ones

A connection created inside an organization is shared with that organization;
a personal one, created without an organization, stays private to its creator.
Either way it is never visible to another organization.

Connections stay owned by their creator. Deactivating that person's account
freezes the connections they added, for the whole organization; recreate them
under an active member to restore service. Removing someone from the
organization without deactivating their account leaves the connections
working, so rotate or delete the credential as part of offboarding.

## Available Connection Types

### Email

Send notifications directly to email addresses.

**Setup:**
1. Click **Add Connection** and select Email
2. Configure your email provider settings
3. Save the connection

**Features:**
- Direct delivery to specified addresses
- Customizable subject and message content
- Support for dynamic variables from workflow

### Discord

Send messages to Discord channels via webhooks.

**Setup:**
1. In Discord, go to Server Settings > Integrations > Webhooks
2. Create a new webhook and copy the URL
3. In KeeperHub, add a Discord connection with the webhook URL

**Features:**
- Channel-specific message posting
- Rich message formatting
- Real-time delivery

### Slack

Connect to Slack for team notifications using a bot token.

**Setup:**
1. Create a Slack app with a bot token (starts with `xoxb-`) that has the `chat:write` scope
2. Click **Add Connection**, select Slack, and paste the bot token
3. Select default channel (can be changed per node)

**Features:**
- Channel targeting
- Thread support for organized conversations
- Mention capabilities for urgent alerts

### Telegram

Send messages to Telegram chats and channels via bot API.

**Setup:**
1. Create a Telegram bot using [BotFather](https://core.telegram.org/bots/tutorial)
2. Copy the bot token provided by BotFather
3. In KeeperHub, click **Add Connection** and select Telegram
4. Paste your bot token and save

**Features:**
- Send messages to any chat, group, or channel
- Support for plain text and MarkdownV2 formatting
- Dynamic variables from workflow data

**Configuration Fields:**

| Field | Description |
|-------|-------------|
| Chat ID | Numeric chat ID or `@channelusername` |
| Message | Message content (supports dynamic variables) |
| Parse Mode | Plain text or MarkdownV2 |

**MarkdownV2 Note:** When using MarkdownV2 parse mode, special characters (`.`, `-`, `_`, `*`, `[`, `]`, `(`, `)`, `~`, `` ` ``, `>`, `#`, `+`, `=`, `|`, `{`, `}`, `!`) must be escaped with a backslash (`\`).

### PagerDuty

Page on-call by opening an incident on a PagerDuty service, and resolve it again from the same workflow.

**Setup:**
1. In PagerDuty, go to **Integrations > Developer Tools > API Access Keys > Create New API Key** and tick **Read-only API Key**
2. Copy the key; PagerDuty shows it once
3. In KeeperHub, click **Add Connection** and select PagerDuty
4. Paste the key, tick **EU service region** if your PagerDuty address contains `.eu`, and test the connection

A scoped OAuth app works instead of a token: grant `services.read` and `escalation_policies.read`, then fill in the client id, secret and account subdomain. Read-only access is enough for everything except the REST Create Incident action, because the event itself is authorised by the service's own routing key rather than by the account credential.

**Features:**
- Services and escalation policies are read from your account, so nothing is typed by hand
- The routing key is resolved per run and never stored in the workflow
- Deduplication keys are handled for you, so a repeating check updates one alert instead of paging every run
- A workflow can resolve the incident it opened
- An optional backup connection is notified if PagerDuty cannot be reached

**Configuration Fields:**

| Field | Description |
|-------|-------------|
| REST API token | Read-only General Access key. Leave blank when using scoped OAuth |
| OAuth client ID, secret, subdomain | Scoped OAuth app, PagerDuty's recommended alternative to an account-wide key |
| EU service region | Switches both hosts to the EU region. A mismatch shows up as a 401, and the connection test says which way to set it |
| From email | Only needed by the REST Create Incident action, which PagerDuty attributes to a real user |

See the [PagerDuty plugin](/plugins/pagerduty) for the actions and their fields.

### Webhook

Send HTTP requests to any external service.

**Setup:**
1. Click **Add Connection** and select Webhook
2. Configure:
   - **URL**: Must begin with https://
   - **Method**: GET, POST, PUT, etc.
   - **Headers**: Authentication and content-type headers

**Features:**
- Integration with any HTTP-compatible service
- Custom JSON payloads
- Dynamic variables in request body

## Using Connections in Workflows

After setting up connections, use them in notification nodes:

1. Add a notification node to your workflow (Send Email, Send Discord Message, etc.)
2. Click the node to open configuration
3. Select your connection from the **Connection** dropdown
4. Configure the message content

### Connection Status

The configuration panel shows connection status:
- **Green checkmark**: Connection is valid and ready
- **Red indicator**: Connection needs attention (expired, invalid credentials, etc.)

## Dynamic Variables in Messages

Include workflow data in your notifications using template references to earlier nodes:

```
{{@nodeId:Label.field}}
```

Each node's outputs become available to downstream nodes. For example, a Check Balance node labeled "Check Balance" exposes `{{@checkBalance:Check Balance.balance}}` and `{{@checkBalance:Check Balance.address}}`. See [Templating](/workflows/templating) for the full syntax and available fields.

**Example Discord Message:**
```
Balance Alert: Wallet {{@checkBalance:Check Balance.address}} now has {{@checkBalance:Check Balance.balance}} ETH
```

## Best Practices

### Redundancy
Configure multiple notification channels for critical workflows. If one channel fails, others will still deliver. A PagerDuty node can name one of them as its backup connection, so a page that cannot be delivered still reaches someone.

### Testing
Test your connections after setup using a simple workflow with a manual trigger.

### Security
- Use HTTPS for all webhook URLs
- Avoid including sensitive data (private keys, passwords) in notification messages
- Regularly review and rotate webhook URLs if compromised

### Channel Organization
- Use dedicated Discord/Slack channels for KeeperHub alerts
- Consider separate channels for different workflow types (alerts, transactions, monitoring)
