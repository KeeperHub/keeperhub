#!/bin/bash
# Test script for the unified executor SQS pipeline.
# Sends one message per trigger type to the local SQS queue and tails executor logs.
#
# Usage:
#   ./keeperhub-executor/test-sqs.sh              # Send all three
#   ./keeperhub-executor/test-sqs.sh schedule      # Send schedule only
#   ./keeperhub-executor/test-sqs.sh event          # Send event only
#   ./keeperhub-executor/test-sqs.sh block          # Send block only
#
# Prerequisites: docker compose --profile dev up -d

set -e

QUEUE_URL="http://localhost:4566/000000000000/keeperhub-workflow-queue"
CONTAINER="keeperhub-localstack"

send_message() {
  local type="$1"
  local body="$2"
  echo "[test-sqs] Sending $type message..."
  docker exec "$CONTAINER" awslocal sqs send-message \
    --queue-url "$QUEUE_URL" \
    --message-body "$body" > /dev/null
  echo "[test-sqs] $type message sent"
}

send_schedule() {
  send_message "schedule" '{
    "workflowId": "test-schedule-001",
    "scheduleId": "test-sched-001",
    "triggerTime": "2026-01-01T00:00:00Z",
    "triggerType": "schedule"
  }'
}

send_event() {
  send_message "event" '{
    "workflowId": "test-event-001",
    "userId": "test-user-001",
    "triggerType": "event",
    "triggerData": {
      "contractAddress": "0xdAC17F958D2ee523a2206206994597C13D831ec7",
      "eventName": "Transfer",
      "transactionHash": "0xabc123",
      "blockNumber": 12345678
    }
  }'
}

send_block() {
  send_message "block" '{
    "workflowId": "test-block-001",
    "userId": "test-user-001",
    "triggerType": "block",
    "triggerData": {
      "blockNumber": 12345678,
      "blockHash": "0xdef456",
      "blockTimestamp": 1700000000,
      "parentHash": "0x789abc"
    }
  }'
}

TYPE="${1:-all}"

case "$TYPE" in
  schedule) send_schedule ;;
  event)    send_event ;;
  block)    send_block ;;
  all)
    send_schedule
    send_event
    send_block
    ;;
  *)
    echo "Usage: $0 [schedule|event|block|all]"
    exit 1
    ;;
esac

echo ""
echo "[test-sqs] Waiting for executor to process..."
sleep 5
echo ""
echo "=== Executor Logs ==="
docker logs keeperhub-executor 2>&1 | tail -30
