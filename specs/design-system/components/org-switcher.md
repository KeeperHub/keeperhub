# Organization Switcher

## Metadata

| Field | Value |
|---|---|
| Name | OrgSwitcher |
| Category | Navigation |
| Status | Active |
| File | `keeperhub/components/organization/org-switcher.tsx` |

## Overview

Dropdown control for switching between organizations. Shows current org name and allows selecting a different org or creating a new one.

**When to use**: At the top of the navigation sidebar.

**When not to use**: In settings pages (use full org management UI instead).

## Anatomy

1. **Trigger Button** -- displays current org name with chevron, combobox role
2. **Dropdown Menu** -- popover with org list
3. **Org Item** -- individual org with name and optional avatar
4. **Divider** -- separator between org list and actions
5. **Create Org** -- action button to create new organization
6. **Manage Orgs** -- action button to open org settings

## Tokens Used

| Token | Usage |
|---|---|
| `--popover` | Dropdown background |
| `--popover-foreground` | Dropdown text |
| `--border` | Dropdown border |
| `--accent` | Hover state on items |
| `--accent-foreground` | Hover text |
| `--muted-foreground` | Secondary text |
| `w-[200px]` | Fixed width (should use spacing token) |

## Props/API

No external props. Reads from organization context and auth state.

## States

| State | Appearance |
|---|---|
| Closed | Button showing current org name |
| Open | Dropdown with org list, focused item highlighted |
| Hover (item) | `accent` background |
| Active (item) | Checkmark indicator |
| Loading | Skeleton text in button |
| Single org | Dropdown still shown but with only one item |

## Code Example

```tsx
// Used in sidebar layout
<OrgSwitcher />
```

## Cross-references

- [Navigation Sidebar](./navigation-sidebar.md) -- parent container
- Manage Orgs Modal -- opened from "Manage" action
