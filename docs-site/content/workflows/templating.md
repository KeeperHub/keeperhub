---
title: "Templating reference"
description: "Canonical grammar for the `{{...}}` template tokens you can use to wire upstream node outputs into a downstream node's config."
---

# Templating reference

KeeperHub workflows wire data between nodes using `{{...}}` template tokens. A template token is any string of the form `{{ ... }}` that appears inside a node's config field. When the workflow runs, the executor replaces each token with the corresponding upstream value.

This page is the canonical reference. If a token does not match one of the grammars listed below, the executor will refuse to run the action and surface an error pointing at the offending reference. If a token does match the grammar but the upstream value cannot be resolved at runtime (the node has not run yet, the field does not exist, the upstream returned `null`), the executor will likewise abort the action with a structured error.

## Supported grammars

Three forms are recognized. Use the stored format whenever possible; the editor's `@` autocomplete writes it directly. The other two exist for backwards compatibility and direct hand-authoring.

### Stored format

```
{{@nodeId:Label[.path]}}
```

- `nodeId` is the upstream node's id (the one shown in the URL when you click the node, also persisted in the workflow JSON)
- `Label` is the upstream node's display name (rendered in the editor; case-insensitive at runtime)
- `path` is an optional dot-separated field accessor

Examples:

```
{{@a_1:HTTP Request.data.user.name}}
{{@trigger_node:Trigger.timestamp}}
{{@a_2:Read Contract.result}}
{{@n3:My Step}}
```

This is the form the editor produces when you click a field from the autocomplete dropdown. Prefer it because the `nodeId` is stable across renames; if you change a node's display label, references that use the stored format keep working.

### Display format (label-only)

```
{{Label[.path]}}
```

Examples:

```
{{HTTP Request.data.items[0].name}}
{{Trigger.timestamp}}
```

Resolves by case-insensitive label match. Brittle if you rename nodes; the editor will keep showing the same label, but if two nodes share a label the resolver picks the first match. Prefer the stored format above for new authoring.

### Legacy `$` format

```
{{$nodeId[.path]}}
```

Examples:

```
{{$node_1.data.items[0].name}}
{{$trigger.timestamp}}
```

Predates the stored format. Behaves like the stored format for resolution purposes (id-based lookup), but lacks the embedded display label that makes the stored form readable in the workflow JSON.

## Path syntax

The `path` portion of any of the three forms supports dotted field access and array indexing:

```
data.user.name        // nested object
data.items[0].name    // first array element, then field
status                // top-level field
```

Indices must be numeric. There is no slice syntax, no wildcard, no expression evaluation; what you see is what gets resolved.

## What is NOT supported

These shapes parse as invalid and the workflow will fail to save:

| Token | Why |
|-------|-----|
| `{{}}` or `{{ }}` | Empty body |
| `{{@nodeId}}` | Stored format requires a colon and a label |
| `{{@:Label}}` or `{{@id:}}` | Stored format requires both halves |
| `{{$}}` | Legacy `$` format requires a body |

The following parses but will fail at **runtime** if the reference cannot be resolved:

| Token | Why |
|-------|-----|
| `{{$trigger.input.ts}}` | n8n-style `$variable` is not recognized as a node id |
| `{{Some Label.x}}` where `Some Label` does not match any node | Display format requires a real label |
| `{{@n1:Label.does.not.exist}}` | Field path does not exist on the upstream output |

When a runtime resolution fails, the action aborts with a structured error listing every unresolved reference. Earlier behaviour silently substituted an empty string or left the literal `{{...}}` token in the rendered value, which caused real on-chain corruption when the corrupted value flowed into a write action. The strict mode is the default.

## Where templates can appear

Templates work in any string-valued config field. Common places:

- Action input fields (URLs, addresses, message bodies)
- Conditions (Condition node expressions)
- Database Query parameters (parameterized as `$1`, `$2`, ... at execution time)
- Run Code source (string-valued upstream data is JSON-stringified into the code so it remains valid JavaScript when inlined)

Templates do **not** work inside binary fields (images, file uploads) or inside the workflow's structural metadata (node ids, edge ids, position).

## Runtime resolution

The executor always fails closed: any unresolved reference aborts the action with a clear error. Empty-string substitution and literal `{{...}}` pass-through are not allowed because the same behaviour previously produced on-chain corruption.

## Tips

- Click a field in the editor's autocomplete dropdown rather than typing `@` references by hand. Hand-authored references are the main source of typos this validator catches.
- If you see `INVALID_TEMPLATE_SYNTAX` on save, check the `invalidTemplates` field in the response: each entry tells you the exact token and the reason it failed to parse.
- If you see `Unresolved template reference` at runtime, the upstream node either has not run yet (check the workflow topology), produced no data (check the upstream node's run output), or you typed the field path wrong (check the autocomplete suggestions).
