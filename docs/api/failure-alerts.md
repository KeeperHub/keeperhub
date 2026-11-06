---
title: "Failure Alerts API"
description: "KeeperHub Failure Alerts API - read and change a workflow's alert rules and mute, and list the alerts sent to your organization."
---

# Failure Alerts API

Failure alerts tell your team when a workflow that runs on its own keeps failing. These routes are available to organizations with failure alerts turned on; for any other organization they answer `404`.

## Authentication

Routes accept a session cookie or an organization API key (`Authorization: Bearer $KEEPERHUB_API_KEY`). Any member can read. Changing a workflow's alert settings needs an owner or admin; a key needs the `mcp:write` scope.

## Get Workflow Alert Settings

```http
GET /api/workflows/{workflowId}/failure-alerts
```

Returns the organization's rules, the workflow's own settings (`override`), the settings in effect, its current failing state, and `version`, which a change must send back.

While the workflow is muted, `override` carries `mutedUntil`, `muteUntilSuccess`, `muteReason`, `mutedBy` and `mutedByAccount`; otherwise they are `null` (`muteUntilSuccess` is `false`).

## Update Workflow Alert Settings

```http
PUT /api/workflows/{workflowId}/failure-alerts
```

### Request Body

| Field | Type | Description |
|-------|------|-------------|
| `version` | number | The `version` from the last read. A stale one is refused with `409` |
| `threshold` | number \| null | Failed runs in a row before an alert, 1 to 20. `null` follows the organization |
| `timeLimitMinutes` | number \| `"off"` \| null | Also alert after this long failing. `null` follows the organization |
| `recipientUserIds` | string[] \| null | Members to email. `null` follows the organization. The list must keep at least one owner or admin who can receive email |
| `customChannels` | boolean | Use the workflow's own `channels` instead of the organization's |
| `pauseWorkflow` | boolean | Disable the workflow when it reaches the limit |
| `mutedUntil` | string \| null | Mute alerts until this ISO time, at most 7 days ahead |
| `muteUntilSuccess` | boolean | Mute until the workflow works again, at most 7 days |
| `muteReason` | string | Required to mute, extend or change a mute: 3 to 200 characters |

Sending the mute fields unchanged keeps the mute as it is. Sending neither `mutedUntil` nor `muteUntilSuccess` unmutes.

Every mute, change to a mute and unmute is announced: the people the workflow's alerts reached before the change, and every owner, get a notice by email and on the workflow's chat methods, and it is listed in the organization's sent alerts. People taken off a recipient list are told the same way. A workflow's mute can change at most 6 times an hour; more is refused with `429`.

## List Sent Alerts

```http
GET /api/organizations/{organizationId}/failure-alerts/history
```

Every alert, reminder, recovery and notice sent to the organization, newest first.

### Query Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `page` | number | A numbered page, with `total` and `pages` in the response |
| `cursor` | string | The `nextCursor` of the previous response, in place of `page` |
| `limit` | number | Rows per page, at most 500 |
| `workflow` | string | A workflow's exact id, or part of its current name, so alerts sent before a rename still match. At most 200 characters |
| `workflowId` | string | One workflow's exact id |
| `kind` | string | One message kind, such as `alert`, `reminder`, `recovery`, `workflow_muted`, `workflow_unmuted`, `mute_ended` or `recipients_removed` |
| `scope` | string | `alerts`: alerts, reminders, recoveries and notices about silencing, without pause notices or tests |
| `result` | string | `delivered`, `failed`, `waiting` or `withdrawn` |
| `channel` | string | `email`, `slack`, `discord`, `telegram` or `pagerduty` |
| `by` | string | Who caused it: a person's name, or `KeeperHub` |
| `to` | string | Part of the address or channel it went to |
| `since` | string | `24h`, `7d` or `30d` |
| `format` | string | `csv` returns up to 500 rows as a CSV file |
