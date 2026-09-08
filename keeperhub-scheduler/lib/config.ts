/**
 * Configuration for KeeperHub Scheduler
 */

export const KEEPERHUB_URL =
  process.env.KEEPERHUB_API_URL || "http://localhost:3000";

export const AWS_REGION = process.env.AWS_REGION || "us-east-1";
export const AWS_ENDPOINT_URL = process.env.AWS_ENDPOINT_URL;

export const SQS_QUEUE_URL =
  process.env.SQS_QUEUE_URL ||
  "http://sqs.us-east-1.localhost.localstack.cloud:4566/000000000000/keeperhub-workflow-queue";

// Block dispatcher config
export const RECONCILE_INTERVAL_MS =
  Number(process.env.RECONCILE_INTERVAL_MS) || 30_000;
