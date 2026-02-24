---
title: "API Overview"
description: "KeeperHub REST API reference - authentication, endpoints, rate limits, and SDKs."
---

# API Overview

The KeeperHub API allows you to programmatically manage workflows, integrations, and executions.

## Base URL

```
https://app.keeperhub.com/api
```

## Authentication

All API requests require authentication via either:
- **Session**: Browser-based authentication via Better Auth
- **API Key**: For programmatic access (see [API Keys](/api/api-keys))

## Response Format

All responses are returned as JSON with the following structure:

### Success Response
```json
{
  "data": { ... }
}
```

### Error Response
```json
{
  "error": {
    "code": "ERROR_CODE",
    "message": "Human readable message"
  }
}
```

## Rate Limits

API requests are subject to rate limiting. Current limits:
- 100 requests per minute for authenticated users
- 10 requests per minute for unauthenticated requests

## Available Endpoints

| Resource | Description |
|----------|-------------|
| [Workflows](/api/workflows) | Create, read, update, delete workflows |
| [Executions](/api/executions) | Monitor workflow execution status and logs |
| [Direct Execution](/api/direct-execution) | Execute blockchain transactions without workflows |
| [Analytics](/api/analytics) | Workflow performance metrics and gas usage tracking |
| [Integrations](/api/integrations) | Manage notification and service integrations |
| [Projects](/api/projects) | Organize workflows into projects |
| [Tags](/api/tags) | Label and categorize workflows |
| [Chains](/api/chains) | List supported blockchain networks |
| [User](/api/user) | User profile, preferences, and address book |
| [Organizations](/api/organizations) | Organization membership management |
| [API Keys](/api/api-keys) | Manage API keys for programmatic access |

## SDKs

Official SDKs are planned for future release. In the meantime, you can interact with the API directly using any HTTP client or library such as `fetch`, `axios`, or `requests`.
