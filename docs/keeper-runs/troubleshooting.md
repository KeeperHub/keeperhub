---
title: "Troubleshooting Runs"
description: "Common workflow execution issues and how to diagnose and resolve them using the runs panel."
---

# Troubleshooting Runs

When a workflow does not behave as expected, the Runs panel provides the information needed to diagnose and resolve issues.

## Common Issues

### Workflow Not Triggering

**Symptoms**: No new runs appear in the Runs panel.

**Possible Causes**:
- Workflow is not enabled
- Scheduled trigger interval has not elapsed
- Webhook URL is incorrect or not being called
- Event trigger is monitoring the wrong contract or event

**Resolution Steps**:
1. Verify the workflow is enabled in the editor
2. Check trigger configuration for correct settings
3. For webhooks, test the URL directly
4. For events, confirm the contract address and event signature

### Node Execution Failure

**Symptoms**: Run shows failed status; specific node shows error.

**Diagnosis**:
1. Expand the failed run in the Runs panel
2. Locate the node with the error indicator
3. Expand the INPUT section to verify correct data was received
4. Review the error message in the OUTPUT section

**Common Causes**:
- Invalid input data from previous node
- Network connectivity issues
- Insufficient wallet balance for transactions
- Smart contract reverted the transaction
- Invalid contract address or ABI mismatch

### Unexpected Condition Results

**Symptoms**: Workflow takes wrong branch at condition node.

**Diagnosis**:
1. Expand the run and find the condition node
2. Review the INPUT data to see what values were compared
3. Verify the condition configuration matches your intent

**Resolution**:
- Adjust condition thresholds
- Verify data types match (string vs number)
- Check for null or undefined values in input

### Transaction Failures

**Symptoms**: Write Contract or Transfer Funds action fails.

**Common Causes**:
- Insufficient ETH balance for gas fees
- Contract function reverted
- Gas estimation failed
- Nonce conflicts from pending transactions

**Resolution Steps**:
1. Check Turnkey wallet balance in KeeperHub
2. Review the error message for revert reason
3. Verify contract function parameters
4. Wait for pending transactions to clear

### Slow Execution Times

**Symptoms**: Runs complete but take longer than expected.

**Possible Causes**:
- Network congestion affecting blockchain calls
- External API latency (webhooks, notifications)
- Complex contract calls requiring more computation

**Recommendations**:
- Review execution times for each node
- Identify slow nodes by comparing durations
- Consider simplifying complex contract interactions

## Using Run Data for Debugging

### Comparing Successful and Failed Runs

1. Find a successful run for reference
2. Compare INPUT data between successful and failed runs
3. Identify differences in configuration or data

### Tracing Data Flow

1. Start at the trigger and review its OUTPUT
2. Follow the data through each subsequent node
3. Verify each transformation produces expected results

### Verifying External Integrations

For notification or webhook actions:
1. Check the INPUT contains correct payload
2. Verify external service received the request
3. Review response codes in OUTPUT if available

## Best Practices

### Before Deploying

- Test workflows with Manual trigger first
- Verify each node produces expected output
- Check condition logic with various input values

### Monitoring Active Workflows

- Regularly review the Runs panel for failures
- Clear old run history to maintain performance
- Use the Refresh button to see latest executions

### When Issues Persist

- Copy relevant INPUT/OUTPUT data for analysis
- Check wallet balances and network status
- Review recent changes to workflow configuration
