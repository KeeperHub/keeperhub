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
| `===` | equals | Comparison | Strict equality (no type coercion) |
| `!=` | soft not equals | Comparison | Loose inequality |
| `!==` | not equals | Comparison | Strict inequality |
| `>` | greater than | Comparison | Numeric greater than |
| `>=` | greater than or equal | Comparison | Numeric greater than or equal |
| `<` | less than | Comparison | Numeric less than |
| `<=` | less than or equal | Comparison | Numeric less than or equal |
| `contains` | contains | String | Left operand contains right operand |
| `startsWith` | starts with | String | Left operand starts with right operand |
| `endsWith` | ends with | String | Left operand ends with right operand |
| `matchesRegex` | matches regex | Pattern | Left operand matches regex pattern in right operand |
| `isEmpty` | is empty | Existence | Value is null, undefined, or empty string |
| `isNotEmpty` | is not empty | Existence | Value is not null, undefined, or empty string |
| `exists` | exists | Existence | Value is not null and not undefined |
| `doesNotExist` | does not exist | Existence | Value is null or undefined |
| `isNull` | is null | Existence | Value is strictly null (undefined does not match) |
| `isNotNull` | is not null | Existence | Value is anything except null (undefined still matches) |
| `isUndefined` | is undefined | Existence | Value is strictly undefined (null does not match) |
| `isNotUndefined` | is not undefined | Existence | Value is anything except undefined (null still matches) |

**When to use `doesNotExist` vs `isNull` / `isUndefined`:** `exists` and `doesNotExist` treat null and undefined the same, which is the right choice for most checks (for example, a node output field that may or may not be present). Reach for `isNull`, `isNotNull`, `isUndefined`, or `isNotUndefined` only when you need to tell null and undefined apart, since these match one but not the other.

**When to use soft vs strict equality:** Use `==` (soft equals) when comparing values that may differ in type, such as a string `"0"` against a number `0`. Use `===` (equals) when you need exact type matching. Most blockchain data arrives as strings, so soft equality is the default for new conditions.

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

Before using certain node types, set up connections in your account:

1. Click your profile icon in the top-right
2. Select **Connections**
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
