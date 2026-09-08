/**
 * ERC-8004 ReputationRegistry helpers.
 *
 * Two pure functions:
 *   - `buildGiveFeedbackCalldata`: encode the giveFeedback(...) call for the
 *     EVM. Returns the calldata hex; the caller bundles it into an unsigned
 *     EIP-1559 tx.
 *   - `buildFeedbackUriContent`: produce the canonical off-chain JSON the
 *     feedbackURI on-chain reference resolves to. The caller hashes this
 *     deterministically (`keccak256(toUtf8Bytes(JSON.stringify(content)))`)
 *     and passes the hash as the bytes32 `feedbackHash` arg.
 *
 * The on-chain function signature (per ERC-8004 spec):
 *   giveFeedback(
 *     uint256 agentId,
 *     int128  value,
 *     uint8   valueDecimals,
 *     string  tag1,
 *     string  tag2,
 *     string  endpoint,
 *     string  feedbackURI,
 *     bytes32 feedbackHash,
 *   )
 *
 * Selector: 0x3c036a7e (validated against ethers + viem; see constants).
 */
import { encodeFunctionData, type Hex, keccak256, stringToBytes } from "viem";

const GIVE_FEEDBACK_ABI = [
  {
    type: "function",
    name: "giveFeedback",
    stateMutability: "nonpayable",
    inputs: [
      { name: "agentId", type: "uint256" },
      { name: "value", type: "int128" },
      { name: "valueDecimals", type: "uint8" },
      { name: "tag1", type: "string" },
      { name: "tag2", type: "string" },
      { name: "endpoint", type: "string" },
      { name: "feedbackURI", type: "string" },
      { name: "feedbackHash", type: "bytes32" },
    ],
    outputs: [],
  },
] as const;

export type GiveFeedbackArgs = {
  agentId: bigint;
  value: bigint;
  valueDecimals: number;
  tag1?: string;
  tag2?: string;
  endpoint?: string;
  feedbackURI: string;
  feedbackHash: Hex;
};

export function buildGiveFeedbackCalldata(args: GiveFeedbackArgs): Hex {
  return encodeFunctionData({
    abi: GIVE_FEEDBACK_ABI,
    functionName: "giveFeedback",
    args: [
      args.agentId,
      args.value,
      args.valueDecimals,
      args.tag1 ?? "",
      args.tag2 ?? "",
      args.endpoint ?? "",
      args.feedbackURI,
      args.feedbackHash,
    ],
  });
}

/**
 * Off-chain JSON shape served at /api/feedback/<id>.
 *
 * Derived from the ERC-8004 spec's "feedbackURI content" recommendation
 * (agentRegistry, agentId, clientAddress, createdAt, value, optional
 * tag1/tag2/endpoint/mcp/a2a context). KeeperHub-specific extension: the
 * `mcp` block carries `workflowSlug` + `executionId` so a downstream reader
 * knows what was actually rated.
 */
export type FeedbackUriContent = {
  agentRegistry: "erc-8004";
  agentChainId: number;
  agentId: string;
  clientAddress: `0x${string}`;
  createdAt: string;
  value: string;
  valueDecimals: number;
  comment?: string;
  mcp?: {
    workflowSlug: string;
    executionId: string;
  };
};

export function buildFeedbackUriContent(args: {
  agentChainId: number;
  agentId: bigint;
  clientAddress: `0x${string}`;
  createdAt: Date;
  value: bigint;
  valueDecimals: number;
  comment?: string;
  workflowSlug?: string;
  executionId?: string;
}): FeedbackUriContent {
  const out: FeedbackUriContent = {
    agentRegistry: "erc-8004",
    agentChainId: args.agentChainId,
    agentId: args.agentId.toString(),
    clientAddress: args.clientAddress,
    createdAt: args.createdAt.toISOString(),
    value: args.value.toString(),
    valueDecimals: args.valueDecimals,
  };
  if (args.comment !== undefined) {
    out.comment = args.comment;
  }
  if (args.workflowSlug !== undefined && args.executionId !== undefined) {
    out.mcp = {
      workflowSlug: args.workflowSlug,
      executionId: args.executionId,
    };
  }
  return out;
}

/**
 * Canonicalised serialization for hashing. Keys are emitted in stable order
 * so the on-chain `feedbackHash` always matches the JSON we serve at
 * `/api/feedback/<id>` regardless of how the object was constructed.
 *
 * Required keys go first in their spec order; optional keys (comment, mcp)
 * trail. Any future field MUST be added at the end to preserve hash
 * stability for historical rows.
 */
export function canonicaliseFeedbackContent(
  content: FeedbackUriContent
): string {
  const required = {
    agentRegistry: content.agentRegistry,
    agentChainId: content.agentChainId,
    agentId: content.agentId,
    clientAddress: content.clientAddress,
    createdAt: content.createdAt,
    value: content.value,
    valueDecimals: content.valueDecimals,
  };
  const ordered: Record<string, unknown> = { ...required };
  if (content.comment !== undefined) {
    ordered.comment = content.comment;
  }
  if (content.mcp !== undefined) {
    ordered.mcp = content.mcp;
  }
  return JSON.stringify(ordered);
}

export function hashFeedbackContent(content: FeedbackUriContent): Hex {
  return keccak256(stringToBytes(canonicaliseFeedbackContent(content)));
}
