# Flyout Panel

## Metadata

| Field | Value |
|---|---|
| Name | FlyoutPanel |
| Category | Navigation |
| Status | Active |
| File | `keeperhub/components/flyout-panel.tsx` |

## Overview

Expandable side panel that slides out from the navigation sidebar. Used for project lists, tag management, and workflow filtering.

**When to use**: As a sub-navigation panel within the sidebar.

**When not to use**: For modal-like overlays or full-page panels.

## Anatomy

1. **Strip** -- narrow collapsed state (32px) showing section icon
2. **Expanded Panel** -- full-width panel (280px) with content
3. **Header** -- section title and collapse button
4. **Content Area** -- scrollable list of items (projects, tags, etc.)

## Tokens Used

| Token | Should Use | Currently Uses |
|---|---|---|
| `--flyout-width` | Panel width | `280` (JS constant, should reference token) |
| `--sidebar-strip-width` | Strip width | `32` (JS constant, should reference token) |
| `--z-flyout` | Z-index layer | `z-30` (correct value, should use token) |
| `--header-height` | Top offset | `top-[60px]` (should use `top-[var(--header-height)]`) |
| `--shadow-lg` | Panel shadow | `shadow-lg` (correct) |
| `--background` | Panel background | `bg-background` (correct) |
| `--border` | Panel border | `border-border` (correct) |

## Props/API

```typescript
interface FlyoutPanelProps {
  title: string;
  icon: ReactNode;
  children: ReactNode;
  isOpen: boolean;
  onToggle: () => void;
}
```

## States

| State | Appearance |
|---|---|
| Collapsed | 32px strip with icon only |
| Expanded | 280px panel with full content, shadow-lg |
| Animating | flyout-in keyframe (translateX -6px to 0) |

## Code Example

```tsx
<FlyoutPanel
  title="Projects"
  icon={<FolderIcon />}
  isOpen={isProjectsPanelOpen}
  onToggle={() => toggleProjectsPanel()}
>
  <ProjectList />
</FlyoutPanel>
```

## Cross-references

- [Navigation Sidebar](./navigation-sidebar.md) -- parent container
- [Project Drawer](./project-drawer.md) -- similar pattern in analytics
