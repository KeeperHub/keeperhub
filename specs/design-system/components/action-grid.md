# Action Grid

## Metadata

| Field | Value |
|---|---|
| Name | ActionGrid |
| Category | Workflow |
| Status | Active |
| File | `keeperhub/components/workflow/config/action-grid.tsx` |

## Overview

Searchable grid of available workflow actions (plugin steps). Displayed when adding a new node to the workflow canvas. Groups actions by integration category with collapsible sections.

**When to use**: When user clicks "Add Step" or the add-node placeholder on the workflow canvas.

**When not to use**: Not used outside the workflow editor context.

## Anatomy

1. **Search Input** -- filters actions by name
2. **View Toggle** -- grid vs list layout switch
3. **Category Sections** -- collapsible groups (Web3, Notifications, System, etc.)
4. **Action Cards** -- individual action items with icon, name, description
5. **Integration Icon** -- plugin icon for each action

## Tokens Used

| Token | Usage |
|---|---|
| `--background` | Grid background |
| `--border` | Section dividers |
| `--muted` | Category header background |
| `--muted-foreground` | Description text |
| `--foreground` | Action name text |
| `--accent` | Hover state background |
| `--primary` | Selected/active action |
| `text-sm` | Action name size |
| `text-xs` | Description size |

## Props/API

```typescript
interface ActionGridProps {
  onSelectAction: (action: IntegrationAction) => void;
  currentNodeType?: string;
}
```

## States

| State | Appearance |
|---|---|
| Default | All categories shown, first collapsed by default |
| Search active | Only matching actions visible, categories auto-expanded |
| Hover (action) | `accent` background |
| Empty search | "No actions found" message |
| Loading | Skeleton cards |

## Code Example

```tsx
<ActionGrid
  onSelectAction={(action) => addNodeToCanvas(action)}
/>
```

## Cross-references

- [Workflow Canvas](./workflow-canvas.md) -- parent context
- [Node Config Panel](./node-config-panel.md) -- shown after action selection
