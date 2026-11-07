---
title: "Failure Alerts API"
description: "KeeperHub Failure Alerts API - read and change a workflow's alert rules, pause its alerts, and list the alerts sent to your organization."
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

While the workflow's alerts are paused, `override` carries `pausedUntil`, `pauseUntilSuccess`, `pauseReason`, `pausedBy` and `pausedByAccount`; otherwise they are `null` (`pauseUntilSuccess` is `false`).

`connections` lists the connections shared with the organization that a method can use. `unsharedConnections` lists your own connections that are not shared, which a method cannot use until they are.

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
| `disableWorkflow` | boolean | Disable the workflow when it reaches the limit |
| `pausedUntil` | string \| null | Pause alerts until this ISO time, at most 7 days ahead |
| `pauseUntilSuccess` | boolean | Pause until the workflow works again, at most 7 days |
| `pauseReason` | string | Required to pause, extend or change a pause: 3 to 200 characters |

Sending the pause fields unchanged keeps the pause as it is. Sending neither `pausedUntil` nor `pauseUntilSuccess` resumes. The response is the same as the `GET`, plus `pauseChange`: `paused`, `changed`, `resumed`, or `null` when the pause did not change.

Every pause, change to a pause and resume is announced: the people the workflow's alerts reached before the change, and every owner, get a notice by email and on the workflow's chat methods, and it is listed in the organization's sent alerts. People taken off a recipient list are told the same way. A workflow's pause can change at most 6 times an hour; more is refused with `429`.

## Get Organization Alert Settings

```http
GET /api/organizations/{organizationId}/failure-alerts
```

Returns the organization's rules, who gets email, its methods (with each one's health), the connections methods can use, any pause, every workflow with its own rules or paused alerts, and `version`, which a change can send back so it is refused if someone else saved first.

## Update Organization Alert Settings

```http
PUT /api/organizations/{organizationId}/failure-alerts
```

Needs an owner or admin.

### Request Body

| Field | Type | Description |
|-------|------|-------------|
| `version` | number | Optional. The `version` from the last read; a stale one is refused with `409` |
| `threshold` | number | Failed runs in a row before an alert, 1 to 20 |
| `timeLimitMinutes` | number \| null | Also alert after this long failing: `60`, `360` or `1440`; `null` or `0` for no time limit |
| `remindDaily` | boolean | Remind once a day while a workflow keeps failing. Leave it out to keep it as it is (on by default) |
| `notifyRecovery` | boolean | Tell people when a workflow works again. Leave it out to keep it as it is (on by default) |
| `recipientUserIds` | string[] | Members to email. Must include at least one owner or admin who can receive email |
| `channels` | object[] | Optional. The full list of chat and PagerDuty methods, up to 20; leave it out to keep them as they are |

Each item in `channels` has `integrationId` (a connection shared with the organization), `destination` (chat ID, channel or PagerDuty service, depending on the connection) and `role` (`"always"` or `"backup"`); send `id` to keep an existing method. Each new or changed method is checked before it is saved; one that cannot receive alerts is refused with `400`.

## Pause Organization Alerts

```http
PUT /api/organizations/{organizationId}/failure-alerts/pause
DELETE /api/organizations/{organizationId}/failure-alerts/pause
```

Needs an owner or admin. `PUT` pauses every alert of the organization until `until` (an ISO time, at most 7 days from when the pause started), with an optional `reason`. `DELETE` resumes at once. Workflows keep running while alerts are paused. Each pause, change and resume is announced to everyone who gets alerts, and at most 5 can happen in an hour; more is refused with `429`.

## Send a Test

```http
POST /api/organizations/{organizationId}/failure-alerts/test
```

Needs an owner or admin. Sends one test message and reports whether it was delivered.

| Field | Type | Description |
|-------|------|-------------|
| `channel` | string | `email`, `slack`, `discord`, `telegram` or `pagerduty` |
| `to` | string | Email only: `"me"` (default) or `"recipients"` |
| `recipientUserIds` | string[] | Email only, with `to: "recipients"`: who to email |
| `integrationId` | string | Chat and PagerDuty: the connection to test |
| `destination` | string | Chat and PagerDuty: where to send it |
| `channelId` | string | Optional: a saved method; a passing test turns a method that stopped working back on |
| `pagerDutyMode` | string | PagerDuty only: `"change"` (default, no page) or `"page"` |

Tests are rate limited; too many are refused with `429`.

## Preview a Message

```http
GET /api/organizations/{organizationId}/failure-alerts/preview?sample=alert
```

Returns a sample message as each method would show it. `sample` is `alert` (default), `missed`, `disabled` or `recovery`.

All `PUT` and `POST` bodies must be a JSON object; anything else is refused with `400`.

## List Sent Alerts

```http
GET /api/organizations/{organizationId}/failure-alerts/history
```

Every alert, reminder, recovery and notice sent to the organization, newest first.

### Query Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `page` | number | A numbered page from 1 to 100000, with `total` and `pages` in the response |
| `cursor` | string | The `nextCursor` of the previous response, in place of `page` |
| `limit` | number | Rows per page, at most 500 |
| `workflow` | string | A workflow's exact id, or part of its current name, so alerts sent before a rename still match. At most 200 characters |
| `workflowId` | string | One workflow's exact id |
| `kind` | string | One message kind, such as `alert`, `reminder`, `recovery`, `workflow_alerts_paused`, `workflow_alerts_resumed`, `workflow_alerts_pause_ended` or `recipients_removed` |
| `scope` | string | `alerts`: alerts, reminders, recoveries and notices about silencing, without the organization-wide pause notices or tests. `people`: what people did: pauses and resumes (of one workflow or the whole organization), removals from alerts and tests |
| `result` | string | `delivered`, `failed`, `waiting` or `withdrawn` |
| `channel` | string | `email`, `slack`, `discord`, `telegram` or `pagerduty` |
| `by` | string | Who caused it: a person's name, or `KeeperHub` |
| `to` | string | Part of the address or channel it went to |
| `since` | string | `24h`, `7d` or `30d` |
| `format` | string | `csv` returns up to 500 rows as a CSV file |
