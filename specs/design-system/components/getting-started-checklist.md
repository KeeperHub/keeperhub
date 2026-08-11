# Getting Started Checklist

## Metadata

| Field | Value |
|---|---|
| Name | GettingStartedChecklist |
| Category | Onboarding |
| Status | Active |
| File | `keeperhub/components/onboarding/getting-started-checklist.tsx` |

## Overview

Onboarding progress checklist shown to new users on the workflow canvas. Tracks 4 setup steps: sign in, connect wallet, set API key, create first workflow.

**When to use**: On the AddNode placeholder when user has incomplete onboarding steps.

**When not to use**: After all steps are completed and user dismisses it.

## Anatomy

1. **Header** -- "Get Started" title with progress count (e.g., "0/4")
2. **Checklist Items** -- 4 step rows with checkbox, label, and action
3. **Step Checkbox** -- green check when completed, empty circle when pending
4. **Step Action** -- button or link for incomplete steps (e.g., "Sign In", "Connect")
5. **Hide/Show Toggle** -- collapses checklist to a minimal bar
6. **Collapsed Bar** -- shows "Get Started 0/4" when hidden

## Tokens Used

| Token | Should Use | Currently Uses |
|---|---|---|
| `--keeperhub-green` | Completed checkmarks | `text-keeperhub-green` (correct) |
| `--muted-foreground` | Pending step text | `text-muted-foreground` (correct) |
| `--border` | Section borders | `border-border` (correct) |
| `--background` | Card background | `bg-background` (correct) |
| `text-[10px]` | Small label text | Should use `--ds-text-2xs` |
| `min-w-[14rem]` | Min width constraint | Arbitrary value |
| `max-w-[16rem]` | Max width constraint | Arbitrary value |

## Props/API

No external props. Uses the `useOnboardingStatus` hook:

```typescript
const { steps, completedCount, isHidden, hide, show } = useOnboardingStatus();
```

## States

| State | Appearance |
|---|---|
| All pending | 4 empty circles, action buttons visible |
| Partially complete | Mix of green checks and empty circles |
| All complete | All green checks, auto-hides after delay |
| Hidden | Collapsed bar showing "Get Started X/4" |
| Anonymous user | Auth-required steps show "Sign In" action |

## Cross-references

- [Workflow Node (AddNode)](./workflow-node.md) -- parent container
- Onboarding hook: `keeperhub/lib/hooks/use-onboarding-status.ts`
