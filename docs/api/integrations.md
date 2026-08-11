---
title: "Integrations API"
description: "KeeperHub Integrations API - manage notification providers and service connections."
---

# Integrations API

Manage integrations for notifications and external services.

## Supported Integration Types

| Type | Description |
|------|-------------|
| `discord` | Discord webhook notifications |
| `slack` | Slack workspace integration |
| `telegram` | Telegram bot messaging |
| `sendgrid` | Email via SendGrid |
| `resend` | Email via Resend |
| `safe` | Safe multisig API integration |
| `webhook` | Custom HTTP webhooks |
| `web3` | Web3 wallet connections |
| `ai-gateway` | AI service integrations |

## List Integrations

```http
GET /api/integrations
```

### Query Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `type` | string | Filter by integration type |

### Response

```json
{
  "data": [
    {
      "id": "int_123",
      "name": "My Discord",
      "type": "discord",
      "isManaged": false,
      "createdAt": "2024-01-01T00:00:00Z",
      "updatedAt": "2024-01-01T00:00:00Z"
    }
  ]
}
```

Note: Integration config is excluded from list responses for security.

## Get Integration

```http
GET /api/integrations/{integrationId}
```

Returns full integration details including configuration.

## Create Integration

```http
POST /api/integrations
```

### Request Body

```json
{
  "name": "My Slack Integration",
  "type": "slack",
  "config": {
    "webhookUrl": "https://hooks.slack.com/..."
  }
}
```

## Update Integration

```http
PUT /api/integrations/{integrationId}
```

### Request Body

```json
{
  "name": "Updated Name",
  "config": {
    "webhookUrl": "https://new-webhook-url..."
  }
}
```

## Delete Integration

```http
DELETE /api/integrations/{integrationId}
```

## Test Integration

```http
POST /api/integrations/{integrationId}/test
```

Tests the integration credentials and connectivity.

### Request Body (Optional)

```json
{
  "configOverrides": {
    "webhookUrl": "https://test-webhook-url..."
  }
}
```

The `configOverrides` field allows testing with temporary configuration values without modifying the saved integration.

### Response

```json
{
  "status": "success",
  "message": "Integration test successful"
}
```
