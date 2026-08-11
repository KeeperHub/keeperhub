import type { Commitment } from "@solana/web3.js";
import {
  type SolanaEventPayload,
  buildSolanaEventPayload,
} from "../decode/solana-event-serializer";
import type { AnchorEventDecoder } from "../decode/solana-idl";
import type { SolanaEventTrigger } from "../registrations";
import type { NormalizedBlock, NormalizedTx } from "./types";

/**
 * One workflow to fire for one matched transaction. The ingestor dedups by
 * (workflowId, signature) and enqueues; the matcher itself is pure.
 */
export interface EventFire {
  workflowId: string;
  userId: string;
  signature: string;
  payload: SolanaEventPayload;
}

/**
 * Matches every transaction in a block against the chain's event triggers,
 * indexed by programId. For each tx that references a watched program:
 *   - raw mode (no decoder): fire with raw logs;
 *   - typed mode (decoder + eventName): decode Anchor events, fire only when the
 *     named event is present, attaching the decoded fields.
 * A workflow fires at most once per transaction even if it appears under
 * multiple account keys.
 *
 * `decoders` is keyed by workflowId (built once per reconcile from each
 * trigger's IDL); a null/absent decoder means raw mode.
 */
export function matchEvents(
  block: NormalizedBlock,
  triggers: SolanaEventTrigger[],
  decoders: Map<string, AnchorEventDecoder | null>,
  commitment: Commitment,
): EventFire[] {
  if (triggers.length === 0) {
    return [];
  }
  const index = new Map<string, SolanaEventTrigger[]>();
  for (const trigger of triggers) {
    const list = index.get(trigger.programId) ?? [];
    list.push(trigger);
    index.set(trigger.programId, list);
  }

  const fires: EventFire[] = [];
  for (const tx of block.transactions) {
    if (tx.failed) {
      continue;
    }
    const firedWorkflows = new Set<string>();
    for (const programId of tx.programIds) {
      const matchedTriggers = index.get(programId);
      if (!matchedTriggers) {
        continue;
      }
      for (const trigger of matchedTriggers) {
        if (firedWorkflows.has(trigger.workflowId)) {
          continue;
        }
        const fire = evaluateTrigger(tx, block, trigger, decoders, commitment);
        if (fire) {
          firedWorkflows.add(trigger.workflowId);
          fires.push(fire);
        }
      }
    }
  }
  return fires;
}

function evaluateTrigger(
  tx: NormalizedTx,
  block: NormalizedBlock,
  trigger: SolanaEventTrigger,
  decoders: Map<string, AnchorEventDecoder | null>,
  commitment: Commitment,
): EventFire | null {
  const decoder = decoders.get(trigger.workflowId) ?? null;
  const decoded = decoder ? decoder.decodeLogs(tx.logMessages) : [];
  let matchedEvents = decoded;
  if (trigger.eventName && decoder) {
    matchedEvents = decoded.filter((e) => e.name === trigger.eventName);
    if (matchedEvents.length === 0) {
      // Typed filter: the named event was not emitted in this tx; skip.
      return null;
    }
  }
  return {
    workflowId: trigger.workflowId,
    userId: trigger.userId,
    signature: tx.signature,
    payload: buildSolanaEventPayload({
      programId: trigger.programId,
      signature: tx.signature,
      slot: block.slot,
      commitment,
      logs: tx.logMessages,
      eventName: trigger.eventName,
      decodedEvents: matchedEvents,
    }),
  };
}
