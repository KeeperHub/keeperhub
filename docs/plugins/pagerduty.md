---
title: "PagerDuty Plugin"
description: "Trigger, acknowledge and resolve PagerDuty incidents from a workflow, without pasting routing keys."
---

# PagerDuty Plugin

Page on-call from a workflow. You pick a service from your PagerDuty account and KeeperHub builds the Events API request, including the deduplication key that stops a repeating check from paging someone every run.

The routing key that authorises an event is never stored in the workflow. The node stores the service id, and the key is read from PagerDuty each time the node runs.

## Actions

| Action | Description |
|--------|-------------|
| Trigger Incident | Open or update an alert on a service |
| Acknowledge Incident | Acknowledge that alert without resolving it |
| Send Change Event | Record a deploy or config change on a service timeline; never pages |
| Resolve Incident | Close the alert carrying a given dedup key |
| Create Incident (REST) | Create an incident directly, with an escalation policy override and urgency |

The first four use the Events API v2 and work with a read-only credential. Create Incident uses the REST API and needs a write-capable one.

## Setup

1. In PagerDuty, go to **Integrations > Developer Tools > API Access Keys > Create New API Key**
2. Tick **Read-only API Key**. Read-only is enough for every action except Create Incident
3. Copy the key. PagerDuty shows it once
4. In KeeperHub, go to **Settings > Organization > Connections**, click **Add Connection** and select PagerDuty
5. Paste the key. Tick **EU service region** if your PagerDuty address contains `.eu`
6. Click **Test Connection**, then save

The connection belongs to the organization it is created in and is not visible to any other organization.

### What happens when the person who added it leaves

A connection stays owned by whoever created it.

- **Deactivated account:** KeeperHub freezes every connection that person created, for the whole organization and immediately. Workflows using them fail with a message saying so. The fix is to recreate the connection under an active member - editing it is not enough, because it keeps its original owner.
- **Removed from the organization, account still active:** the connection keeps working. Removing someone from a team does not revoke the PagerDuty credential they configured, so rotate the key in PagerDuty and update the connection, or delete it, as part of offboarding.
- **Someone else edits it:** rotating the token through **Edit** takes effect on the next run. Removing the connection in KeeperHub does not revoke the key at PagerDuty; delete it there too, under **Integrations > Developer Tools > API Access Keys**.

The connection takes **one** credential, not both. Fill in the API token and the scoped OAuth fields are held shut; start with OAuth and the token field is held shut instead. Each is labelled Option A and Option B on the form, and the one not in use offers to take over if you picked the wrong one. If an older connection has both filled in, nothing is locked and the form says which one is actually used -- the token, which is the precedence the run time applies.

### Scoped OAuth instead of a token

PagerDuty recommends scoped OAuth over account-wide keys, and the plugin accepts either. Register an app under **Integrations > Developer Tools > App Registration**, set Functionality to **Scoped OAuth**, and grant only:

- `services.read`
- `escalation_policies.read`

Add `incidents.read` if you want the acknowledge and resolve actions to check the incident afterwards, `priorities.read` if you want the priority picker on Create Incident to list your account's priorities, and `incidents.write` if you use Create Incident. Grant only the ones you need: each call asks PagerDuty for the two scopes above plus the one it needs, so any combination you register works. Each is optional and only the feature that needs it is affected: without `incidents.read` the check reports the status as unknown, and the acknowledge or resolve itself still goes through. Fill in the client id, client secret and your account subdomain, and leave the API token blank.

If the account is ever renamed, update the subdomain field: the OAuth scope string carries it. An API token is unaffected by a rename, and nothing in a workflow has to change either way, because services and escalation policies are stored by id.

### Checking it works before you need it

Two checks, at the two points where something can be wrong.

When a picker cannot read the account at all, it offers **Check the connection**, which opens the connection in Settings - because every cause of that message is fixed there or in PagerDuty, not on the node.

**Test Connection**, on the connection form when you add or edit it, runs `GET /services?limit=1` -- the exact permission every action needs. It tells a bad token from a wrong region from a rate limit from a network fault, and on a `401` it tries the other service region and says which way to set the checkbox.

**Send a test alert**, on the node itself once a connection and a service are picked, does what the connection test cannot: it proves the *service* works. A valid credential says nothing about the service you just chose, and a service with no Events API v2 integration, a disabled one, one inside a maintenance window and one wired to the wrong rota all look identical in the dropdown.

It opens a real alert on that service at `info` severity, acknowledges it, resolves it, and reports each leg. Three things make it safe to press:

- It uses a dedup key of its own, so it can never merge into or close an alert one of your workflows opened.
- It ends resolved, so nothing is left for anyone to tidy up.
- The summary says what it is, in case the service notifies before the resolve lands. If the service is in maintenance or disabled, the result says the test proved the routing and proved nothing about anybody being paged.

It does reach on-call's real service. On a service that notifies on `info` events, somebody may see it briefly.

### Every service needs an Events API v2 integration

An event reaches a service through an integration on that service. In PagerDuty, open the service, go to **Integrations**, and add an **Events API v2** integration if it has none. The service picker marks services that cannot take events.

## Trigger Incident

Open an alert, or update the one already open for the same dedup key.

**Inputs:** PagerDuty service (picked from your account), Summary (becomes the alert title), Severity (`critical`, `error`, `warning`, `info`), Source, Dedup key, and optional Component, Group, Class, Custom details and Links. Supports `{{NodeName.field}}` variables throughout.

**Outputs:** `delivered`, `dedupKey`, `status` (`triggered`, `suppressed`, `held`, or `failed`), `consecutiveRuns`, `requiredRuns`, `error`, `summaryFellBack`, `serviceStatus`, `suppressedByService`, `detailsTruncated`, `linksDropped`, `fieldsTrimmed`, `message`, and the backup fields below.

**Links** go one per line, as `text | url` or a bare url - the url is the last field, so a label may contain `|` of its own - and become clickable links on the incident - the explorer transaction or the dashboard a responder opens first. The url has to be `https`. A line that is not an https url is skipped rather than failing the page, because a page with one missing link beats no page; the Preview on the node shows exactly which links will be sent, and `linksDropped` counts the ones that will not.

Every picker -- services, escalation policies, incident priorities -- shows the object's **id** next to its name in grey monospace, and so does the field once one is chosen. That is deliberate: the node stores the id and reads the name from PagerDuty on every load, so a service renamed there quietly appears under its new name. The id is the part that does not move. If the account cannot be read at all, each field shows the stored id rather than falling back to its placeholder, so a configured node never reads as an empty one. Priorities go one step further: on an account that has none -- a plan that no longer includes them looks exactly like one that never did -- a node still asking for a priority id says so, because PagerDuty will reject that incident.

**Deduplication.** Leave the dedup key blank and the node uses one key per node, so a check that keeps failing updates one alert instead of paging on every run. Put a vault address or chain id in the field to page per subject instead. Once an alert is resolved, the next trigger with the same key opens a new one.

That merging is also what makes concurrency safe here. Two runs of the same workflow overlapping, or the same node firing twice before the first run finishes, send two events carrying one key and PagerDuty folds them into a single alert -- one page, not two. The flip side is that two *different* Trigger Incident nodes given the same explicit key share one alert between them, and a Resolve on either closes it for both; the Preview warns when it sees that on a canvas, because nothing at run time will.

The one ordering that does lose is a Resolve arriving before the Trigger it was meant to close -- possible when two runs overlap and the healthy one finishes first. PagerDuty drops an update whose key matches no open alert, so the Trigger then opens an alert nobody closes.

Two things address it. The read-back catches it after the fact: it is on by default and reports `incidentStatus: unknown`. And **Wait before sending**, on both Resolve and Acknowledge, avoids it in the first place -- set it to a second or two and the update holds back long enough for the Trigger to land, so it applies to a real alert instead of being dropped. The wait happens after the routing key is resolved and immediately before the event is sent, so it sits as close to the send as it can and a Resolve that cannot reach PagerDuty at all fails immediately rather than waiting first. It costs that much time on every run of that node, so leave it at 0 unless runs of the workflow can actually overlap. Maximum 5 seconds: this is for losing a race by a moment, not for scheduling, and the step occupies a worker while it waits. The node reports `delayedSeconds` when it waited.

**Paging only after several failures.** Set **Consecutive runs before paging**, under **Advanced** at the foot of the node, to hold a flapping check. With 3, the first two runs that reach the node are held and the third pages. A run that finishes successfully without reaching the node resets the count, so one healthy check clears it. A run that failed, was cancelled, or was refused before it started does not reset it and does not advance it - it never got far enough to say whether the condition cleared, and during the outage this node exists to page for those are most of the runs. Held runs are recorded in the output, not silently dropped.

**Severity, urgency and priority are three different things.** Severity describes the condition. On a service using dynamic urgency, `critical` and `error` page at high urgency while `warning` and `info` do not; on other services the service's urgency rule decides. Priority (P1, P2) cannot be set on an event at all: PagerDuty assigns it from the service's Event Orchestration rules, or you set it directly with Create Incident.

**An empty summary still pages.** If the summary template renders to nothing, the alert goes out with a title saying so and carries the template in its details, and the output sets `summaryFellBack`. A page with a poor title beats no page.

**When to use:** A keeper has stopped submitting, a vault crossed a liquidation threshold, a bridge stalled, a balance ran dry.

**Example workflow:**
```
Schedule (every 5 min)
  -> Check keeper health
  -> Condition: last submission older than 3 blocks
  -> PagerDuty: Trigger Incident (severity error, hold for 2 consecutive runs)
```

## Resolve Incident and Acknowledge Incident

Close, or acknowledge, the alert carrying a given dedup key.

**Inputs:** PagerDuty service, Dedup key of the alert (required), and an optional check of the incident afterwards.

**Outputs:** `delivered`, `dedupKey`, `action`, `message`, `delayedSeconds` when the node was told to wait, `error` when the event was not delivered and the node was told not to fail the run, and, when the check is on, `incidentStatus`, `incidentUrl`, `incidentPriority` and `verificationError`. The status is the one observed after the event was sent; the Events API is asynchronous, so it can still show the previous state for a moment.

Both carry **Wait before sending**; see the deduplication note above for the race it exists for. What a dropped update costs differs -- a dropped resolve leaves an incident nobody closes, a dropped acknowledge leaves PagerDuty escalating an incident the workflow believes it has taken responsibility for -- but the ordering that causes both is the same one.

Both actions need the dedup key of the alert they are closing. Pick the **Trigger Incident node** whose alert this closes and the same key is derived here; only set the dedup key field when that trigger uses a key of its own, in which case put the same value on both nodes.

Pick the node rather than referencing `{{Trigger Incident.dedupKey}}`: on the healthy branch of a check the trigger node never ran, so a template reference to its output cannot resolve and the run would fail -- which is exactly the branch a resolve belongs on. The service must also be the same one the trigger used, because PagerDuty drops an update that arrives through a different service's routing key.

PagerDuty answers `202 Accepted` to an acknowledge or a resolve whether or not it had an open alert to apply it to, so a key that matches nothing looks exactly like success. Turn on **Check the incident afterwards** to read the incident back and report its real status; an inconclusive answer is reported as `unknown` and never fails the run.

**Example workflow:**
```
Schedule (every 5 min)
  -> Check keeper health
  -> Condition: healthy?
       true  -> PagerDuty: Resolve Incident (alert opened by: Page on-call)
       false -> PagerDuty: Trigger Incident
```

## Send Change Event

Record a deploy, a config change or a migration on the service's timeline. Change events never page anyone; they appear next to the incidents they often explain.

Unlike every other action here, a change event carries no dedup key - PagerDuty offers none for them. A retry after a response that was lost in transit therefore leaves a second entry on the timeline. The retries are on by default anyway, because a duplicate deploy marker is cosmetic and a missing one is not; set **Retry attempts** to 0 if you would rather have neither.

**Inputs:** PagerDuty service, Summary, Source, Custom details.

**Outputs:** `delivered`, `message`, `fieldsTrimmed`, and `error` when the change event was not delivered and the node was told not to fail the run.

## Create Incident (REST)

Create an incident directly rather than through an alert. This is the only action that can override the escalation policy, set urgency or set a priority, and the only one that needs a write-capable credential plus a **From email** -- the login email of a real PagerDuty user, which PagerDuty attributes the incident to.

**Inputs:** PagerDuty service, Title, Details, Escalation policy (optional override), Urgency, Priority, Incident key, From email.

**Priority** is read from your account (P1, P2, and so on) and is a paid-plan feature -- an account without it shows nothing to pick. Only this action can set one: the Events API v2 payload has no priority field, so an alert raised by Trigger Incident takes its priority from your Event Orchestration rules instead. **Urgency** decides whether the incident notifies on-call at all; left at the service default, PagerDuty applies the service's urgency rule.

**Outputs:** `delivered`, `incidentId`, `incidentNumber`, `incidentUrl`, `status`, `priorityId`, `fieldsTrimmed`, `escalationPolicyFellBack`, and `error` when the incident was not created and the node was told not to fail the run.

Unlike the Events API dedup key, a repeated incident key is rejected by PagerDuty rather than merged, so leave it blank unless you are deliberately guarding against a double-create. If the escalation policy you chose has been deleted, the incident is still created on the service's own policy and the output says so; turn that fallback off to fail instead.

## When PagerDuty will not take the page

Every failure names the object it is about, and the ones that cannot succeed on a second attempt are not retried:

| What happened | What the node does |
|---------------|--------------------|
| Service deleted, or not visible to these credentials | Fails naming the service id. The node keeps the id rather than repointing at another service. The picker offers **Open in PagerDuty** for it: gone means deleted, a service that loads means this connection cannot see it |
| Service disabled in PagerDuty | Fails. A disabled service accepts events and raises no incident, so the page would have gone nowhere |
| Service in a maintenance window | Delivers, with `status: suppressed` and `suppressedByService` -- PagerDuty takes the event and raises no incident until the window ends. Branch on `status`, not `delivered` |
| Service has no Events API v2 integration | Fails naming the service and the fix |
| Token revoked, or presented to the wrong region | Fails with a credential error. Test Connection tells you when the region checkbox is the cause |
| PagerDuty account lapsed or downgraded | Fails with PagerDuty's `402`: the plan does not allow the request |
| Rate limited, 5xx, network fault | Retried, twice by default, honouring the delay PagerDuty asks for |
| Payload rejected (`400`) | Fails immediately, quoting PagerDuty's own error. An empty summary is not the cause - that is handled with a fallback title - and every templated field is bounded, so this is rare |

Because the trigger action reads the routing key from PagerDuty before it sends anything, a dead account or a dead credential fails on that read rather than firing an event nobody receives. The resolved key is cached for five minutes so a REST blip cannot stop a page, so a credential revoked in the last few minutes may still page from cache - deliberately, because a page sent on a stale key is better than one not sent at all. A service that is disabled or in a maintenance window is never read from cache, so re-enabling one takes effect on the next run.

### Field limits

PagerDuty enforces three limits, and this node applies them before it sends anything:

| Field | Limit | Source |
|-------|-------|--------|
| Summary, and Create Incident's Title | 1024 characters | PagerDuty's documented maximum for an alert summary |
| Dedup key, and Create Incident's Incident key | 255 characters | PagerDuty's documented maximum |
| The whole event | 512 KB | PagerDuty rejects a larger one outright |
| Source, Component, Group, Class | 1024 characters | No PagerDuty limit is documented; this node applies the summary's ceiling so one templated value cannot push the event over 512 KB |

An over-limit value is **shortened, not rejected**: an alert with a cut title still wakes the right person, and refusing to page over a long template would be the worse failure. It is never silent, though:

- The **Preview** on the node warns while you are configuring, naming the field and both lengths, for any value it can already measure.
- The node's **`fieldsTrimmed`** output names every field it shortened and by how much, which is the only way to see it for a value that arrives through a template - a template is short in the editor and long once a variable fills it in.
- The run log carries the same line.

If the whole event is still over 512 KB, the custom details are dropped and replaced by a note, then the links; `detailsTruncated` says when that happened. The summary, severity and routing are never sacrificed.

A shortened **dedup key** deserves a second look. Two keys that differ only after character 255 become the same key, so two nodes that should own separate alerts end up updating one. That is the case `fieldsTrimmed` exists to surface.

### What happens if PagerDuty changes their API

The integration pins what it can and fails loudly for the rest.

**Pinned.** REST calls send `Accept: application/vnd.pagerduty+json;version=2`, so a v3 cannot arrive unannounced. The Events API is versioned in its path (`/v2/enqueue`), so the same holds there.

**Changes that fail loudly**, with a message naming what was missing, are the great majority: a renamed or removed response field, a moved endpoint, a changed authentication or scope model, a rejected payload, a tightened limit. Each surfaces as a failed run quoting PagerDuty's own error.

**The change that could fail quietly** is a new enum value, because an unknown string has to be interpreted as something. Each is handled so that it reports rather than assumes:

| New value from PagerDuty | What the node does |
|---|---|
| A service status (today: `active`, `warning`, `critical`, `maintenance`, `disabled`) | Sends the event anyway -- refusing to page over an unfamiliar status would be far worse -- and says in `message` that it cannot tell whether an incident was raised, naming the status |
| An incident status (today: `triggered`, `acknowledged`, `resolved`) | Reports `incidentStatus: unknown` rather than guessing |
| A severity | Falls back to `error`, the middle of the scale |
| A raised size or length limit | Keeps trimming to the old one and reports it in `fieldsTrimmed`; conservative, never lost |

**Checking on purpose.** **Send a test alert** on the node runs the full round trip -- trigger, acknowledge, resolve -- against a real service, and reports each leg. Running it periodically against a sandbox account is the way to learn about a breaking change from monitoring rather than from an incident.

### Exporting and importing a workflow

A workflow with PagerDuty nodes exports and imports cleanly, and stays reusable in another organisation.

Import keeps every node id, which is what makes the references work: `{{@nodeId:Node.field}}` in a summary, a source, custom details or a link all resolve exactly as they did, and so does the bare node id the Resolve and Acknowledge actions store to name the trigger they close. Nothing has to be rewritten because nothing moved. (Duplicating a workflow *does* regenerate ids, which is why duplication rewrites both.)

What does not travel is credentials. The PagerDuty connection is stripped, and so is the backup Discord, Slack or Telegram connection -- both are ids belonging to the organisation that exported, and an export is a file people pass around. The importer picks their own on each node; the pickers show an empty connection rather than a reference that silently resolves to nothing.

The **service id** does travel, deliberately. It is not a credential, and an imported workflow that names `PSVC123` should say so: if that service is not in the importing account, the picker says exactly that rather than quietly repointing the page at another team.

### Backup notification

Set **Backup connection** on the trigger action to an existing Discord, Slack or Telegram connection. When the event cannot be delivered after the retries, the same alert -- plus the reason PagerDuty refused it -- is posted there instead. The run is still marked failed: the backup is for the person who should be woken now, the failed run is for whoever reads history later.

Only connections that already exist in the organization are offered, so a workflow cannot point this at a new destination.

## Retries

Retries default to 2, where a chat integration defaults to 0. Every event this plugin sends carries a dedup key, so an event that arrives twice updates one alert instead of paging twice, which makes a retry safe. Connection failures and the statuses worth another try (408, 425, 429, 5xx) are retried; a 400 never is.
