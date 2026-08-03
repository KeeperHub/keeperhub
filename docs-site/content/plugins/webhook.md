---
title: "Webhook Plugin"
description: "Send HTTP requests to external services and APIs."
---

# Webhook Plugin

Send HTTP requests to any external URL. No credentials required -- authentication is handled per-request via headers.

## Actions

| Action | Description |
|--------|-------------|
| Send Webhook | Send an HTTP POST request with a JSON payload |

## Send Webhook

Send an HTTP request to an external service.

**Inputs:** URL, Payload (JSON, supports `{{NodeName.field}}` variables)

**Outputs:** `success`, `error`

**When to use:** Trigger external systems (CI/CD, Slack incoming webhooks, PagerDuty), push data to analytics platforms, integrate with custom APIs, chain with other automation tools.

**Example workflow:**
```
Schedule (every 15 min)
  -> Read Contract: getPrice()
  -> Condition: price changed > 5%
  -> Webhook: POST to analytics API with price data
  -> Discord: "Price alert: {{ReadContract.result}}"
```
