/**
 * Trigger Output Fields
 * Defines output fields for different trigger types to enable template autocomplete
 */

import type { OutputField } from "@/plugins/registry";

/** Common field available on every trigger type */
const TRIGGERED_AT_FIELD: OutputField = {
  field: "triggeredAt",
  description: "ISO timestamp when the workflow was triggered",
};

/**
 * Get output fields for Event trigger based on ABI and selected event
 */
export function getEventTriggerOutputFields(
  abi: string | undefined,
  eventName: string | undefined
): OutputField[] {
  if (!(abi && eventName)) {
    // Return default event output fields if ABI/event not configured
    return [
      {
        field: "eventName",
        description: "Name of the event that was emitted",
      },
      {
        field: "args",
        description: "Event arguments (decoded parameters)",
      },
      {
        field: "blockNumber",
        description: "Block number where the event was emitted",
      },
      {
        field: "transactionHash",
        description: "Transaction hash that emitted the event",
      },
      {
        field: "address",
        description: "Contract address that emitted the event",
      },
      TRIGGERED_AT_FIELD,
    ];
  }

  try {
    const abiArray = JSON.parse(abi);
    if (!Array.isArray(abiArray)) {
      return getEventTriggerOutputFields(undefined, undefined);
    }

    // Find the event in the ABI
    const event = abiArray.find(
      (item: { type: string; name?: string }) =>
        item.type === "event" && item.name === eventName
    );

    if (!event?.inputs) {
      return getEventTriggerOutputFields(undefined, undefined);
    }

    // Build output fields based on event parameters
    const outputFields: OutputField[] = [
      {
        field: "eventName",
        description: "Name of the event that was emitted",
      },
    ];

    // Add each event parameter as an output field
    // Args are deserialized: uint/int types are BigInt, bool is boolean, strings/addresses are strings
    for (const input of event.inputs) {
      const paramName = input.name || "unnamed";
      const indexed = input.indexed ? " (indexed)" : "";
      let deserializedType: string;
      if (input.type.includes("uint") || input.type.includes("int")) {
        deserializedType = "BigInt";
      } else if (input.type === "bool") {
        deserializedType = "boolean";
      } else {
        deserializedType = "string";
      }
      outputFields.push({
        field: `args.${paramName}`,
        description: `Event parameter: ${input.type}${indexed} (deserialized: ${deserializedType})`,
      });
    }

    // Add standard blockchain event fields
    outputFields.push(
      {
        field: "blockNumber",
        description: "Block number where the event was emitted",
      },
      {
        field: "transactionHash",
        description: "Transaction hash that emitted the event",
      },
      {
        field: "blockHash",
        description: "Hash of the block containing the event",
      },
      {
        field: "address",
        description: "Contract address that emitted the event",
      },
      {
        field: "logIndex",
        description: "Index of the log in the block",
      },
      {
        field: "transactionIndex",
        description: "Index of the transaction in the block",
      },
      TRIGGERED_AT_FIELD
    );

    return outputFields;
  } catch {
    // If ABI parsing fails, return default fields
    return getEventTriggerOutputFields(undefined, undefined);
  }
}

/**
 * Get output fields for Block trigger
 */
export function getBlockTriggerOutputFields(): OutputField[] {
  return [
    {
      field: "blockNumber",
      description: "The block height",
    },
    {
      field: "blockHash",
      description: "Hash of the block",
    },
    {
      field: "blockTimestamp",
      description: "Unix timestamp of the block",
    },
    {
      field: "parentHash",
      description: "Hash of the parent block",
    },
    TRIGGERED_AT_FIELD,
  ];
}

/**
 * Get output fields for the Transfer trigger. The watched event
 * is the fixed TIP-20 `TransferWithMemo(from, to, value, memo)`, so the decoded
 * args are known up front (no ABI needed).
 */
export function getTempoPaymentOutputFields(): OutputField[] {
  return [
    { field: "args.from", description: "Sender address of the payment" },
    {
      field: "args.to",
      description: "Recipient address (the watched deposit address)",
    },
    {
      field: "args.value",
      description: "Amount transferred, in the token's smallest unit",
    },
    {
      field: "args.memo",
      description: "The bytes32 memo attached to the transfer",
    },
    {
      field: "args.memoText",
      description:
        "The memo decoded to text (e.g. INV-1042), or empty for a non-text memo",
    },
    {
      field: "transactionHash",
      description: "Hash of the payment transaction",
    },
    { field: "blockNumber", description: "Block height the payment landed in" },
    {
      field: "address",
      description: "The TIP-20 token contract that emitted the event",
    },
    TRIGGERED_AT_FIELD,
  ];
}

/**
 * Get output fields for a trigger node based on its configuration
 */
export function getTriggerOutputFields(
  triggerType: string | undefined,
  config: Record<string, unknown>
): OutputField[] {
  if (triggerType === "Block") {
    return getBlockTriggerOutputFields();
  }

  if (triggerType === "Transfer") {
    return getTempoPaymentOutputFields();
  }

  if (triggerType === "Event") {
    const abi = config.contractABI as string | undefined;
    const eventName = config.eventName as string | undefined;
    return getEventTriggerOutputFields(abi, eventName);
  }

  if (triggerType === "Webhook") {
    // Webhook outputs are dynamic based on webhookSchema
    // For now, return common webhook fields
    return [
      {
        field: "body",
        description: "Webhook request body",
      },
      {
        field: "headers",
        description: "Webhook request headers",
      },
      {
        field: "method",
        description: "HTTP method (GET, POST, etc.)",
      },
      {
        field: "query",
        description: "Query parameters",
      },
      TRIGGERED_AT_FIELD,
    ];
  }

  // Schedule, Manual, and any other trigger type
  return [TRIGGERED_AT_FIELD];
}
