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
  isValidEntityId,
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
      payerAccountId: string | null;
      sequenceNumber: string;
    }
  | { success: false; error: string; errorClass?: ExecutionErrorType };

export type VerifyMessageCoreInput = {
  topicId: string;
  sequenceNumber: string;
  expectedMessage?: string;
  expectedSubmitter?: string;
  network?: string;
};

export type VerifyMessageInput = StepInput & VerifyMessageCoreInput;

// Two requests at most per run (message query, then a 404-only probe), so ~20s worst case.
const MIRROR_TIMEOUT_MS = 10_000;

// One un-fragmented HCS message carries ~1 KB of payload, so this leaves room
// for the mirror's envelope while bounding what one response can allocate.
const MAX_MIRROR_BODY_BYTES = 256 * 1024;

// HCS fragments an oversized submission into one message per sequence number;
// the mirror then returns chunk_info on each fragment instead of the full
// payload. Verify the un-fragmented case only.
// Every field is unknown because the mirror controls them: a declared type
// here would be an assumption the response is free to break.
type MirrorMessage = {
  message?: unknown;
  consensus_timestamp?: unknown;
  sequence_number?: unknown;
  topic_id?: unknown;
  payer_account_id?: unknown;
  chunk_info?: { total?: unknown };
  _status?: unknown;
};

// The mirror normalises numeric ids on the way out: it echoes topic
// 0.0.010590142 as "0.0.10590142" and sequence "01" as 1. Compare normalised
// forms so a zero-padded id (a template output, a spreadsheet cell) is not
// reported as the mirror answering about a different topic — that would
// fault the network for a formatting difference.
function stripLeadingZeros(value: string): string {
  return value.replace(/^0+(?=\d)/, "");
}

function normalizeTopicId(value: unknown): string {
  return String(value ?? "")
    .trim()
    .split(".")
    .map(stripLeadingZeros)
    .join(".");
}

function normalizeSequenceNumber(value: unknown): string {
  const text = String(value ?? "").trim();
  return /^\d+$/.test(text) ? stripLeadingZeros(text) : text;
}

// Account ids share the topic-id 0.0.<number> shape and the mirror echoes
// them normalised the same way (0.0.010585648 -> "0.0.10585648").
function normalizeAccountId(value: unknown): string {
  return normalizeTopicId(value);
}

type ProbeOutcome = "exists" | "missing" | "unconfirmed";

// On a message 404, one GET of the topic itself tells a mistyped topic id
// (USER error) apart from a real "nothing anchored at this sequence yet"
// (found=false) — the mirror returns the same 404 body for both.
async function probeTopicExists(
  topicId: string,
  network: HederaNetwork
): Promise<ProbeOutcome> {
  const url = `${HEDERA_MIRROR_API[network]}/api/v1/topics/${encodeURIComponent(topicId)}`;
  // Same always-on guard as the main query, but a resolution failure here is just unconfirmed.
  try {
    await assertUrlIsPublic(url);
  } catch (error) {
    if (error instanceof SsrfBlockedError) throw error;
    return "unconfirmed";
  }
  try {
    const res = await safeFetch(url, {
      plugin: "hedera",
      method: "GET",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(MIRROR_TIMEOUT_MS),
    });
    if (res.status === 404) return "missing";
    if (res.ok) return "exists";
  } catch {
    // A probe that cannot complete (timeout, DNS, connection) is "could not
    // confirm", not "exists": reporting it as exists would make a workflow
    // poll a topic that may not exist forever as found=false.
  }
  return "unconfirmed";
}

async function stepHandler(
  input: VerifyMessageCoreInput
): Promise<VerifyMessageResult> {
  const topicId = (input.topicId || "").trim();
  if (!isValidEntityId(topicId)) {
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

  // An expected submitter is optional but is what turns the result from
  // "these bytes are at this topic and sequence" into "the configured account
  // wrote them" — on a topic without a submit key, any funded account can
  // write matching bytes, so workflows gating a payment on verified must set
  // it. Validated here, before any request, so a typo fails fast instead of
  // producing a silent verified=false forever.
  const expectedSubmitter = (input.expectedSubmitter ?? "").trim();
  if (expectedSubmitter.length > 0 && !isValidEntityId(expectedSubmitter)) {
    return {
      success: false,
      error: `Invalid expected submitter "${expectedSubmitter}". Expected format: 0.0.<number>.`,
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
    // Not an SSRF block (a DNS resolution failure), so the mirror is unreachable.
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      error: `Mirror query failed: ${message.slice(0, 300)}`,
      errorClass: ExecutionErrorType.EXTERNAL,
    };
  }

  let status: number;
  let bodyText: string;
  try {
    const res = await safeFetch(url, {
      plugin: "hedera",
      method: "GET",
      // Identity encoding so the declared length below counts the bytes that
      // actually get allocated, not a compressed wire size.
      headers: { Accept: "application/json", "Accept-Encoding": "identity" },
      signal: AbortSignal.timeout(MIRROR_TIMEOUT_MS),
    });
    status = res.status;
    // Declared size first, so an oversized body is refused before it becomes a
    // string; a missing or unparseable header reads as NaN and falls through to
    // the length check, which bounds what is parsed.
    const declaredBytes = Number(res.headers.get("content-length"));
    if (Number.isFinite(declaredBytes) && declaredBytes > MAX_MIRROR_BODY_BYTES) {
      return {
        success: false,
        error: `Mirror declared a ${declaredBytes} byte body, over the ${MAX_MIRROR_BODY_BYTES} byte limit for one HCS message.`,
        errorClass: ExecutionErrorType.EXTERNAL,
      };
    }
    bodyText = await res.text();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      error: `Mirror query failed: ${message.slice(0, 300)}`,
      errorClass: ExecutionErrorType.EXTERNAL,
    };
  }

  if (bodyText.length > MAX_MIRROR_BODY_BYTES) {
    return {
      success: false,
      error: `Mirror returned a ${bodyText.length} character body, over the ${MAX_MIRROR_BODY_BYTES} character limit for one HCS message.`,
      errorClass: ExecutionErrorType.EXTERNAL,
    };
  }

  if (status === 404) {
    // The same 404 body covers "mistyped topic" and "no message at this
    // sequence", and the latter must stay a success so workflows can branch
    // on found=false. Disambiguate with one probe of the topic itself: only
    // an unknown topic is a USER error; a known topic with no message at
    // this sequence is found=false.
    // An SsrfBlockedError from the probe's guard escapes as it does above.
    const probe = await probeTopicExists(topicId, network);
    if (probe === "missing") {
      return {
        success: false,
        error: `Topic "${topicId}" does not exist on ${network}. Check the topic id.`,
        errorClass: ExecutionErrorType.USER,
      };
    }
    if (probe === "unconfirmed") {
      // "Could not confirm the topic" is a different fact from "the topic
      // does not exist": guessing either way breaks a caller. Pretending it
      // exists makes a workflow poll a possibly-mistyped topic as found=false
      // forever; failing with an EXTERNAL class blames the mirror, not the
      // user's config, and a polling workflow simply retries.
      return {
        success: false,
        error: `Could not confirm topic "${topicId}" on ${network}: the message query returned 404 and the topic probe failed. Retry the step; if the topic id is wrong this will persist.`,
        errorClass: ExecutionErrorType.EXTERNAL,
      };
    }
    return {
      success: true,
      found: false,
      verified: false,
      message: null,
      consensusTimestamp: null,
      payerAccountId: null,
      sequenceNumber: normalizeSequenceNumber(sequenceNumber),
    };
  }
  if (status === 429 || status >= 500) {
    // Rate limiting and server faults are the mirror's problem.
    return {
      success: false,
      error: `Mirror query returned HTTP ${status}.`,
      errorClass: ExecutionErrorType.EXTERNAL,
    };
  }
  if (status >= 400) {
    // The request URL is built entirely from validated inputs, so any other
    // 4xx (e.g. 400 on a 19-digit topic id or a zero sequence) is the mirror
    // rejecting this caller's parameters — a configuration fault, not load.
    return {
      success: false,
      error: `Mirror rejected the request (HTTP ${status}). Check the topic id and sequence number.`,
      errorClass: ExecutionErrorType.USER,
    };
  }

  let parsed: unknown;
  try {
    parsed = bodyText ? JSON.parse(bodyText) : {};
  } catch {
    return {
      success: false,
      error: "Mirror returned a non-JSON response.",
      errorClass: ExecutionErrorType.EXTERNAL,
    };
  }

  // JSON null, an array or a scalar parse cleanly but carry no message fields.
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      success: false,
      error: "Mirror returned a JSON body that is not a message object.",
      errorClass: ExecutionErrorType.EXTERNAL,
    };
  }
  const payload = parsed as MirrorMessage;

  // The mirror's error envelope. On a 2xx it means the response carries a
  // fault, not a message, and it has no topic echo for the check below.
  if (payload._status != null) {
    return {
      success: false,
      error: `Mirror answered HTTP ${status} with an error envelope instead of a message.`,
      errorClass: ExecutionErrorType.EXTERNAL,
    };
  }

  // Bind the answer to the question: without this check, any host (or a
  // cache serving a different sequence) could satisfy the lookup. found and
  // verified only mean anything if the mirror confirms it is describing the
  // topic and sequence that were requested.
  const payloadTopic = normalizeTopicId(payload.topic_id);
  const payloadSequence = normalizeSequenceNumber(payload.sequence_number);
  if (
    payloadTopic !== normalizeTopicId(topicId) ||
    payloadSequence !== normalizeSequenceNumber(sequenceNumber)
  ) {
    return {
      success: false,
      error: `Mirror response describes topic "${payloadTopic}" sequence "${payloadSequence}", but the step requested topic "${topicId}" sequence "${sequenceNumber}".`,
      errorClass: ExecutionErrorType.EXTERNAL,
    };
  }

  // chunk_info is absent or null on an un-fragmented message; once the mirror
  // reports it, the total is the only thing that says whether these are all
  // the anchored bytes.
  if (payload.chunk_info != null) {
    const chunkTotal = payload.chunk_info.total;
    if (typeof chunkTotal !== "number" || !Number.isFinite(chunkTotal)) {
      // Without a readable total there is no way to tell a whole payload from
      // a fragment, so the content comparison below cannot be trusted.
      return {
        success: false,
        error:
          "Mirror reported a chunk total that is not a number, so the payload cannot be confirmed un-fragmented.",
        errorClass: ExecutionErrorType.EXTERNAL,
      };
    }
    if (chunkTotal > 1) {
      // A chunked payload is one fragment here; comparing it against
      // expectedMessage would make verified permanently false while looking
      // like a clean mismatch. Fail loudly instead of gating a workflow on a
      // guarantee this step cannot make.
      return {
        success: false,
        error: `Message at sequence ${sequenceNumber} is chunked into ${chunkTotal} fragments across sequence numbers; this step verifies single-sequence messages only. Re-anchor without chunking (or fetch all fragments) and verify that.`,
        errorClass: ExecutionErrorType.USER,
      };
    }
  }

  if (
    payload.consensus_timestamp != null &&
    typeof payload.consensus_timestamp !== "string"
  ) {
    // found and the reported timestamp both key on this field, so a non-string
    // would publish a value the result type promises is a string.
    return {
      success: false,
      error: "Mirror returned a consensus timestamp that is not a string.",
      errorClass: ExecutionErrorType.EXTERNAL,
    };
  }

  // found keys on the mirror's consensus_timestamp, not on the decoded
  // payload — an anchored empty message is still found.
  const consensusTimestamp = payload.consensus_timestamp ?? null;
  const found = consensusTimestamp != null;

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

  // The mirror records which account paid for (submitted) each message.
  // Content alone proves these bytes sit at this topic and sequence, not who
  // wrote them — on an open topic any funded account can write matching
  // bytes — so verified is content AND submitter, with the submitter leg
  // active only when the workflow author configures expectedSubmitter.
  const payerAccountId =
    typeof payload.payer_account_id === "string" &&
    payload.payer_account_id.trim().length > 0
      ? payload.payer_account_id.trim()
      : null;
  const submitterProvided = expectedSubmitter.length > 0;
  const submitterMatches =
    !submitterProvided ||
    (payerAccountId != null &&
      normalizeAccountId(payerAccountId) ===
        normalizeAccountId(expectedSubmitter));
  const verified =
    expectedProvided && found && decoded != null && decoded.trim() === expected && submitterMatches;

  return {
    success: true,
    found,
    verified,
    message: decoded,
    consensusTimestamp,
    payerAccountId,
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
