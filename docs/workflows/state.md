---
title: "Workflow State"
description: "Keep values between runs of a workflow with the State Get and State Set nodes: block cursors, alert-once checks and change detection."
---

# Workflow State

Each workflow has a small key-value store that keeps its values from one run to the next. The **State Get** node reads a key and the **State Set** node writes one. Both are in the **System** category of the action grid.

Use workflow state for the values a workflow needs the next time it runs:

- The last block it scanned, so the next run starts where this one stopped
- The transactions it has already alerted on, so an alert fires once
- The last value it saw, so it acts only when that value changes

KeeperHub stores the data. There is no database to provision and no connection to configure.

## Scope and lifetime

- **One workflow.** Every run of a workflow reads and writes the same keys, whatever started the run: a schedule, an event, a webhook, a block, or a manual run from the editor.
- **Private to that workflow.** Other workflows cannot read or write it, including workflows in the same organization. To share data between workflows, use the Database Query node with your own database.
- **Lives as long as the workflow.** Editing and saving a workflow keeps its state. Deleting the workflow deletes its state.
- **Copies start empty.** Duplicating a workflow, importing it from JSON, or copying it from the Hub creates a new workflow with no state. State is not part of a workflow export.
- **Manual runs use live state.** A manual run from the editor writes to the same keys as scheduled and triggered runs. A test run that moves a cursor also moves it for the next live run.

## State Get

Reads one key.

### Fields

| Field | Required | Description |
|-------|----------|-------------|
| Key | Yes | The name of the key to read, for example `lastBlock`. Use `@` to build the key from upstream values. |

### Output

| Field | Type | Description |
|-------|------|-------------|
| `exists` | boolean | `true` when the key has a value that has not expired |
| `value` | any | The stored value, or `null` when the key does not exist |
| `version` | number | The key's version, or `0` when the key does not exist. See [Safe updates with expectedVersion](#safe-updates-with-expectedversion). |

A key that was never written and a key whose TTL has passed read the same way: `exists` is `false`, `value` is `null` and `version` is `0`.

### Using the value downstream

Reference the output with the `@` menu, which writes tokens such as:

```
{{@get-cursor:State Get.value}}
{{@get-cursor:State Get.exists}}
{{@get-cursor:State Get.version}}
```

In these examples `get-cursor` is the State Get node's id. The editor fills in the real id when you pick a field from the `@` menu.

When the key does not exist, `value` is `null`. In an action field, `{{@get-cursor:State Get.value}}` then resolves to an empty string and the run continues. Many fields treat an empty string as "use the default", which is what makes the [block cursor pattern](#block-cursor-for-event-scanning) work on its first run.

A path inside the value, such as `{{@get-cursor:State Get.value.lastBlock}}`, needs the value to exist. On a run where the key is missing, that reference stops the run with an unresolved reference error. When you store objects, check `exists` with a Condition node before you read fields inside the value. See [Runtime resolution](/workflows/templating#runtime-resolution) for the full rules.

## State Set

Writes one key. Each write is atomic: it replaces the whole value of the key in one step.

### Fields

| Field | Required | Description |
|-------|----------|-------------|
| Key | Yes | The name of the key to write. Use `@` to build the key from upstream values. |
| Value | Yes | The value to store. See [How values are stored](#how-values-are-stored). |
| TTL (seconds) | No | Seconds until the key expires. Leave empty to keep the key until the workflow is deleted. See [Expiry](#expiry). |
| expectedVersion | No | Write only if the key's version still matches this number. See [Safe updates with expectedVersion](#safe-updates-with-expectedversion). |

### Output

| Field | Type | Description |
|-------|------|-------------|
| `success` | boolean | `true` when the write was applied |
| `created` | boolean | `true` when this write created the key, or wrote a key that had expired. `false` when it replaced a live value. |
| `version` | number | The key's version after this write |

### How values are stored

The Value field is text in the editor. When the run reaches State Set, templates in the field are resolved first. State Set then reads the text and stores the type it describes:

| Value text after templates resolve | Stored as |
|------------------------------------|-----------|
| `{"block": 21000000, "hash": "0xabc"}` | JSON object |
| `["0xabc", "0xdef"]` | JSON array |
| `true` or `false` | Boolean |
| `21000000` | Number |
| `1500000000000000000000000` | Text, because the number is too large to store exactly. Token amounts in wei keep every digit. |
| `007` | Text, because the number would not print back as `007` |
| `paused` | Text |

Points to know:

- **Type text without quotes.** Text is stored exactly as you type it. To store the word `paused`, type `paused`.
- **Check JSON that contains templates.** If the text starts with `{` or `[` but is not valid JSON after the templates resolve, it is stored as text. A resolved value that contains a double quote is the usual cause. Open the State Set step in the run output to see what was stored.
- **The value cannot be empty.** An empty Value field, or a template that resolves to an empty string, stops the run with `State Set requires a "value"`.
- **Values written through the API or MCP keep their JSON type.** A node config that holds a number, object or array is stored as that type.

When a stored number, object or array is used in a downstream action field, it is written into that field as text. Objects and arrays become JSON text.

### Expiry

Set **TTL** to make a key expire a number of seconds after the write.

- The minimum is 1 second. Values above 365 days are reduced to 365 days. Fractions of a second are dropped.
- Each write sets the expiry again. A write with a TTL starts a new countdown. A write without a TTL removes any earlier expiry, so the key no longer expires.
- An expired key reads as missing: `exists` is `false`, `value` is `null` and `version` is `0`.
- Writing an expired key brings it back, and State Set reports `created: true`.
- Expired keys do not count toward the 100-key limit.

Use a TTL for keys you create per item, such as one key per alerted transaction, so old keys expire and free their slot. Leave TTL empty for long-lived keys such as a cursor.

## Limits

| Limit | Value |
|-------|-------|
| Value size | 8 KB (8,192 bytes) as JSON |
| Keys per workflow | 100 keys that have not expired |
| Key length | 256 characters. Spaces at the start and end of a key are removed. |
| TTL | 1 second to 365 days |

A write that goes over a limit stops the run with an error that names the limit. A write that replaces an existing key is always allowed, even when the workflow is at 100 keys.

Workflow state is for small values: cursors, ids, flags and short lists. To keep larger records, store an id or a cursor in state and keep the records in a database through the Database Query node, or in an external service through the HTTP Request node.

## Safe updates with expectedVersion

Two runs of the same workflow can run at the same time. This happens when a schedule fires while the previous run is still working, when an event trigger starts a run for each of several events, or when you start a manual run while a live run is in progress.

If both runs read `lastBlock = 100`, scan, and then write, one run's write replaces the other's. The result can be a skipped range or a duplicate alert. **expectedVersion** prevents this.

### How versions work

- The first write to a key sets its version to `1`. Each later write adds 1.
- State Get returns the current `version`, or `0` when the key does not exist.
- State Set with **expectedVersion** writes only when the key's version still equals that number. Pass the version from State Get:

```
{{@get-cursor:State Get.version}}
```

- `expectedVersion` of `0` means "write only if the key does not exist yet". Because State Get returns `0` for a missing key, passing its version protects the first write too.

### When the versions do not match

The key changed after this run read it, so another run got there first. State Set does not write. The step fails, the run stops, and the nodes after State Set do not run. The other run's value stays in place. The next run reads the newer value with State Get and continues from there.

A failed run caused by a version mismatch is expected, and it shows that the protection worked. If you see it often, the workflow's runs overlap often. Run the schedule less often, or make each run shorter.

### Where to put State Set

The position of State Set decides what happens when two runs race:

- **Before the action** (read, write state, then act). The run that wins the write does the work, and the other run stops before it acts. Use this order when a duplicate action is worse than a missed one, for example sending an alert or a transaction. If the action fails after the write, the item is already marked as done and is not retried.
- **After the action** (read, act, then write state). The state moves only after the work succeeds, so a failed action is tried again on the next run. Two racing runs can both do the work before one of them loses the write. Use this order when doing the work twice is safe and missing it is not.

### Without expectedVersion

A State Set without expectedVersion always writes, and the last write wins. This is correct when the newest value is always the one you want, such as the last price seen, or when runs of the workflow never overlap.

### Retries

State Get and State Set do not retry. A storage error stops the run. The next run starts again from the stored state, which the failed run did not change.

## Patterns

### Block cursor for event scanning

Scan each block once, with no gaps and no repeats between runs.

1. **Schedule trigger**, for example every 5 minutes.
2. **State Get** with Key `lastBlock`.
3. **Query Contract Events** with:
   - From Block: `{{@get-cursor:State Get.value}}`
   - Block Lookback: how far back the first run scans, for example `1000`
   - To Block: empty, which means the latest block
4. The nodes that handle the events, for example a For Each over `{{@query:Query Contract Events.events}}` that sends a notification.
5. **Math > Aggregate** to get the next block to scan:
   - Operation: Sum
   - Values: `{{@query:Query Contract Events.toBlock}}`
   - Post-Aggregation Arithmetic: Add to result, Operand `1`
6. **State Set** with:
   - Key: `lastBlock`
   - Value: `{{@next-block:Aggregate.result}}`
   - expectedVersion: `{{@get-cursor:State Get.version}}`

On the first run `lastBlock` does not exist. From Block resolves to an empty string, so Query Contract Events scans back by the Block Lookback. Each later run starts at the block after the last block scanned. From Block and To Block both include their end blocks, so the cursor stores `toBlock + 1`.

The two State nodes look like this in the workflow JSON:

```json
{
  "id": "get-cursor",
  "type": "action",
  "position": { "x": 350, "y": 250 },
  "data": {
    "type": "action",
    "label": "State Get",
    "config": {
      "actionType": "State Get",
      "key": "lastBlock"
    }
  }
}
```

```json
{
  "id": "save-cursor",
  "type": "action",
  "position": { "x": 1350, "y": 250 },
  "data": {
    "type": "action",
    "label": "State Set",
    "config": {
      "actionType": "State Set",
      "key": "lastBlock",
      "value": "{{@next-block:Aggregate.result}}",
      "expectedVersion": "{{@get-cursor:State Get.version}}"
    }
  }
}
```

To scan more than one contract or chain from the same workflow, give each a key of its own, for example `lastBlock:base` and `lastBlock:arbitrum`.

### Alert once per transaction

Send one alert per transaction, even when a later run sees the same transaction again.

Inside a For Each over the transactions:

1. **State Get** with Key `alerted:{{@loop:For Each.currentItem.hash}}`. Use the field that holds the transaction hash in your loop items.
2. **Condition**: `{{@seen:State Get.value}}` **does not exist**. The value is `null` until the key is written, so the true branch runs only for a transaction that has not been alerted on.
3. On the **true** branch, **State Set** with:
   - Key: `alerted:{{@loop:For Each.currentItem.hash}}`
   - Value: `true`
   - TTL: `86400` (one day)
   - expectedVersion: `{{@seen:State Get.version}}`
4. After State Set, the alert node.

State Set comes before the alert, so when two runs reach the same transaction, only the run that writes the key sends the alert. The TTL removes each key after a day, which keeps the workflow under the 100-key limit. Set the TTL to cover the longest time a transaction can appear in your scan window.

This pattern fits workflows that alert on fewer than 100 items per TTL period. For more items, use the [block cursor](#block-cursor-for-event-scanning) so each run sees each transaction once, or keep a short list of recent hashes in a single key.

### Act only when a value changes

Notify when a value changes, such as a contract owner, a paused flag or a price band, and stay quiet while it stays the same.

1. **State Get** with Key `lastOwner`.
2. The node that reads the current value, for example **Read Contract**.
3. **Condition**: the current value **not equals** `{{@last:State Get.value}}`.
4. On the **true** branch, the notification, then **State Set** with Key `lastOwner` and Value set to the current value.

On the first run the key does not exist, so the stored value is `null` and differs from the current value. The first run sends one notification and records the starting value. Leave expectedVersion empty here: the newest value is always the correct one to keep.

## Viewing and resetting state

- **View a value.** No page lists a workflow's keys. Open a run in the run history and select the State Get or State Set step to see the value it read or wrote. To check a value now, run the workflow manually.
- **Reset a key.** Write a new value with State Set. To remove a key, write it with a TTL of `1`, and it expires one second later. A temporary State Set node and a manual run do this without changing the main flow.
- **Reset everything.** Delete the workflow, or work on a copy: a copy starts with empty state.

## Errors

All errors stop the run and show on the failed step.

| Error | Cause | What to do |
|-------|-------|------------|
| `State key must be a non-empty string` | The Key field is empty, or its template resolved to an empty string | Set a key, or check the upstream value used in the key |
| `State key exceeds the 256-character limit` | The key is longer than 256 characters | Use a shorter key, or build it from an id or hash |
| `State Set requires a "value"` | The Value field is empty, or its template resolved to an empty string | Check the upstream value. On a first run, a missing State Get value resolves to an empty string. |
| `State value is N bytes serialized; the limit is 8192 bytes...` | The value is larger than 8 KB as JSON | Store an id or a cursor, and keep the record in a database |
| `Workflow state is limited to 100 keys per workflow...` | The workflow already has 100 keys that have not expired | Reuse keys, add a TTL to per-item keys, or keep a list in one key |
| `ttl must be a number of seconds` | The TTL is not a number | Enter a number of seconds, or leave TTL empty |
| `ttl must be at least 1 second` | The TTL is 0 or negative | Enter 1 or more |
| `expectedVersion must be a non-negative integer` | expectedVersion is not a whole number of 0 or more | Use `{{@get-cursor:State Get.version}}` |
| `Compare-and-set failed: key "..." changed since it was read...` | Another run wrote the key after this run read it | No action needed. The next run continues from the newer value. See [When the versions do not match](#when-the-versions-do-not-match). |
| `Compare-and-set failed: key "..." already exists (expected version 0...)` | expectedVersion was `0` and another run created the key first | No action needed. The next run reads the key. |
| `Compare-and-set failed: key "..." does not exist (or has expired)...` | expectedVersion was above 0, and the key expired or was never written | Pass the version from State Get, which is `0` for a missing key |
| `Failed to read workflow state` or `Failed to write workflow state` | A temporary storage error | The next run tries again with the stored state unchanged |
| `Unresolved template reference` on a path inside `State Get.value` | The key does not exist on this run, so the value is `null` | Check `exists` with a Condition node before you read fields inside the value |

## API, MCP and CLI

State Get and State Set are system actions. Use them in workflows that you create through the [API](/api/workflows), the [MCP server](/agent/mcp-server) or the [CLI](/cli) in the same way as in the editor:

| Node | `actionType` | Config fields |
|------|--------------|---------------|
| State Get | `State Get` | `key` |
| State Set | `State Set` | `key`, `value`, `ttl`, `expectedVersion` |

- `value` accepts any JSON value: string, number, boolean, object or array.
- `ttl` and `expectedVersion` accept a number or a numeric string, which lets them hold templates.
- Both nodes run only inside a workflow. They are not available as direct executions.
- Through MCP, `list_action_schemas` returns the fields and outputs of both nodes.
