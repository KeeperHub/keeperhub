---
title: "Run Status and Logs"
description: "Understanding workflow run statuses and how to interpret execution logs in KeeperHub."
---

# Run Status and Logs

Every workflow execution generates detailed status information and logs that help you understand what happened during the run.

## Run Status Indicators

### Successful Run

A green checkmark indicates the workflow completed successfully. All nodes executed without errors and the workflow reached its intended conclusion.

### Failed Run

A red indicator shows the workflow encountered an error. Expand the run details to identify which node failed and review the error information.

## Execution Logs Structure

Each run contains a complete execution trace showing how data flowed through your workflow.

### Trigger Log

The first entry shows your trigger node:
- Trigger type (Scheduled, Webhook, Event, Block, Manual)
- Execution time (typically 0ms for triggers)
- Trigger configuration used
- Output data passed to the next node

**Event Triggers**: When a workflow is triggered by a blockchain event, the trigger output automatically includes block explorer links for transaction hashes and addresses. These appear as `transactionLink` and `addressLink` fields in the OUTPUT section, allowing you to click directly to the block explorer for verification.

### Action Logs

Each action node shows:
- Action name and type
- Execution duration in milliseconds
- Input data received from previous nodes
- Output data generated
- Any errors encountered

### Condition Logs

Condition nodes display:
- Condition evaluated
- Input values used for comparison
- Result (true/false)
- Which branch was taken

## Reading Node Data

### INPUT Section

The INPUT section shows the data a node received. This typically includes:
- Data from previous nodes in the workflow
- Configuration values
- Dynamic variables

Example INPUT for a Check Balance action:
```json
{
  "network": "ethereum",
  "address": "0x1234...5678",
  "token": null
}
```

### OUTPUT Section

The OUTPUT section shows what the node produced. This data becomes available to subsequent nodes.

Example OUTPUT from a Check Balance action:
```json
{
  "balance": "1.5",
  "balanceWei": "1500000000000000000",
  "network": "ethereum",
  "address": "0x1234...5678"
}
```

## Log Timestamps

- **Run timestamp**: When the workflow started
- **Node execution time**: Duration of each individual node
- **Total duration**: Sum of all node execution times plus overhead

## Data Flow Visualization

The expanded run view shows the sequence of execution:

1. Trigger fires and produces initial data
2. Each subsequent node receives input from previous nodes
3. Conditions evaluate and route to appropriate branches
4. Actions execute and generate outputs
5. Final node completes the workflow

## Copying Log Data

Click the Copy button next to any INPUT or OUTPUT section to copy the JSON data. Use this for:
- Debugging unexpected behavior
- Sharing execution details with support
- Verifying data transformations
