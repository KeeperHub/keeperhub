import "server-only";

import { ExecutionErrorType } from "@/lib/errors/execution-error-type";

import {
  assertUrlIsPublic,
  safeFetch,
  SsrfBlockedError,
} from "@/lib/safe-fetch";
import {
  runPluginStep,
  type StepInput,
} from "@/lib/workflow/executor/step-handler";
import {
  HEDERA_MIRROR_API,
  isValidTopicId,
  resolveNetwork,
  type HederaNetwork,
} from "./hedera-core";

type VerifyMessageResult =
  | {
      success: true;
      found: boolean;
      verified: boolean;
      message: string | null;
      consensusTimestamp: string | null;
      sequenceNumber: string;
    }
  | { success: false; error: string; errorClass?: ExecutionErrorType };

export type VerifyMessageCoreInput = {
  topicId: string;
  sequenceNumber: string;
  expectedMessage?: string;
  network?: string;
};

export type VerifyMessageInput = StepInput & VerifyMessageCoreInput;

const MIRROR_TIMEOUT_MS = 30_000;

// HCS fragments an oversized submission into one message per sequence number;
// the mirror then returns chunk_info on each fragment instead of the full
// payload. Verify the un-fragmented case only.
type MirrorMessage = {
  message?: unknown;
  consensus_timestamp?: string;
  sequence_number?: number | string;
  topic_id?: unknown;
  chunk_info?: { total?: number };
};

// On a message 404, one GET of the topic itself tells a mistyped topic id
// (USER error) apart from a real "nothing anchored at this sequence yet"
// (found=false) — the mirror returns the same 404 body for both.
async function probeTopicExists(
  topicId: string,
  network: HederaNetwork
): Promise<boolean> {
  const url = `${HEDERA_MIRROR_API[network]}/api/v1/topics/${encodeURIComponent(topicId)}`;
  const res = await safeFetch(url, {
    plugin: "hedera",
    method: "GET",
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(MIRROR_TIMEOUT_MS),
  });
  return res.ok;
}

async function stepHandler(
  input: VerifyMessageCoreInput
): Promise<VerifyMessageResult> {
  const topicId = (input.topicId || "").trim();
  if (!isValidTopicId(topicId)) {
    return {
      success: false,
      error: `Invalid Hedera topic id "${topicId}". Expected format: 0.0.<number>.`,
      errorClass: ExecutionErrorType.USER,
    };
  }

  const sequenceNumber = (input.sequenceNumber || "").trim();
  if (!/^\d{1,19}$/.test(sequenceNumber)) {
    return {
      success: false,
      error: `Invalid sequence number "${sequenceNumber}". Expected a positive integer.`,
      errorClass: ExecutionErrorType.USER,
    };
  }

  const network = resolveNetwork(input.network);
  if (!network) {
    return {
      success: false,
      error: `Unknown network "${input.network}". Use "testnet" or "mainnet".`,
      errorClass: ExecutionErrorType.USER,
    };
  }

  // Read-only public mirror query — an independent verification channel that
  // trusts only the Hedera network, not the node that submitted the message.
  // mirrorUrl was removed per review: a user-chosen host answering the
  // expected payload is the exact failure mode verified exists to prevent.
  const url = `${HEDERA_MIRROR_API[network]}/api/v1/topics/${encodeURIComponent(topicId)}/messages/${encodeURIComponent(sequenceNumber)}`;

  // SSRF guard: the mirror host is configuration-derived (never
  // user-supplied), so this is defense in depth — but assertUrlIsPublic is
  // always-on and blocks private/internal targets even under
  // SAFE_FETCH_SHADOW, where safeFetch alone would only log. Mirrors
  // plugins/blockscout/steps/blockscout-core.ts.
  try {
    await assertUrlIsPublic(url);
  } catch (error) {
    if (error instanceof SsrfBlockedError) {
      return {
        success: false,
        error: `Mirror URL is not allowed: ${error.message}`,
        errorClass: ExecutionErrorType.USER,
      };
    }
    throw error;
  }

  let status: number;
  let bodyText: string;
  try {
    const res = await safeFetch(url, {
      plugin: "hedera",
      method: "GET",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(MIRROR_TIMEOUT_MS),
    });
    status = res.status;
    bodyText = await res.text();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      error: `Mirror query failed: ${message.slice(0, 300)}`,
      errorClass: ExecutionErrorType.EXTERNAL,
    };
  }

  if (status === 404) {
    // The same 404 body covers "mistyped topic" and "no message at this
    // sequence", and the latter must stay a success so workflows can branch
    // on found=false. Disambiguate with one probe of the topic itself: only
    // an unknown topic is a USER error; a known topic with no message at
    // this sequence is found=false.
    let topicExists: boolean;
    try {
      topicExists = await probeTopicExists(topicId, network);
    } catch {
      topicExists = true;
    }
    if (!topicExists) {
      return {
        success: false,
        error: `Topic "${topicId}" does not exist on ${network}. Check the topic id.`,
        errorClass: ExecutionErrorType.USER,
      };
    }
    return {
      success: true,
      found: false,
      verified: false,
      message: null,
      consensusTimestamp: null,
      sequenceNumber,
    };
  }
  if (status >= 400) {
    return {
      success: false,
      error: `Mirror query returned HTTP ${status}.`,
      errorClass: ExecutionErrorType.EXTERNAL,
    };
  }

  let payload: MirrorMessage;
  try {
    payload = bodyText ? JSON.parse(bodyText) : {};
  } catch {
    return {
      success: false,
      error: "Mirror returned a non-JSON response.",
      errorClass: ExecutionErrorType.EXTERNAL,
    };
  }

  // Bind the answer to the question: without this check, any host (or a
  // cache serving a different sequence) could satisfy the lookup. found and
  // verified only mean anything if the mirror confirms it is describing the
  // topic and sequence that were requested.
  const payloadTopic =
    typeof payload.topic_id === "string"
      ? payload.topic_id.trim()
      : String(payload.topic_id ?? "").trim();
  const payloadSequence =
    payload.sequence_number != null ? String(payload.sequence_number) : "";
  if (payloadTopic !== topicId || payloadSequence !== sequenceNumber) {
    return {
      success: false,
      error: `Mirror response describes topic "${payloadTopic}" sequence "${payloadSequence}", but the step requested topic "${topicId}" sequence "${sequenceNumber}".`,
      errorClass: ExecutionErrorType.EXTERNAL,
    };
  }

  if (payload.chunk_info && payload.chunk_info.total != null && payload.chunk_info.total > 1) {
    // A chunked payload is one fragment here; comparing it against
    // expectedMessage would make verified permanently false while looking
    // like a clean mismatch. Fail loudly instead of gating a workflow on a
    // guarantee this step cannot make.
    return {
      success: false,
      error: `Message at sequence ${sequenceNumber} is chunked into ${payload.chunk_info.total} fragments across sequence numbers; this step verifies single-sequence messages only. Re-anchor without chunking (or fetch all fragments) and verify that.`,
      errorClass: ExecutionErrorType.USER,
    };
  }

  // found keys on the mirror's consensus_timestamp, not on the decoded
  // payload — an anchored empty message is still found.
  const found = payload.consensus_timestamp != null;

  let decoded: string | null = null;
  if (typeof payload.message === "string") {
    // An anchored empty message ("" base64) still decodes to "" — keep it:
    // found must distinguish "empty receipt" from "nothing at this seq".
    // Buffer.from discards invalid base64 rather than throwing, so a bad
    // payload falls out as replacement characters instead of an error.
    decoded = Buffer.from(payload.message, "base64").toString("utf8");
  }

  // Trim both sides: an anchored payload with a trailing newline, or an
  // expectedMessage rendered from a template with surrounding whitespace,
  // must not produce a silent verified=false — the docs promise a content
  // match, and both sides get the same normalization.
  const expected = (input.expectedMessage ?? "").trim();
  const expectedProvided = expected.length > 0;
  const verified = expectedProvided && found && decoded != null && decoded.trim() === expected;

  return {
    success: true,
    found,
    verified,
    message: decoded,
    consensusTimestamp: payload.consensus_timestamp ?? null,
    sequenceNumber: payloadSequence,
  };
}

export async function verifyMessageStep(
  input: VerifyMessageInput
): Promise<VerifyMessageResult> {
  "use step";

  return runPluginStep(
    { pluginName: "hedera", actionName: "verify-message" },
    input,
    () => stepHandler(input)
  );
}

export const _integrationType = "hedera";
