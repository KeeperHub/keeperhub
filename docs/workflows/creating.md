---
title: "Creating Workflows"
description: "Step-by-step guide to building workflows with the visual node-based editor."
---

# Creating Workflows

There are several ways to create a KeeperHub workflow. The visual builder in the browser is the most direct path; for AI agents and terminal-driven workflows, you can also create them programmatically:

- [**Visual builder**](/workflows/creating) (this guide): design workflows on a node canvas in the KeeperHub web app.
- [**MCP server**](/agent/mcp-server): AI agents call `create_workflow` over the Model Context Protocol to build workflows from natural language.
- [**Claude Code plugin**](/agent/claude-code-plugin): bundles the MCP server plus skills so you can ask Claude Code to "create a workflow that..." inside the terminal.
- [**`kh` CLI**](/cli): scriptable workflow management for CI and headless environments.

The rest of this page covers the visual builder.

## Getting Started

1. Click **New Workflow** at the top of the left sidebar
2. Give the workflow a name and description in the **Properties** panel on the right (the panel has Properties, Code, and Runs tabs)
3. The visual canvas opens with zoom controls and the AI assistant

## The Workflow Canvas

### Navigation

- **Zoom**: Use the +/- buttons in the bottom-left, or scroll to zoom
- **Pan**: Click and drag on empty canvas space to move around
- **Fit**: Click the fit button to center all nodes in view

### Top Toolbar

| Button | Function |
|--------|----------|
| + | Add a new node |
| Undo/Redo | Undo or redo recent changes |
| Save | Save current workflow state |
| Download | Export the workflow as JSON. See [Import/Export](/workflows/import-export). |
| Lock | Lock workflow to prevent edits |
| Run | Execute the workflow manually |

## Adding Nodes

Add nodes to your workflow using any of these methods:

### Method 1: Toolbar Button
Click the **+** button in the top toolbar to open the node picker.

### Method 2: Context Menu
Right-click anywhere on the canvas to open a context menu with node options.

### Method 3: Edge Dragging
Drag from an existing node's output connector (the dot on the right side) to create a new connected node.

## Connecting Nodes

Nodes have connector points:
- **Input** (left side): Receives data from previous nodes
- **Output** (right side): Sends data to subsequent nodes

To connect nodes:
1. Click and hold on a node's output connector
2. Drag to another node's input connector
3. Release to create the connection

Connections show the data flow direction with a curved line between nodes.

## Configuring Nodes

Click any node to open the configuration panel on the right side of the screen.

### Common Configuration Fields

| Field | Description |
|-------|-------------|
| Service | The type of service (Web3, Email, Discord, etc.) |
| Connection | Your configured connection for this service |
| Network | Blockchain network (for Web3 nodes) |
| Address | Wallet or contract address (for Web3 nodes) |
| Label | Display name for this node |
| Description | Optional notes |
| Enabled | Toggle to activate/deactivate this node |

### Trigger Configuration

For trigger nodes, you'll also configure specific settings based on the trigger type. When creating workflows programmatically via the API, use the exact `triggerType` and config keys shown below:

| Trigger Label | `triggerType` value | Required config keys | Optional config keys |
|---------------|---------------------|----------------------|----------------------|
| Manual   | `"Manual"`   | (none) | (none) |
| Schedule | `"Schedule"` | `scheduleCron` | `scheduleTimezone` |
| Webhook  | `"Webhook"`  | (none) | `webhookSchema`, `webhookMockRequest` |
| Event    | `"Event"`    | `network`, `contractAddress`, `contractABI`, `eventName` | (none) |
| Block    | `"Block"`    | `network`, `blockInterval` | (none) |

> **Note for API users:** The `triggerType` must match the Pascal-case string exactly (e.g., `"Schedule"`, not `"cron"`). The canonical list, including any future additions, is returned under the `triggers` map of [`GET /api/mcp/schemas`](/api/workflows#list-action-schemas).

### Condition Configuration

Condition nodes evaluate expressions and branch the workflow into **true** and **false** paths. Use the **Visual** builder for point-and-click rule creation, or switch to **Expression** mode to write raw JavaScript expressions.

#### Visual Builder

Each rule has a left operand, an operator, and (for binary operators) a right operand. Operands accept literal values or template references like `{{@nodeId:Label.field}}`.

Combine multiple rules with **AND** / **OR** logic toggles, and nest groups for complex conditions.

#### Operators

| Operator | Label | Type | Description |
| -------- | ----- | ---- | ----------- |
| `==` | soft equals | Comparison | Loose equality (type coercion) |
| `===` | equals | Comparison | Same value; plain decimals by magnitude ("1.0" equals 1) |
| `!=` | soft not equals | Comparison | Loose inequality |
| `!==` | not equals | Comparison | Different value; plain decimals by magnitude ("1.0" equals 1) |
| `>` | greater than | Comparison | Greater than; plain decimals by magnitude |
| `>=` | greater than or equal | Comparison | Greater than or equal; plain decimals by magnitude |
| `<` | less than | Comparison | Less than; plain decimals by magnitude |
| `<=` | less than or equal | Comparison | Less than or equal; plain decimals by magnitude |
| `contains` | contains | String | Left operand contains right operand |
| `startsWith` | starts with | String | Left operand starts with right operand |
| `endsWith` | ends with | String | Left operand ends with right operand |
| `matchesRegex` | matches regex | Pattern | Left operand matches the regex pattern in the right operand. The pattern must be a quoted string, not a reference. Both operands are coerced with `String()`, as they are for `contains` and `startsWith`, so a null operand matches the pattern `^null$` rather than failing |
| `isEmpty` | is empty | Existence | Value is null, undefined, or empty string |
| `isNotEmpty` | is not empty | Existence | Value is not null, undefined, or empty string |
| `exists` | exists | Existence | Value is not null and not undefined |
| `doesNotExist` | does not exist | Existence | Value is null or undefined |
| `isNull` | is null | Existence | Value is strictly null (undefined does not match) |
| `isNotNull` | is not null | Existence | Value is anything except null (undefined still matches) |
| `isUndefined` | is undefined | Existence | Value is strictly undefined (null does not match) |
| `isNotUndefined` | is not undefined | Existence | Value is anything except undefined (null still matches) |

**`matchesRegex` patterns:** the pattern is a quoted string literal rather than a field reference, so it can be checked before the run instead of when it arrives. Two shapes are refused, because conditions are evaluated with no timeout and either can backtrack without bound: a quantifier applied to a group that contains a quantifier or an alternation (`(a+)+$`), and two quantifiers in a row over the same characters (`a+a+`, `\w+\d+`). `^0x[0-9a-fA-F]{40}$` is accepted, and so is `[a-z]+[0-9]+`, whose two atoms cannot match the same character. Patterns are capped at 512 characters and the matched value at 4096, and both caps throw rather than returning false: a value over the cap fails the step, so a long revert payload or stack trace hard-fails the workflow instead of matching nothing. The operator takes exactly two arguments, so a third (`matchesRegex(value, "a", "i")`) is refused rather than having its flag silently ignored, and so is a call with only one, which used to read the missing pattern as the text `undefined`. A pattern is also bounded in shape: more than eight levels of nested groups, or more than sixteen groups in total, is refused, because the checker that decides all of this walks that nesting itself. Only a quantifier that can repeat in more than one way counts for the first rule, so `^\d+(\.\d+)?$` and `^(0x)?[0-9a-fA-F]{40}$` are accepted.

**What counts as a number:** an operand is compared by magnitude only when it is a
plain decimal - an optional sign, digits, and at most one point, such as `42`, `-0.50` or
`1000000000000000000`. A JavaScript number is read through the shortest decimal that prints it
back, so one large or small enough to print in exponent form is not one. Hex and exponent form are
outside the grammar, and the visual builder agrees: it quotes such a value rather than emitting a
bare number. Whitespace is outside the grammar too, but the builder trims what you type before it
decides, so `  42  ` still emits a bare `42`. An operand that keeps its spaces reaches a comparison
through template resolution or a hand-written expression, not through the builder.

**Outside that grammar the comparison is JavaScript's own, which is not numeric.** Two strings are
then ordered character by character. For text meant to be read that way - a word, an ISO date -
that is the answer you want. For a number written in a form the grammar does not cover it is an
answer about spelling, which can disagree with magnitude, and it still runs a branch. A pair of
different types usually produces no answer at all: `<`, `===` and `>` are false at once, so a
Condition branching on all three takes no branch.

```
"0x10" vs "16"                        <  true    ===  false    >  false
"1e18" vs "1000000000000000000"       <  false   ===  false    >  true
"0x10" vs 16                          <  false   ===  false    >  false
1e21   vs "1000000000000000000000"    <  false   ===  false    >  false
" 1"   vs 1                           <  false   ===  false    >  false
""     vs 0                           <  false   ===  false    >  false
```

`"0x10" < "16"` is true because `"0"` sorts before `"1"`, and `"1e18" > "1000000000000000000"` is
true because `"e"` sorts after `"0"`. Write the value as a plain decimal and both go away.

The last row is the one to watch, because a template that resolves to blank produces it without
anyone writing an odd literal. `""` is not a decimal, so the pair falls to JavaScript, which reads
a blank string as `0`: against `0` that is the all-false case, and against any other number the
comparison answers as though the field held zero. Guard the field with `isNotEmpty` in an earlier
clause rather than letting the comparison decide - `exists` will not catch it, since a blank string
is neither null nor undefined.

**A digit field is read as a quantity, not as a spelling.** `===` and `!==` ask the same question
the ordering operators ask, so two spellings of one number are one value: `007` equals `7`, `1.50`
equals `1.5`, `+5` equals `5`. For a quantity that is the answer you want, and it is what stops a
formatter's `1.0` against an author's `1` leaving `<`, `===` and `>` false at once. For an
identifier that happens to be digits - a zero-padded order number, an invoice reference, a token id
- it is not: two references that spell the same number compare equal, and no comparison operator
reads the spelling. Nor did one before: the builder emits a value that looks like a number bare, so
a rule reading `id === 00123` never matched a stored `"00123"` either, whatever the id was. If a
rule has to tell `007` from `7`, keep the field in a form the grammar does not read as a number - a
prefix is enough - since the string operators read text but none of them is an exact match.

**When to use `doesNotExist` vs `isNull` / `isUndefined`:** `exists` and `doesNotExist` treat null and undefined the same, which is the right choice for most checks (for example, a node output field that may or may not be present). Reach for `isNull`, `isNotNull`, `isUndefined`, or `isNotUndefined` only when you need to tell null and undefined apart, since these match one but not the other.

**Referencing a field that may be absent:** the existence operators are also the only ones that accept a field path that is not present on the upstream output at all. Every other operator fails the run when the path is missing, so that a mistyped reference is caught rather than quietly satisfying a comparison. Put an existence operator in the first clause of an AND group to guard the clauses after it. See [Runtime resolution](/workflows/templating#runtime-resolution) in the templating reference for the full rules.

**When to use soft vs strict equality:** `===` does not mean type-strict. Two plain decimals compare by magnitude under both operators, so `"1.0"`, `"1"` and `1` are one value either way, and a string `"0"` against a number `0` matches under both. They part company only where one side is not a number: `"0"` against `false` matches under `==` and does not under `===`. Most blockchain data arrives as strings, so soft equality is the default for new conditions.

#### Expression Mode

Expression mode allows you to write raw JavaScript condition expressions for advanced logic. In addition to the comparison and logical operators in the Visual Builder, you can use arithmetic operators for calculations:

| Operator | Description |
| -------- | ----------- |
| `+` | Addition |
| `-` | Subtraction |
| `*` | Multiplication |
| `/` | Division |
| `%` | Modulo (remainder) |
| `**` | Exponentiation (power) |

**Example expressions:**

- `{{@CheckBalance:Balance.value}} * 2 > 100` - Check if double the balance exceeds 100
- `{{@GetPrice:Price.usd}} ** 2 >= 10000` - Check if price squared is at least 10,000
- `({{@GetAmount:Amount.wei}} / 1000000000000000000) >= 0.5` - Convert wei to ETH and check threshold
- `{{@GetRewards:Rewards.amount}} % 10 === 0` - Check if rewards are divisible by 10

Expression mode also supports JavaScript methods, array indexing, and property access for complex logic.

#### Dual Output Paths

Condition nodes have two output handles:

- **true**: downstream nodes connected here execute when the condition passes (API `sourceHandle: "true"`)
- **false**: downstream nodes connected here execute when the condition fails (API `sourceHandle: "false"`)

Connect different branches to each handle to create if/else logic in a single node.

### Programmatic Edge Creation (sourceHandle)

When creating edges via the API that originate from branching nodes, you **must** specify the `sourceHandle` to indicate which path the edge follows:

| Node type | `sourceHandle` values | When to use |
|-----------|---------------------|-------------|
| **Condition** | `"true"`, `"false"` | Required on all outgoing edges |
| **For Each** | `"loop"`, `"done"` | Required on all outgoing edges |
| All others | (none) | Omit entirely |

The visual canvas additionally enforces two For Each connection conventions: the `"done"` handle is intended to terminate at a **Collect** node that aggregates iteration results, and the `"loop"` handle is intended to enter the loop body (not a Collect node). The API does not currently reject edges that violate these conventions, but workflows that follow them produce predictable executor behavior.

## Template Syntax Reference

KeeperHub uses a powerful template syntax to reference outputs from upstream nodes dynamically. The pattern is `{{@nodeId:Label.field}}`.

**Features:**
- **Dot notation** for nested fields: `{{@http-1:Fetch Data.data.price}}`
- **Array indexing**: `{{@query-1:Get Users.items[0].id}}`
- **Built-in variables**: Access system state with `{{@__system:System.unixTimestamp}}`, `{{@__system:System.unixTimestampMs}}`, or `{{@__system:System.isoTimestamp}}`

**Example usage in a Condition node:**
To check if a balance from a previous "Check Balance" node (ID: `check-balance`) is greater than 1000:
`{{@check-balance:Check Balance.balance}} > 1000`

## Managing Connections

Before using certain node types, set up connections:

1. Open Settings from the user menu
2. Under Organization, select **Connections**
3. Add connections for services you need:
   - Web3 wallets
   - Email providers
   - Discord webhooks
   - Slack (bot token)
   - Telegram (bot token)

## Enabling and Running

### Enable Individual Nodes
Each node has an **Enabled** toggle in its configuration panel. Disabled nodes are skipped during execution.

### Test Your Workflow
Click the green **Run** button to execute the workflow immediately. This is useful for testing before enabling scheduled execution.

### Delete Nodes
Click **Delete** in the node configuration panel to remove a node and its connections.

## Saving Workflows

- Workflows automatically save when you make changes
- Use the **Save** button to force-save current state
- Invalid configurations prevent saving until fixed
- The **Download** button exports the workflow as JSON, which you can re-upload from the workflows list to clone or share. See [Import/Export](/workflows/import-export) for the format and use cases.

## Using AI to Create Workflows

The **Ask AI...** input at the bottom of the canvas lets you describe your automation in natural language:

1. Click the input field or use the keyboard shortcut
2. Describe what you want to automate
3. The AI will suggest nodes and configurations
4. Review and adjust the generated workflow

### Example Prompts

- "Alert me on Discord when my wallet balance drops below 0.1 ETH"
- "Every hour, check if a contract's totalSupply changed and email me"
- "When someone sends ETH to my wallet, log it to Slack"

## Importing from the Hub

If you'd rather start from a community template than build from scratch, see the [Hub](/workflows/hub).

## Workflow States

| State | Description |
|-------|-------------|
| Draft | Workflow is being edited, not running |
| Active | Workflow is enabled and will execute on triggers |
| Paused | Workflow exists but all triggers are disabled |

## Best Practices

1. **Test on Sepolia first**: Use the testnet before deploying to Mainnet
2. **Name your nodes clearly**: Use descriptive labels for easy understanding
3. **Start simple**: Begin with one trigger and one action, then add complexity
4. **Check your connections**: Ensure all required connections are configured before enabling
5. **Review the Run output**: Check execution logs after running to verify behavior
