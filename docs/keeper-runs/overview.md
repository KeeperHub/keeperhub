---
title: "Understanding Keeper Runs"
description: "Learn how to view and analyze workflow execution history in the KeeperHub runs panel."
---

# Understanding Keeper Runs

The Runs panel provides visibility into your workflow execution history, allowing you to monitor success rates, debug issues, and understand how your automations perform.

## Accessing the Runs Panel

The Runs panel is located on the right side of the workflow editor. It displays a chronological list of all executions for the current workflow.

## Run List Overview

Each run entry in the list displays:

- **Run Number**: Sequential identifier (e.g., "Run #50")
- **Timestamp**: When the run occurred (e.g., "just now", "2 minutes ago")
- **Total Duration**: End-to-end execution time (e.g., "572ms")
- **Step Count**: Number of nodes executed (e.g., "3 steps")
- **Status Indicator**: Green checkmark for successful runs

## Run Details

Click on any run to expand and view node-by-node execution details. Each step shows:

- **Node Name**: The trigger, action, or condition that executed
- **Execution Time**: Time spent on that specific node (e.g., "Scheduled Trigger 0ms", "Check Balance 199ms")
- **INPUT Section**: Expandable view of the data received by the node
- **OUTPUT Section**: Expandable view of the data produced by the node

## Working with Run Data

### Viewing Input and Output

Click the INPUT or OUTPUT label on any node to expand the JSON data. This data shows exactly what information flowed through your workflow at each step.

### Copying Data

Use the Copy button next to any INPUT or OUTPUT section to copy the JSON data to your clipboard. This is useful for debugging or sharing execution details.

## Panel Controls

- **Refresh**: Click to update the run list with the latest executions
- **Clear All**: Remove all run history from the panel

## Run History Retention

Run history is stored for each workflow and persists across sessions. Use the Runs panel as your primary interface for understanding workflow behavior and performance.
