# Workflow Node

## Metadata

| Field | Value |
|---|---|
| Name | TriggerNode / ActionNode / AddNode |
| Category | Workflow |
| Status | Active |
| Files | `components/workflow/nodes/trigger-node.tsx`, `action-node.tsx`, `add-node.tsx` |

## Overview

Visual nodes on the React Flow workflow canvas. Three types exist:
- **TriggerNode** -- the starting point of a workflow (manual, schedule, webhook, event)
- **ActionNode** -- an action step in the workflow (plugin actions, conditions, HTTP)
- **AddNode** -- placeholder node prompting user to add their first step

**When to use**: Inside the WorkflowCanvas React Flow instance.

**When not to use**: Outside of the workflow editor. These are React Flow custom nodes.

## Anatomy

### TriggerNode / ActionNode

1. **Node Container** -- rounded card with border, status indicator
2. **Integration Icon** -- plugin icon (left side)
3. **Node Label** -- action name / step description
4. **Status Badge** -- execution status (idle, running, success, error)
5. **Source Handle** -- right-side connection point
6. **Target Handle** -- left-side connection point (ActionNode only)

### AddNode

1. **Prompt Text** -- "Add your first step"
2. **Action Buttons** -- "Browse Actions" and "Browse Templates"
3. **Onboarding Checklist** -- getting started checklist (for new users)

## Tokens Used

| Token | Usage |
|---|---|
| `--card` | Node background |
| `--card-foreground` | Node text |
| `--border` | Node border, handle border |
| `--primary` | Handle fill color |
| `--muted-foreground` | Secondary text |
| `--destructive` | Error status border |
| `--keeperhub-green` | Success status indicator |
| `--ring` | Focus/selection ring |
| `z-20` | Handle z-index (should use `--z-controls`) |

### React Flow Handle Styling (globals.css)

| Property | Value | Notes |
|---|---|---|
| Width/Height | `12px` | Hardcoded in CSS with `!important` |
| Border | `2px solid var(--border)` | Uses token (correct) |
| Background | `var(--primary)` | Uses token (correct) |
| Mobile hit area | `44px` | Touch target expansion |

## Props/API

```typescript
// React Flow NodeProps
interface TriggerNodeData {
  type: 'manual' | 'schedule' | 'webhook' | 'event';
  config: TriggerConfig;
}

interface ActionNodeData {
  integrationId: string;
  actionId: string;
  label: string;
  config: Record<string, unknown>;
  status?: 'idle' | 'running' | 'success' | 'error' | 'cancelled';
}
```

## States

| State | Appearance |
|---|---|
| Default | Card with muted border, idle status |
| Selected | Ring highlight, config panel opens |
| Hover | Cursor pointer |
| Dragging | Cursor grabbing, slight elevation |
| Running | Blue/pulsing border indicator |
| Success | Green border/badge |
| Error | Red/destructive border, error icon |
| Cancelled | Gray border, cancelled badge |

## Code Example

```tsx
// Registered as custom React Flow node types
const nodeTypes = {
  trigger: TriggerNode,
  action: ActionNode,
  add: AddNode,
};

<ReactFlow nodeTypes={nodeTypes} nodes={nodes} edges={edges} />
```

## Cross-references

- [Action Grid](./action-grid.md) -- selects action type for new nodes
- [Node Config Panel](./node-config-panel.md) -- configures selected node
- [Workflow Runs](./workflow-runs.md) -- shows execution results per node
