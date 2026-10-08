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

The filter button (left of the project title) opens a row pinned to the top
of the list with two dropdown filters and no search:

- **Status**: Enabled, Disabled, Manual. Disabled notes "Incl. N deactivated"
  in the deactivated amber when KeeperHub turned any of its workflows off.
- **Trigger**: every trigger type, each with the row's icon tile, always
  grey (green would read as a status). Pyth Price is listed only when a
  workflow in the project uses it or it is picked.

Each menu is a list of checkboxes with counts (`foreground/70`; an entry
that would empty the list dims its name, not its zero); it stays open while
you pick, and ends with "Clear ... filter". Within a menu picks add up
(Event or Block), and every entry can be ticked at once; across the two they
narrow (Enabled and Event); each menu counts the workflows the other lets
through. The button reads "Status All" until something is picked, then the
first pick (with its icon) and "+N". A clear button after the two menus
clears both.

Only one menu is open at a time. Menus open on click, Enter or arrow keys,
and also on hover after 250ms; while one is open, resting on the other
button switches to it. One opened by hover leaves focus where it was, gives
it back there when it closes, and closes 300ms after the pointer leaves
button and menu; clicking its button or pressing the down arrow keeps it
open and moves into it. Both menus stay inside the panel (it is their
collision boundary).

While any filter is on, the row stays in view and the filter button shows a
dot; clicking it then clears the filters and hides the row in one go
(tooltip "Clear filters and hide"). Tag groups are held open and their
headers turn into plain text. An empty result names the filters and offers
"Show all workflows".

Dimmed text and grey icons step up on hover as on the open row. On keyboard
focus, after the same 400ms, a row's icon tooltip opens only when it has
something the row cannot show: a cut-off name in full, or why and when it
was deactivated ("Turned off by KeeperHub on Oct 6, 2026. Contact support to
turn it back on."). Escape or moving the mouse closes it.

Escape inside a menu, or on a hover-opened one, closes only the menu. On a
menu button with its menu shut it hides an unused row, but never clears
picks (a habitual second Escape would otherwise throw them away); with
nothing open it closes the panel. An Escape that closes a dialog, menu or
select inside the panel closes only that.

## Code Example

```tsx
// Used in layout.tsx -- no direct instantiation needed
<NavigationSidebar />
```

## Cross-references

- [Flyout Panel](./flyout-panel.md) -- nested inside sidebar
- [Organization Switcher](./org-switcher.md) -- rendered at top of sidebar
