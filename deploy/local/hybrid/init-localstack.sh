#!/bin/bash
# =============================================================================
# LocalStack Initialization Script
#
# Creates the SQS queue for KeeperHub workflow scheduling.
# This script runs automatically when LocalStack starts.
# =============================================================================

echo "Initializing LocalStack for KeeperHub..."

# Create the workflow queue
awslocal sqs create-queue \
  --queue-name keeperhub-workflow-queue \
  --attributes '{
    "VisibilityTimeout": "300",
    "MessageRetentionPeriod": "86400",
    "ReceiveMessageWaitTimeSeconds": "20"
  }'

echo "Created SQS queue: keeperhub-workflow-queue"

# List queues to verify
echo "Available queues:"
awslocal sqs list-queues

echo "LocalStack initialization complete!"
