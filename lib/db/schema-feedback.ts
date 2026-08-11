import {
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { workflowExecutions, workflows } from "@/lib/db/schema";
import { generateId } from "@/lib/utils/id";

/**
 * Feedback lifecycle pgEnum.
 *
 *   pending    -- row inserted, no on-chain broadcast yet
 *   broadcast  -- giveFeedback() tx sent, hash recorded, awaiting confirmation
 *   confirmed  -- tx mined and indexed on-chain
 *   failed     -- broadcast or confirmation failed (reason in error column)
 *
 * Distinct DB type name to avoid collisions with workflow status enums.
 */
export const feedbackStatus = pgEnum("feedback_status", [
  "pending",
  "broadcast",
  "confirmed",
  "failed",
]);

/**
 * Feedback table -- ERC-8004 ReputationRegistry feedback authored via the
 * agentic-wallet flow.
 *
 * One row per submitted feedback. The `id` is used as the path segment in
 * the canonical feedbackURI (`/api/feedback/<id>`) which is referenced
 * on-chain in the giveFeedback() transaction. The off-chain JSON served
 * at that URI is reconstructed deterministically from this row + the
 * referenced execution; we do NOT persist a denormalised JSON blob, so
 * any rendering change applies to all historical rows uniformly.
 *
 * Lifecycle: caller hits POST /api/agentic-wallet/feedback with executionId
 * + value + valueDecimals (+ optional comment). The route inserts the row
 * with status="pending", builds the giveFeedback tx, signs+broadcasts via
 * Turnkey, then updates txHash + status="broadcast". A separate poller
 * watches for receipts and bumps to "confirmed" / "failed".
 *
 * Sybil note: 8004scan is expected to discount feedback whose payerWallet
 * is associated with the rated agent's owner wallet. We persist payerWallet
 * regardless to keep an audit trail; downstream presentation can filter.
 */
export const feedback = pgTable(
  "feedback",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => generateId()),

    // Execution that produced this feedback. Establishes that the payer
    // actually used the workflow before rating it (anti-spam at the
    // application layer; the Turnkey policy already gates raw signing).
    executionId: text("execution_id")
      .notNull()
      .references(() => workflowExecutions.id),
    workflowId: text("workflow_id")
      .notNull()
      .references(() => workflows.id),

    // Rated agent identity. agentRegistry pinned to "erc-8004" today --
    // kept as a column so other registries can be added without a schema
    // migration. agentChainId records WHERE the agent NFT lives (Ethereum
    // mainnet = 1 for all current ERC-8004 agents). agentId is the NFT id.
    agentRegistry: text("agent_registry").notNull().default("erc-8004"),
    agentChainId: integer("agent_chain_id").notNull(),
    agentId: text("agent_id").notNull(), // uint256 -- text avoids JS number precision loss

    // Caller wallet that signed giveFeedback(). Always lowercased 0x EVM
    // address. Indexed for "show me my feedback history" queries.
    payerWallet: text("payer_wallet").notNull(),

    // Rating. ERC-8004 spec carries an int128 + uint8 decimals. We store
    // the raw integer (text -- int128 exceeds Postgres bigint range) and
    // the decimals scalar separately, mirroring the contract args. Display
    // logic computes value / 10^decimals.
    value: text("value").notNull(),
    valueDecimals: integer("value_decimals").notNull(),

    // Optional plain-text comment. Surfaced on app.keeperhub.com workflow
    // pages; included verbatim in the feedbackURI JSON.
    comment: text("comment"),

    // keccak256 of the feedbackURI JSON content. Stored so the route can
    // emit it as the bytes32 feedbackHash arg of giveFeedback() without
    // recomputing on every request, and so a downstream verifier can
    // detect tampering of the hosted JSON.
    feedbackHash: text("feedback_hash"),

    // On-chain bookkeeping. txChainId is where the giveFeedback() call was
    // submitted (always == agentChainId today since the spec colocates
    // them). txHash null until broadcast.
    txChainId: integer("tx_chain_id").notNull(),
    txHash: text("tx_hash"),

    status: feedbackStatus("status").notNull().default("pending"),
    error: text("error"),

    createdAt: timestamp("created_at").notNull().defaultNow(),
    broadcastAt: timestamp("broadcast_at"),
    confirmedAt: timestamp("confirmed_at"),
  },
  (table) => [
    index("idx_feedback_execution").on(table.executionId),
    index("idx_feedback_payer").on(table.payerWallet),
    index("idx_feedback_agent").on(
      table.agentRegistry,
      table.agentChainId,
      table.agentId
    ),
    index("idx_feedback_status").on(table.status),
  ]
);
