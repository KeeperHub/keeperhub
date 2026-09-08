# Workflow Runs

## Metadata

| Field | Value |
|---|---|
| Name | WorkflowRuns |
| Category | Workflow |
| Status | Active |
| File | `components/workflow/workflow-runs.tsx` |

## Overview

Panel showing workflow execution history and real-time logs. Displays a list of past runs with their status, duration, and step-by-step results.

**When to use**: Inside the workflow editor, toggled via the toolbar.

**When not to use**: For analytics-level run data, use the RunsTable in analytics instead.

## Anatomy

1. **Runs List** -- scrollable list of execution runs
2. **Run Item** -- individual run with timestamp, status badge, duration
3. **Step Results** -- expandable section showing each step's outcome
4. **Log Output** -- raw log text for each step
5. **Status Badge** -- success/error/running/cancelled indicator
6. **Auto-refresh Indicator** -- polling state for active runs

## Tokens Used

| Token | Usage |
|---|---|
| `--background` | Panel background |
| `--card` | Run item background |
| `--border` | Dividers between runs |
| `--foreground` | Primary text |
| `--muted-foreground` | Timestamps, metadata |
| `--keeperhub-green` | Success status |
| `--destructive` | Error status |
| `--accent` | Running/active state |
| `text-sm` | Body text |
| `text-xs` | Metadata/timestamps |
| `font-mono` | Log output text |

## States

| State | Appearance |
|---|---|
| Empty | "No runs yet" placeholder |
| Loading | Skeleton items |
| Run idle | Neutral border, timestamp shown |
| Run active | Blue/pulsing indicator, auto-polling |
| Run success | Green badge, all steps green |
| Run error | Red badge, failed step highlighted |
| Run cancelled | Gray badge, "Cancelled" label |

## Cross-references

- [Workflow Node](./workflow-node.md) -- nodes update status based on run data
- [Analytics Runs Table](./runs-table.md) -- analytics-level run view
