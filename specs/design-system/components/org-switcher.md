# Organization Switcher

## Metadata

| Field | Value |
|---|---|
| Name | OrgSwitcher |
| Category | Navigation |
| Status | Active |
| File | `keeperhub/components/organization/org-switcher.tsx` |

## Overview

Dropdown control for switching between organizations. Shows the current org and allows selecting a different one, or opening its settings. With no organization it offers to create one.

**When to use**: In the header (the workflow toolbar), and in the phone navigation drawer below 375px.

**When not to use**: In settings pages (use full org management UI instead).

## Anatomy

1. **Trigger Button** -- displays current org name with chevron, combobox role
2. **Dropdown Menu** -- popover with org list
3. **Org Item** -- individual org with a check for the current one, its name and a settings gear (shown on hover; hidden on touch screens except for the current org)

## Tokens Used

| Token | Usage |
|---|---|
| `--popover` | Dropdown background |
| `--popover-foreground` | Dropdown text |
| `--border` | Dropdown border |
| `--accent` | Hover state on items |
| `--accent-foreground` | Hover text |
| `--muted-foreground` | Secondary text |
| `sm:w-50` | 200px from sm; full width in the phone menu, initials only below sm |

## Props/API

Reads from organization context and auth state. Optional props:

- `menu` -- `{ disabled, onPick }`: drawn in the phone drawer (full width, 44px), which closes on a pick.
- `focusFallback` -- a ref to the phone menu's button, where focus goes after a Try again (or a load that worked) when the header switcher is hidden (below 375px).

## States

| State | Appearance |
|---|---|
| Closed | Button showing current org name |
| Open | Dropdown with org list, focused item highlighted |
| Hover (item) | `accent` background |
| Active (item) | Checkmark indicator |
| Loading | "Loading..." while the active org loads (disabled) |
| Switching | "Switching..." with a people icon, dimmed and busy, when no org is shown yet and a switch runs |
| Failed | "Open X" with a retry mark (the mark alone below 640px in the header), named "Try again: open X" at every width; opening an org failed with none active |
| Load failed | "Load organization" with a retry mark (the mark alone below 640px in the header), named "Load organization, try again"; the active organization or the list could not be loaded (no answer, or a server error). Its retry is always announced ("Loading your organization...", then loaded once both have arrived, or, where none is active after all, "Opening X..." and "Opened X" for the first, which opens; or "Couldn't load your organization." with Try again; where only the list failed, "Couldn't load your organizations." with a Try again that loads the list), is marked busy while it or another switch runs, and stays focusable. Where the load finds no org active and none listed, it says "You're no longer in any organization." and the create state shows. Nothing is kept to announce a later open |
| Create | "Create Organization" when the user has none (never when the list failed to load) |
| Single org | Dropdown still shown but with only one item |

## Code Example

```tsx
// In the workflow toolbar
<OrgSwitcher focusFallback={menuButtonRef} />
// In the phone drawer
<OrgSwitcher menu={{ disabled: busy, onPick }} />
```

## Cross-references

- [Navigation Sidebar](./navigation-sidebar.md) -- Phones: how it switches, fails and recovers
- Manage Orgs Modal -- opened from the Create Organization state (no organizations yet)
