import { describe, expect, it } from "vitest";
import { TRIGGERS } from "@/lib/mcp/workflow-schema-constants";

// The Solana block trigger's triggerData is produced by buildBlockPayload in
// keeperhub-events/solana-tracker/src/payload/block-payload.ts. Those field
// names must be documented in the Block trigger's outputFields so template
// autocomplete ({{@trigger:...}}) and AI-generated Solana block workflows
// reference fields that actually exist. This guards against the two drifting.
const SOLANA_BLOCK_PAYLOAD_KEYS = [
  "chainType",
  "slot",
  "blockHeight",
  "blockhash",
  "blockTime",
  "parentSlot",
] as const;

const EVM_BLOCK_KEYS = [
  "blockNumber",
  "blockHash",
  "blockTimestamp",
  "parentHash",
] as const;

describe("Block trigger outputFields", () => {
  const fields = TRIGGERS.Block.outputFields as Record<string, string>;

  it("documents every Solana block payload field", () => {
    for (const key of SOLANA_BLOCK_PAYLOAD_KEYS) {
      expect(fields).toHaveProperty(key);
    }
  });

  it("retains the EVM block fields (additive, not replaced)", () => {
    for (const key of EVM_BLOCK_KEYS) {
      expect(fields).toHaveProperty(key);
    }
  });

  it("keeps triggeredAt (present on all trigger types)", () => {
    expect(fields).toHaveProperty("triggeredAt");
  });
});
