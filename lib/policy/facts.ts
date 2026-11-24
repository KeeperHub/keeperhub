/**
 * Turning an action and its resolved configuration into policy facts.
 *
 * This is the layer that decides what a policy can actually see, so a missed
 * field here means rules silently do not apply to that action, with no error
 * anywhere. Every extractor therefore reports what it could NOT determine
 * rather than defaulting to a value, which is why facts are three-valued.
 *
 * Adding a write-capable action without an extractor is the failure mode to
 * guard against: `extractFacts` falls back to a shape where nothing is known,
 * so such an action cannot satisfy an allow and is refused inside any scope
 * that claims it. That is deliberately noisy rather than quietly permissive.
 */

import { ethers } from "ethers";
import { buildAssetArn, buildContractCallArn } from "./arn";
import { Capability } from "./capabilities";
import { capabilityForWriteVerb } from "./capability-verbs";
import { FactProvenance, FactState } from "./constants";
import type { CounterpartyFact, Fact, PolicyFacts } from "./types";

/** Action types map to exactly one capability. */
export const ACTION_CAPABILITY: Readonly<Record<string, Capability>> = {
  "web3/transfer-funds": Capability.ASSET_TRANSFER_NATIVE,
  "web3/transfer-token": Capability.ASSET_TRANSFER_TOKEN,
  "web3/transfer-spl-token": Capability.ASSET_TRANSFER_TOKEN,
  "web3/approve-token": Capability.ASSET_APPROVE,
  "web3/write-contract": Capability.CONTRACT_WRITE,
  "web3/batch-write-contract": Capability.CONTRACT_WRITE,
  "web3/read-contract": Capability.CONTRACT_READ,
  "web3/sign-typed-data": Capability.ASSET_PERMIT,
  "web3/send-raw-solana-instruction": Capability.CONTRACT_WRITE,
  "web3/call-solana-program-anchor": Capability.CONTRACT_WRITE,
  "webhook/send-webhook": Capability.OFFCHAIN_HTTP,
  "HTTP Request": Capability.OFFCHAIN_HTTP,
  "Database Query": Capability.DATA_QUERY,
  "discord/send-message": Capability.OFFCHAIN_NOTIFY,
  "slack/send-slack-message": Capability.OFFCHAIN_NOTIFY,
  "telegram/send-message": Capability.OFFCHAIN_NOTIFY,
  "sendgrid/send-email": Capability.OFFCHAIN_NOTIFY,
  "resend/send-email": Capability.OFFCHAIN_NOTIFY,
};
/**
 * Reads, recognised before writes.
 *
 * Order matters more than it looks. "pool1-deposit-index" reads an index and
 * "vault-max-deposit" reads a ceiling, yet both contain "deposit". Classifying
 * on the write verb first would file them as supplies and let a spending rule
 * fire on a read, so a read is identified first and everything else falls
 * through to the write verbs.
 */
const READ_PATTERNS: readonly RegExp[] = [
  /\/(get|check|list|query|read|calc|preview|fetch|is|has)-/,
  /-(preview|max|total|min)-/,
  /-(info|rate|balance|limit|index|separator|cabinet|status|owners|supply|amount|price|decimals|symbol|allowance|nonce)$/,
  /\/total-/,
];

/** Whether an action only reads. Shared with the coverage test so the two agree. */
export function isReadAction(actionType: string): boolean {
  return READ_PATTERNS.some((pattern) => pattern.test(actionType));
}

/**
 * The capability an action exercises, or null when it has no policy meaning.
 *
 * A write-capable action returning null would be invisible to every rule, so
 * the coverage test fails the build on one rather than letting it pass unseen.
 */
export function capabilityForAction(actionType: string): Capability | null {
  const direct = ACTION_CAPABILITY[actionType];
  if (direct) {
    return direct;
  }
  if (isReadAction(actionType)) {
    return Capability.CONTRACT_READ;
  }
  const verb = capabilityForWriteVerb(actionType);
  if (verb) {
    return verb;
  }
  // A protocol action naming no recognised verb still writes to a contract, so
  // it is governed as a contract write rather than left ungoverned.
  if (actionType.includes("/") && !actionType.startsWith("web3/")) {
    return Capability.CONTRACT_WRITE;
  }
  return null;
}

const UNKNOWN = { state: FactState.UNKNOWN } as const;

/**
 * Addresses a call sends value to, with the role each plays.
 *
 * The role matters: "may approve this spender" and "may send to this recipient"
 * are different rules, and a spender read as a recipient would satisfy the
 * wrong one.
 */
function readCounterparties(
  config: Record<string, unknown>
): CounterpartyFact[] {
  const out: CounterpartyFact[] = [];
  const recipient =
    str(config, "recipientAddress") ??
    str(config, "toAddress") ??
    str(config, "to");
  const spender = str(config, "spenderAddress") ?? str(config, "spender");
  if (recipient) {
    out.push({ address: recipient.toLowerCase(), role: "recipient" });
  }
  if (spender) {
    out.push({ address: spender.toLowerCase(), role: "spender" });
  }
  return out;
}

/**
 * What an outbound HTTP call targets.
 *
 * The host is parsed out separately because that is what a domain rule reads: a
 * rule blocking "*.internal.corp" should not have to match on a full URL, and a
 * URL that will not parse yields no host, which makes a deny about hosts fire.
 */
function httpFacts(
  config: Record<string, unknown>
): Pick<PolicyFacts, "httpHost" | "httpUrl" | "httpMethod"> {
  const url = str(config, "url") ?? str(config, "endpoint");
  const method = str(config, "method");
  let host: string | undefined;
  if (url) {
    try {
      host = new URL(url).hostname;
    } catch {
      // An unresolved template, or a malformed address. Left unknown so a rule
      // about hosts refuses rather than reading the wrong one.
      host = undefined;
    }
  }
  return {
    httpHost: fromConfig(host),
    httpUrl: fromConfig(url),
    httpMethod: fromConfig(method?.toUpperCase()),
  };
}

/** Capabilities whose amount is denominated in the chain's own currency. */
const NATIVE_VALUE_CAPABILITIES: readonly Capability[] = [
  Capability.ASSET_TRANSFER_NATIVE,
];

/**
 * The native amount a node moves, in wei.
 *
 * Only for actions that move native value: a token transfer's `amount` is
 * denominated in that token, and reading it as wei would compare a USDC figure
 * against an ether ceiling.
 */
function nativeAmountWei(
  capability: Capability,
  config: Record<string, unknown>
): string | null {
  const raw = str(config, "amount") ?? str(config, "ethValue");
  if (!(raw && NATIVE_VALUE_CAPABILITIES.includes(capability))) {
    return null;
  }
  try {
    return ethers.parseEther(raw).toString();
  } catch {
    // A template that has not resolved, or a malformed figure. Leaving it
    // unknown makes a limit refuse rather than read a wrong number.
    return null;
  }
}
const ABSENT = { state: FactState.ABSENT } as const;

/**
 * A value read from a resolved node config.
 *
 * Provenance is WORKFLOW_DERIVED throughout: a node's configuration is
 * whatever the workflow put there, possibly via a template fed by an upstream
 * response. The grant layer promotes it to authoritative once a held grant
 * vouches for it; nothing here may do so.
 */
function fromConfig<T>(value: T | undefined | null): Fact<T> {
  if (value === undefined || value === null || value === "") {
    return ABSENT;
  }
  return {
    state: FactState.KNOWN,
    value,
    provenance: FactProvenance.WORKFLOW_DERIVED,
  };
}

function str(config: Record<string, unknown>, key: string): string | undefined {
  const raw = config[key];
  return typeof raw === "string" && raw.trim() !== "" ? raw : undefined;
}

export type ExtractInput = {
  actionType: string;
  config: Record<string, unknown>;
  chainId?: number;
  /** Derived from the ABI at dispatch when available. */
  selector?: string;
  triggerType?: string;
  workflowId?: string;
};

/**
 * Build the fact set for one node.
 *
 * Anything that cannot be determined stays UNKNOWN rather than being guessed,
 * because an allow will not match on unknown and a deny will. Guessing here
 * would quietly move the fail-closed line.
 */
export function extractFacts(input: ExtractInput): PolicyFacts {
  const capability =
    capabilityForAction(input.actionType) ?? Capability.CONTRACT_WRITE;
  const { config } = input;

  const contractAddress =
    str(config, "contractAddress") ?? str(config, "programId");
  const tokenAddress = str(config, "tokenAddress") ?? str(config, "mint");
  const recipient =
    str(config, "recipientAddress") ?? str(config, "spenderAddress");

  let resource: Fact<string> = UNKNOWN;
  if (input.chainId !== undefined && contractAddress) {
    resource = {
      state: FactState.KNOWN,
      value: buildContractCallArn({
        chainId: input.chainId,
        contractAddress,
        selector: input.selector ?? null,
      }),
      provenance: FactProvenance.WORKFLOW_DERIVED,
    };
  } else if (input.chainId !== undefined && tokenAddress) {
    resource = {
      state: FactState.KNOWN,
      value: buildAssetArn({
        chainId: input.chainId,
        tokenAddress,
      }),
      provenance: FactProvenance.WORKFLOW_DERIVED,
    };
  }

  const amount = str(config, "amount") ?? str(config, "ethValue");
  // "max" on an approval is the unbounded case, and it is worth naming rather
  // than letting it read as an ordinary amount.
  const unbounded =
    capability === Capability.ASSET_APPROVE && amount?.toLowerCase() === "max";

  const nativeWei = nativeAmountWei(capability, config);
  const counterparties = readCounterparties(config);

  return {
    capability,
    resource,
    chainId:
      input.chainId === undefined
        ? UNKNOWN
        : {
            state: FactState.KNOWN,
            value: input.chainId,
            provenance: FactProvenance.AUTHORITATIVE,
          },
    contractAddress: fromConfig(contractAddress?.toLowerCase()),
    selector: input.selector
      ? {
          state: FactState.KNOWN,
          value: input.selector,
          provenance: FactProvenance.AUTHORITATIVE,
        }
      : UNKNOWN,
    protocolSlug: fromConfig(input.actionType.split("/")[0]),
    // A rule naming an asset or a counterparty is the commonest kind there is,
    // so leaving these unread made those rules refuse every action rather than
    // govern it.
    assets: tokenAddress
      ? {
          state: FactState.KNOWN,
          value: [{ address: tokenAddress.toLowerCase(), amount }],
          provenance: FactProvenance.WORKFLOW_DERIVED,
        }
      : UNKNOWN,
    counterparties:
      counterparties.length > 0
        ? {
            state: FactState.KNOWN,
            value: counterparties,
            provenance: FactProvenance.WORKFLOW_DERIVED,
          }
        : UNKNOWN,
    // The native amount needs no oracle: it is the value field on the node.
    // Reading it here is what lets a rule cap a transfer in the chain's own
    // currency without any price being involved.
    nativeValueWei: nativeWei
      ? {
          state: FactState.KNOWN,
          value: nativeWei,
          provenance: FactProvenance.WORKFLOW_DERIVED,
        }
      : UNKNOWN,
    // Pricing needs an oracle read, which does not belong in a pure extractor.
    // Leaving it unknown means a USD limit refuses rather than passes, which is
    // the correct direction until the pricing step is wired in.
    usdValue: UNKNOWN,
    unbounded:
      unbounded === undefined
        ? UNKNOWN
        : {
            state: FactState.KNOWN,
            value: unbounded,
            provenance: FactProvenance.WORKFLOW_DERIVED,
          },
    gasPriceGwei: fromConfig(
      str(config, "gasPriceGwei") ?? str(config, "maxFeePerGas")
    ),
    gasLimit: fromConfig(str(config, "gasLimit")),
    signerMode: fromConfig(str(config, "web3Connection")),
    triggerType: input.triggerType
      ? {
          state: FactState.KNOWN,
          value: input.triggerType,
          provenance: FactProvenance.AUTHORITATIVE,
        }
      : UNKNOWN,
    workflowId: input.workflowId
      ? {
          state: FactState.KNOWN,
          value: input.workflowId,
          provenance: FactProvenance.AUTHORITATIVE,
        }
      : UNKNOWN,
    workflowTags: UNKNOWN,
    projectId: UNKNOWN,
    sourceIp: UNKNOWN,
    ...httpFacts(config),
    resourceId: fromConfig(recipient?.toLowerCase()),
  };
}
