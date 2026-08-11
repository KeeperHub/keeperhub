/**
 * SQS Client Configuration
 */

import { SQSClient } from "@aws-sdk/client-sqs";
import { AWS_ENDPOINT_URL, AWS_REGION } from "./config.js";

// SQS client - only use custom endpoint/credentials for local development
const sqsConfig: ConstructorParameters<typeof SQSClient>[0] = {
  region: AWS_REGION,
};

// Only set endpoint for local development (LocalStack)
if (AWS_ENDPOINT_URL) {
  sqsConfig.endpoint = AWS_ENDPOINT_URL;
  sqsConfig.credentials = {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || "test",
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "test",
  };
}

export const sqs = new SQSClient(sqsConfig);
