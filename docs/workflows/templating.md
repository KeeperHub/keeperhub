---
title: "Templating reference"
description: "Canonical grammar for the `{{...}}` template tokens you can use to wire upstream node outputs into a downstream node's config."
---

# Templating reference

KeeperHub workflows wire data between nodes using `{{...}}` template tokens. A template token is any string of the form `{{ ... }}` that appears inside a node's config field. When the workflow runs, the executor replaces each token with the corresponding upstream value.

This page is the canonical reference. If a token does not match one of the grammars listed below, the executor will refuse to run the action and surface an error pointing at the offending reference. If a token does match the grammar but the field it names is not present on the upstream output, the executor aborts the action with a structured error. See [Runtime resolution](#runtime-resolution) for how a field that is present but empty is treated, and for the one case in a Condition where a missing field is allowed.

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
| `{{@n1:Label.does.not.exist}}` | Field path is not present on the upstream output. In a Condition, the existence operators accept this; see [Runtime resolution](#runtime-resolution) |

When a runtime resolution fails, the action aborts with a structured error listing every unresolved reference. Earlier behaviour silently substituted an empty string or left the literal `{{...}}` token in the rendered value, which caused real on-chain corruption when the corrupted value flowed into a write action. The strict mode is the default.

## Where templates can appear

Templates work in any string-valued config field. Common places:

- Action input fields (URLs, addresses, message bodies)
- Conditions (Condition node expressions)
- Database Query parameters (parameterized as `$1`, `$2`, ... at execution time)
- Run Code source (string-valued upstream data is JSON-stringified into the code so it remains valid JavaScript when inlined)

Templates do **not** work inside binary fields (images, file uploads) or inside the workflow's structural metadata (node ids, edge ids, position).

## Referencing a field the editor has not seen yet

The `@` autocomplete lists the fields it can see on a node's recorded output, taking the current run first and the node's last run otherwise. A node that has not run yet has no recorded output, so it offers no fields.

When you already know a field will be there, you can write the path yourself. Double-click a reference chip in any config field and it becomes editable text with the cursor inside the closing braces. Type the rest of the path, then click away and it renders as a chip again.

Extend the path inside the braces rather than after them. `{{@n1:My Step.data}}.timestamp` resolves `data` to the whole object and leaves `.timestamp` as literal text after it; `{{@n1:My Step.data.timestamp}}` is the reference you want.

Saving does not check that the path exists, only that the token parses. The path is resolved when the workflow runs, so a field that is genuinely there when the node executes works even though the editor could not suggest it. A path that is still not there at run time is handled as described below.

## Runtime resolution

A reference that matches the grammar is resolved against the upstream node's recorded output when the workflow runs. Empty-string substitution and literal `{{...}}` pass-through are not allowed, because a corrupted value that reaches a write action is expensive to undo.

### A present but empty field resolves

A field that exists and holds `null` or `undefined` is a real value, not a missing one. It resolves:

| Where the reference appears | A present field holding `null` resolves to |
|-----------------------------|--------------------------------------------|
| Action config field | the empty string |
| Run Code source | the `null` literal, so the inlined code stays valid JavaScript |
| Condition | `null`, which `is null` and `does not exist` match |

This matters for optional output: a node that returns a key whose value is empty is treated as having answered, and the run continues.

### A field that is absent aborts the action

A field that is not present on the output is a different case. The action aborts with a structured error naming every unresolved reference and listing the field names that are available, so a mistyped path is caught before it can write an empty value on-chain.

### Conditions and the existence operators

Conditions follow the same rule, with one addition.

Every reference in a Condition is resolved before the expression is evaluated, so an expression cannot short-circuit its own way past a field that is not there. The existence operators are what make that possible. `is undefined`, `is not undefined`, `exists`, `does not exist`, `is empty` and `is not empty` accept a field that is absent and read it as undefined. Every other operator rejects it and the run fails.

Given an upstream output of `{ "someObject": { "nested": { "d": 0 } } }`:

| Condition | Result |
|-----------|--------|
| `someObject.nonExisting` **is not undefined** | `false` |
| `someObject.nonExisting` **is undefined** | `true` |
| `someObject.nonExisting` **is not undefined** AND `someObject.nonExisting` **equals** `5` | `false` |
| `someObject.nonExisting` **equals** `5` | the run fails |

To reference a field that may not be present, put an existence operator in the first clause of an AND group. The group evaluates to `false` while the field is absent, and the clauses after it are evaluated once it is there.

A comparison against an absent field with no such guard fails the run and names the operators that handle it:

```
Condition references field "someObject.nonExisting": "nonExisting" does not exist
on the data. Available fields: nested. Use the "is undefined" or "is not
undefined" operator to test whether the field is present.
```

That is deliberate. A mistyped path in a bare comparison would otherwise satisfy the comparison quietly and send the run down a branch you did not intend.

Whenever a Condition reads an absent path, the path and the field names that were available are recorded as `unresolvedFields` on the step's input in the run detail. That holds even when the branch evaluated normally, so a guarded reference that is quietly empty is still visible.

### Nodes that produced no output

A reference to a node that produced no output at all fails the run, because the reference itself is broken rather than the value being empty.

A node that ran and returned `null` behaves like an absent field: an action aborts, and in a Condition the existence operators can test it.

## Tips

- Click a field in the editor's autocomplete dropdown rather than typing `@` references by hand. Hand-authored references are the main source of typos this validator catches. When the field you need is not offered yet, double-click the chip and extend its path inside the braces.
- Guard a field that may not be present with an existence operator in the first clause of an AND group, rather than comparing it directly.
- If you see `INVALID_TEMPLATE_SYNTAX` on save, check the `invalidTemplates` field in the response: each entry tells you the exact token and the reason it failed to parse.
- If you see `Unresolved template reference` at runtime, the upstream node either has not run yet (check the workflow topology), produced no data (check the upstream node's run output), or you typed the field path wrong (check the autocomplete suggestions).
