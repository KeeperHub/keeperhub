import {
  CreateQueueCommand,
  DeleteQueueCommand,
  type Message,
  PurgeQueueCommand,
  ReceiveMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";

export function makeSqsClient(endpoint: string): SQSClient {
  return new SQSClient({
    region: "us-east-1",
    endpoint,
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
  });
}

export async function createQueue(
  client: SQSClient,
  name: string,
  endpoint: string,
): Promise<string> {
  try {
    const result = await client.send(
      new CreateQueueCommand({ QueueName: name }),
    );
    if (!result.QueueUrl) {
      throw new Error("CreateQueueCommand returned no QueueUrl");
    }
    // LocalStack may return a URL with an internal hostname. Rewrite to the
    // endpoint the test process can actually reach.
    return result.QueueUrl.replace("host.minikube.internal", "localhost")
      .replace("test-localstack", "localhost")
      .replace("localstack", "localhost");
  } catch {
    // Queue may already exist from a prior test run.
    return `${endpoint}/000000000000/${name}`;
  }
}

export async function deleteQueue(
  client: SQSClient,
  url: string,
): Promise<void> {
  try {
    await client.send(new DeleteQueueCommand({ QueueUrl: url }));
  } catch {
    // Ignore cleanup errors.
  }
}

export async function purgeQueue(
  client: SQSClient,
  url: string,
): Promise<void> {
  try {
    await client.send(new PurgeQueueCommand({ QueueUrl: url }));
  } catch {
    // Purge fails if the queue was purged recently; harmless.
  }
}

export async function pollForMessage(
  client: SQSClient,
  url: string,
  timeoutMs: number,
): Promise<Message | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const waitSeconds = Math.max(
      1,
      Math.min(20, Math.ceil((deadline - Date.now()) / 1000)),
    );
    const result = await client.send(
      new ReceiveMessageCommand({
        QueueUrl: url,
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: waitSeconds,
        MessageAttributeNames: ["All"],
      }),
    );
    if (result.Messages && result.Messages.length > 0) {
      return result.Messages[0];
    }
  }
  return null;
}
