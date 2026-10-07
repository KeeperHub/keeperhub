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

## Workflow Row

Each workflow in the picker is a 32px row (`py-1.5`, `text-sm`) in three
fixed columns, so the name gets the same room on every row:

| Column | Content |
|---|---|
| Icon (20px tile) | Trigger-type icon from `components/workflow-trigger-icons.ts`. Green (`keeperhub-green` on a 10% tint) only when the workflow is enabled and fires on its own; grey with a `foreground/15` outline when disabled, and always for Manual. Tooltip leads with the status in words: "Disabled · Schedule trigger · Every 5 minutes"; Manual says "Manual trigger · Runs when you click Run Workflow". |
| Name (flexible) | Truncated; the full name shows above it on hover. Dimmed when disabled. |
| Label (64px, right-aligned, `text-xs`) | Always "how or when it fires": cadence ("5 min", "Hourly", "Daily", "Weekdays", "Custom"), event name, or "10 blocks"; empty for Webhook, Transfer and Manual, whose icon says it all. `foreground/75`, muted like the name when the workflow is off. The one status word is "Deactivated", in `text-status-deactivated` with a tooltip saying KeeperHub turned it off. Status otherwise comes from the icon colour and the dimmed name (and the tooltip and screen-reader text). Truncated with a tooltip. |

On the open workflow's row (`bg-muted`) dimmed text and grey icons step up
to `foreground/55`. Tooltips open after 400ms. Status and trigger detail are
read to screen readers from a hidden span; the visible label is
`aria-hidden`.

## Project Panel Filter

The filter button (left of the project title) opens a strip pinned to the
top of the list: multi-select chips All / Enabled / Disabled / Manual with
counts (selected: outline and check; zero: 70% opacity) and, when the list is
taller than the panel, a shared `SearchInput` over name, tag, trigger type
("Manual" when there is none) and event name; status words are left to the
chips. The Disabled chip notes how many of its workflows were deactivated
by KeeperHub (tooltip, plus hidden text for screen readers). Dimmed text and
grey icons step up on hover as on the open row. On keyboard focus, after the
same 400ms, a row's icon tooltip opens only when it has something the row
cannot show: a cut-off name in full, or why it is deactivated. Escape or
moving the mouse closes it. While a filter is on, tag groups are held
open and their headers do not fold. An empty result names the filters and offers "Show all workflows".
Escape clears a typed search, then closes the filter, then the panel; an
Escape that closes a dialog, menu or select inside the panel closes only that.

## Code Example

```tsx
// Used in layout.tsx -- no direct instantiation needed
<NavigationSidebar />
```

## Cross-references

- [Flyout Panel](./flyout-panel.md) -- nested inside sidebar
- [Organization Switcher](./org-switcher.md) -- rendered at top of sidebar
