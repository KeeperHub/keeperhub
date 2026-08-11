# Navigation Sidebar

## Metadata

| Field | Value |
|---|---|
| Name | NavigationSidebar |
| Category | Navigation |
| Status | Active |
| File | `keeperhub/components/navigation-sidebar.tsx` |

## Overview

Primary left-side navigation for the application. Contains org switcher, workflow list, project/tag filters, and a collapsible flyout panel.

**When to use**: Always present on authenticated pages. Renders as full sidebar on desktop, sheet overlay on mobile.

**When not to use**: Unauthenticated/landing pages, onboarding flows.

## Anatomy

1. **Org Switcher** -- top section, switches active organization
2. **Navigation Links** -- main nav items (Workflows, Analytics, Hub, Settings)
3. **Workflow List** -- scrollable list of user's workflows
4. **Project/Tag Filters** -- collapsible filter sections
5. **User Menu** -- bottom section with user avatar and settings
6. **Mobile Overlay** -- sheet variant for small screens

## Tokens Used

| Token | Usage |
|---|---|
| `--sidebar` | Background color |
| `--sidebar-foreground` | Text color |
| `--sidebar-primary` | Active item text |
| `--sidebar-accent` | Hover background |
| `--sidebar-border` | Divider borders |
| `--sidebar-ring` | Focus indicator |
| `z-40` | Overlay z-index (should use `--z-sidebar`) |
| `top-[60px]` | Header offset (should use `--header-height`) |

## Props/API

Rendered as part of the app layout. No external props -- reads state from:
- Organization context (active org)
- Router (active route for highlighting)
- Workflow list query

## States

| State | Appearance |
|---|---|
| Default | Full sidebar visible, nav links with muted text |
| Active link | `sidebar-primary` text color, `sidebar-accent` background |
| Hover | `sidebar-accent` background |
| Mobile | Hidden by default, slides in as sheet overlay |
| Collapsed | Strip-width (32px) showing only icons |

## Code Example

```tsx
// Used in layout.tsx -- no direct instantiation needed
<NavigationSidebar />
```

## Cross-references

- [Flyout Panel](./flyout-panel.md) -- nested inside sidebar
- [Organization Switcher](./org-switcher.md) -- rendered at top of sidebar
