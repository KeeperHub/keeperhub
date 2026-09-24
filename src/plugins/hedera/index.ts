import { Client, PrivateKey, TopicMessageSubmitTransaction, TransactionRecord } from "@hashgraph/sdk";
import fetch from "node-fetch";
import { SubmitResult, VerifyResult } from "./types";

/**
 * Submit a message to a Hedera HCS topic.
 *
 * @param payload - JSON object or string to be submitted.
 * @param topicId - Optional topic ID; if omitted, will use HEDERA_TOPIC_ID env var.
 * @returns SubmitResult containing topic ID, sequence number, consensus timestamp and a hashscan link.
 */
export async function submitMessage(
  payload: string | Record<string, unknown>,
  topicId?: string
): Promise<SubmitResult> {
  const operatorKey = process.env.HEDERA_OPERATOR_KEY;
  const operatorAccount = process.env.HEDERA_OPERATOR_ACCOUNT;
  const network = process.env.HEDERA_NETWORK ?? "testnet";
  const mirrorUrl = process.env.HEDERA_MIRROR_URL ?? "https://testnet.mirror.hedera.com";
  const defaultTopicId = process.env.HEDERA_TOPIC_ID;

  if (!operatorKey || !operatorAccount) {
    throw new Error("Hedera operator key/account not set in environment");
  }
  if (!topicId && !defaultTopicId) {
    throw new Error("Hedera topic ID not provided");
  }

  const client = Client.forName(network).setOperator(
    operatorAccount,
    PrivateKey.fromString(operatorKey)
  );

  const message =
    typeof payload === "object" ? JSON.stringify(payload) : payload;

  const transaction = new TopicMessageSubmitTransaction()
    .setTopicId(topicId ?? defaultTopicId!)
    .setMessage(message);

  const txResponse = await transaction.execute(client);
  const receipt = await txResponse.getReceipt(client);
  const record = await txResponse.getRecord(client);

  const seqNum = record.sequenceNumber?.toString() ?? "0";
  const consensusTs = record.consensusTimestamp?.toString() ?? "";

  const hashscanLink = `https://hashscan.io/${network}/topic/${topicId ?? defaultTopicId}/message/${seqNum}`;

  return {
    topicId: topicId ?? defaultTopicId!,
    sequenceNumber: seqNum,
    consensusTimestamp: consensusTs,
    hashscanLink,
  };
}

/**
 * Verify a message from a Hedera HCS topic by fetching it from a mirror node.
 *
 * @param topicId - The topic ID to query.
 * @param sequenceNumber - The sequence number of the message to verify.
 * @param expectedPayload - The payload that was originally submitted.
 * @returns VerifyResult indicating whether the payload matches.
 */
export async function verifyMessage(
  topicId: string,
  sequenceNumber: string,
  expectedPayload: string | Record<string, unknown>
): Promise<VerifyResult> {
  const mirrorUrl = process.env.HEDERA_MIRROR_URL ?? "https://testnet.mirror.hedera.com";
  const payloadStr =
    typeof expectedPayload === "object" ? JSON.stringify(expectedPayload) : expectedPayload;

  const url = `${mirrorUrl}/api/v1/topics/${topicId}/messages?seq_start=${sequenceNumber}&seq_end=${sequenceNumber}`;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch message from mirror: ${response.statusText}`);
  }

  const data = await response.json();

  if (!data.messages || data.messages.length === 0) {
    throw new Error(`No message found for seq ${sequenceNumber} on topic ${topicId}`);
  }

  const message = data.messages[0];
  const receivedPayload = message.message ?? "";
  const verified = receivedPayload === payloadStr;

  return {
    verified,
    payload: receivedPayload,
    sequenceNumber: message.sequence_number ?? "",
    consensusTimestamp: message.consensus_timestamp ?? "",
  };
}
