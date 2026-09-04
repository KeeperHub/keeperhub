import "server-only";

import { and, eq } from "drizzle-orm";
import { ethers } from "ethers";
import { db } from "@/lib/db";
import { safeWallets, supportedTokens } from "@/lib/db/schema";
import {
  getDefaultBatchStablecoinCapMicroUsd,
  getDefaultStablecoinTransferCapMicroUsd,
} from "@/lib/execute/spend-cap-defaults";
import { logSecurityEvent } from "@/lib/logging";
import { getRegisteredProtocols } from "@/lib/protocol-registry";
import { getOrganizationWalletAddress } from "@/lib/web3/wallet-helpers";
// Registration is an import side effect: a protocol module calls
// registerProtocol at load. Without this import the registry is whatever the
// entry point happened to pull in, and of the execute routes only
// app/api/execute/[...slug]/route.ts imports the barrel -- so contract-call,
// transfer, node, swap, check-and-execute and the web3 write-contract step all
// saw an EMPTY allowlist and refused every over-cap approval, including the
// max-uint-before-swap that protocol integrations depend on.
import "@/protocols";

const MICRO_USD_DECIMALS = 6;

/**
 * The ceiling either admits a call or refuses it, and the reason travels in
 * `error` rather than in the tag.
 *
 * This deliberately does not split "malformed" from "over the cap". The split
 * existed so a route could answer 400 rather than 403, but no route reads it:
 * the check runs inside the step cores, which return a uniform
 * `{ success: false, error }` that every entrance surfaces as a 202 with
 * status "failed". Nothing maps a decision to a status code, so the
 * distinction described behaviour that did not exist.
 *
 * Reintroducing it needs the mapping first -- a route-level translation from
 * refusal class to status -- not a wider union here.
 */
export type StablecoinCapDecision =
  | { kind: "allowed" }
  | { kind: "denied"; error: string };

const ALLOWED = { kind: "allowed" } as const;

const DECIMAL_INTEGER_RE = /^-?\d+$/;
const HEX_INTEGER_RE = /^0x[0-9a-fA-F]+$/;
const HEX_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * The token entry points that let value leave the org's wallet. `transfer` and
 * `transferFrom` move tokens now; `approve` hands a third party the standing
 * right to move them later. The `WithMemo` pair is TIP-20 (Tempo), where they
 * are the ordinary way to send: the memo rides along and the amount sits one
 * argument earlier than in the ERC-20 forms.
 */
const ERC20_OUTFLOW_ABI = [
  "function transfer(address to, uint256 amount)",
  "function transferFrom(address from, address to, uint256 amount)",
  "function approve(address spender, uint256 amount)",
  "function transferWithMemo(address to, uint256 amount, bytes32 memo)",
  "function transferFromWithMemo(address from, address to, uint256 amount, bytes32 memo)",
] as const;

let cachedErc20Interface: ethers.Interface | null = null;

// Built on first use, not at module load: this module is imported by the
// workflow step cores, and constructing an Interface eagerly would make merely
// importing them depend on ethers being fully initialised.
function getErc20Interface(): ethers.Interface {
  cachedErc20Interface ??= new ethers.Interface(ERC20_OUTFLOW_ABI);
  return cachedErc20Interface;
}

function isHexAddress(value: string): boolean {
  return HEX_ADDRESS_RE.test(value);
}

type OutflowFn =
  | "transfer"
  | "transferFrom"
  | "approve"
  | "transferWithMemo"
  | "transferFromWithMemo";

type OutflowShape = {
  inputTypes: readonly string[];
  // Which argument carries the amount. Not always the last one: the TIP-20
  // memo variants append a bytes32 after it.
  amountIndex: number;
};

const OUTFLOW_SHAPES: Readonly<Record<OutflowFn, OutflowShape>> = {
  transfer: { inputTypes: ["address", "uint256"], amountIndex: 1 },
  transferFrom: {
    inputTypes: ["address", "address", "uint256"],
    amountIndex: 2,
  },
  approve: { inputTypes: ["address", "uint256"], amountIndex: 1 },
  transferWithMemo: {
    inputTypes: ["address", "uint256", "bytes32"],
    amountIndex: 1,
  },
  transferFromWithMemo: {
    inputTypes: ["address", "address", "uint256", "bytes32"],
    amountIndex: 2,
  },
};

/**
 * Functions whose first argument names the payer rather than the payee.
 *
 * `transfer` and `approve` always move or grant from the caller, which is the
 * org wallet. `transferFrom` does not: it moves from whoever the first
 * argument names, and the org may just be the one submitting the transaction.
 */
const PAYER_IS_FIRST_ARG: ReadonlySet<OutflowFn> = new Set([
  "transferFrom",
  "transferFromWithMemo",
]);

/**
 * Every address the organization can move funds FROM on this chain: its EOA
 * wallet plus any Safe it controls there.
 *
 * The EOA alone is not enough. A `transferFrom` naming a Safe as payer would
 * compare unequal, read as an inbound collection and skip the ceiling. That is
 * not a live drain in the ordinary case -- pulling from your own balance needs
 * `allowance[safe][safe]`, which is zero -- but it becomes one where a Safe has
 * approved the org EOA as a spender, and the reasoning that makes it safe
 * otherwise rests on a fact about allowances rather than on anything this
 * module checks. Cheaper to include the Safes than to depend on that.
 *
 * Returns an empty set if neither lookup succeeds, which callers treat as
 * fail-closed: an unattributable payer stays subject to the ceiling.
 */
async function resolveOrgPayers(
  organizationId: string,
  chainId: number
): Promise<Set<string>> {
  const [wallet, safes] = await Promise.all([
    getOrganizationWalletAddress(organizationId).catch(() => null),
    db
      .select({ safeAddress: safeWallets.safeAddress })
      .from(safeWallets)
      .where(
        and(
          eq(safeWallets.organizationId, organizationId),
          eq(safeWallets.chainId, chainId)
        )
      )
      .catch(() => [] as { safeAddress: string }[]),
  ]);

  const payers = new Set<string>();
  if (wallet) {
    payers.add(wallet.toLowerCase());
  }
  for (const safe of safes) {
    payers.add(safe.safeAddress.toLowerCase());
  }
  return payers;
}

/**
 * Whether this call actually moves value OUT of the organization.
 *
 * A pull payment is a `transferFrom` where the payer is a counterparty and the
 * org is collecting: value moves in, nothing leaves. Treating that as an
 * outflow refused legitimate collections above the ceiling -- a 500 USDC
 * invoice settlement read as a 500 USDC drain.
 *
 * Fails closed: an empty payer set means neither lookup resolved, and the call
 * stays subject to the ceiling rather than being waved through on a db error.
 */
function movesOrgFunds(
  fn: OutflowFn,
  payer: string | undefined,
  payers: ReadonlySet<string>
): boolean {
  if (!(PAYER_IS_FIRST_ARG.has(fn) && typeof payer === "string")) {
    return true;
  }
  if (payers.size === 0) {
    return true;
  }
  return payers.has(payer.toLowerCase());
}

type StablecoinToken = { decimals: number; symbol: string };

/**
 * Bound the stablecoin value a single call can move out of the org's wallet.
 *
 * The daily value cap counts NATIVE value only: an ERC-20 call carries a
 * `value` of 0, so a token move reserves 0 against it and a leaked key could
 * move an unbounded amount of USDC while the cap read zero. Pricing arbitrary
 * ERC-20s needs an oracle in the pre-broadcast path, but stablecoins do not:
 * their decimals are recorded in `supported_tokens` and the peg is ~1:1, so the
 * amount converts to USD by rescaling alone.
 *
 * Only tokens the registry knows AND flags as a stablecoin are bounded. An
 * unrecognised token address passes through -- that is the general ERC-20 case,
 * which this deliberately does not attempt to price.
 *
 * The checks live in the shared cores (transferTokenCore, writeContractCore,
 * signTempoTx) rather than in any one route, so every entrance reaches them:
 * /api/execute/transfer, /api/execute/contract-call, /api/execute/[...slug],
 * /api/execute/check-and-execute, /api/execute/node, and the workflow steps
 * those cores back. A ceiling on one route would only have told an attacker
 * which door to use.
 */

/** Human-decimal amount, e.g. "250.5", as the transfer-token path supplies it. */
export async function checkStablecoinTransferAmount(params: {
  organizationId: string;
  chainId: number;
  tokenAddress: string;
  amount: string;
  context: string;
}): Promise<StablecoinCapDecision> {
  const token = await loadStablecoin(params.chainId, params.tokenAddress);
  if (!token) {
    return ALLOWED;
  }

  let amountBase: bigint;
  try {
    amountBase = ethers.parseUnits(params.amount, token.decimals);
  } catch {
    return {
      kind: "denied",
      error: `Invalid ${token.symbol} amount: ${params.amount}`,
    };
  }

  return decide({ ...params, token, amountBase, fn: "transfer" });
}

/**
 * A decoded contract call, as `writeContractCore` has it: an ABI function plus
 * already-coerced argument values.
 */
export async function checkStablecoinContractCall(params: {
  organizationId: string;
  chainId: number;
  contractAddress: string;
  functionName: string;
  inputTypes: readonly string[];
  args: readonly unknown[];
  context: string;
}): Promise<StablecoinCapDecision> {
  const fn = matchOutflowFunction(params.functionName, params.inputTypes);
  if (!fn) {
    return ALLOWED;
  }

  const token = await loadStablecoin(params.chainId, params.contractAddress);
  if (!token) {
    return ALLOWED;
  }

  const amountBase = toBaseUnits(params.args[OUTFLOW_SHAPES[fn].amountIndex]);
  if (amountBase === null) {
    // The call is a stablecoin outflow whose size cannot be read. Passing it
    // through would be an unbounded move, so refuse instead.
    return {
      kind: "denied",
      error: `Could not read the ${token.symbol} amount from the ${fn} arguments`,
    };
  }

  const firstArg =
    typeof params.args[0] === "string" ? params.args[0] : undefined;
  if (
    PAYER_IS_FIRST_ARG.has(fn) &&
    !movesOrgFunds(
      fn,
      firstArg,
      await resolveOrgPayers(params.organizationId, params.chainId)
    )
  ) {
    return ALLOWED;
  }

  return decide({
    ...params,
    // Argument 0 is the spender for approve and the payer for transferFrom.
    // The allowlist check in decide() needs it from this entry point too, not
    // just the calldata one.
    spender: firstArg,
    tokenAddress: params.contractAddress,
    token,
    amountBase,
    fn,
  });
}

/**
 * Raw calldata, as the Tempo path has it: Tempo transactions carry a list of
 * `{ to, data }` calls with no ABI alongside, and TIP-20 stablecoins are the
 * chain's primary asset.
 */
export async function checkStablecoinCalldata(params: {
  organizationId: string;
  chainId: number;
  to: string;
  data: string;
  context: string;
}): Promise<StablecoinCapDecision> {
  const decoded = decodeErc20Outflow(params.data);
  if (!decoded) {
    return ALLOWED;
  }

  const token = await loadStablecoin(params.chainId, params.to);
  if (!token) {
    return ALLOWED;
  }

  if (
    PAYER_IS_FIRST_ARG.has(decoded.fn) &&
    !movesOrgFunds(
      decoded.fn,
      decoded.spender,
      await resolveOrgPayers(params.organizationId, params.chainId)
    )
  ) {
    return ALLOWED;
  }

  return decide({
    ...params,
    tokenAddress: params.to,
    token,
    amountBase: decoded.amountBase,
    fn: decoded.fn,
    spender: decoded.spender,
  });
}

/**
 * Apply the ceiling to a batch of calls signed as ONE transaction.
 *
 * Checking each call on its own is not equivalent. A Tempo batch payout builds
 * one call per recipient, so ten entries of 99 USD each clear a 100 USD ceiling
 * individually while the transaction moves 990 USD, and nothing bounds the
 * entry count. The transaction is the unit the wallet signs, so it is the unit
 * the ceiling has to measure.
 *
 * Outflows are summed across every recognised stablecoin in the batch and
 * compared once. Summing across different tokens is deliberate: the ceiling is
 * denominated in USD and every token it recognises is pegged 1:1, so a batch
 * splitting value across two stablecoins moves exactly as much as one that does
 * not.
 *
 * Approvals are evaluated individually rather than folded into that sum. An
 * approval is a standing grant, not a movement, so adding it to a transfer
 * total would compare two different things.
 */
export async function checkStablecoinCalldataBatch(params: {
  organizationId: string;
  chainId: number;
  context: string;
  calls: readonly { to: string; data: string }[];
}): Promise<StablecoinCapDecision> {
  let totalMicroUsd = BigInt(0);
  let outflowSymbol: string | null = null;

  // One read for the whole batch. Every call in a transaction shares a chain,
  // so resolving each token separately meant N identical queries.
  const chainTokens = await loadChainTokens(params.chainId);
  let orgPayers: Set<string> | undefined;

  for (const call of params.calls) {
    const decoded = decodeErc20Outflow(call.data);
    if (!decoded) {
      continue;
    }
    const token = isHexAddress(call.to)
      ? matchStablecoin(chainTokens, call.to)
      : null;
    if (!token) {
      continue;
    }

    if (decoded.fn === "approve") {
      const decision = decide({
        organizationId: params.organizationId,
        chainId: params.chainId,
        context: params.context,
        tokenAddress: call.to,
        token,
        amountBase: decoded.amountBase,
        fn: decoded.fn,
        spender: decoded.spender,
      });
      if (decision.kind !== "allowed") {
        return decision;
      }
      continue;
    }

    if (PAYER_IS_FIRST_ARG.has(decoded.fn)) {
      // Resolved once for the whole batch, and only when a call actually needs
      // it. Doing it per call reintroduced an N+1 in the same loop the
      // token-list hoist above just removed.
      orgPayers ??= await resolveOrgPayers(
        params.organizationId,
        params.chainId
      );
      if (!movesOrgFunds(decoded.fn, decoded.spender, orgPayers)) {
        // An inbound collection inside a batch is not org value leaving.
        continue;
      }
    }

    if (decoded.amountBase < BigInt(0)) {
      return {
        kind: "denied",
        error: `${token.symbol} amount must not be negative`,
      };
    }

    // Every entry is still bounded on its own. Summing alone would let one
    // large recipient hide under a generous batch total.
    const perCall = decide({
      organizationId: params.organizationId,
      chainId: params.chainId,
      context: params.context,
      tokenAddress: call.to,
      token,
      amountBase: decoded.amountBase,
      fn: decoded.fn,
      spender: decoded.spender,
    });
    if (perCall.kind !== "allowed") {
      return perCall;
    }

    totalMicroUsd += rescaleToMicroUsd(decoded.amountBase, token.decimals);
    outflowSymbol ??= token.symbol;
  }

  // The transaction total, on its own figure. The per-call ceiling above
  // bounds any single recipient; this bounds what the whole transaction moves,
  // so neither one 990 USD entry nor fifty 100 USD entries get through.
  return compareAgainstCap({
    microUsd: totalMicroUsd,
    capMicroUsd: BigInt(getDefaultBatchStablecoinCapMicroUsd()),
    blocked: true,
    verb: "transfer",
    unit: `${outflowSymbol ?? "USD"} across ${params.calls.length} call(s)`,
    limit: "per-transaction batch limit",
    event: {
      organizationId: params.organizationId,
      surface: params.context,
      chainId: params.chainId,
      erc20Function: "batch",
      callCount: params.calls.length,
    },
  });
}

function decide(params: {
  organizationId: string;
  chainId: number;
  tokenAddress: string;
  token: StablecoinToken;
  amountBase: bigint;
  fn: OutflowFn;
  context: string;
  /** First argument of the call: the spender for approve, else the recipient. */
  spender?: string;
}): StablecoinCapDecision {
  const { token, amountBase, fn } = params;

  if (amountBase < BigInt(0)) {
    return {
      kind: "denied",
      error: `${token.symbol} amount must not be negative`,
    };
  }

  const microUsd = rescaleToMicroUsd(amountBase, token.decimals);

  // An approval moves nothing by itself, and max-uint approvals are how nearly
  // every DeFi integration works, so a blanket refusal would break legitimate
  // workflows wholesale. But an unbounded approval to an address we cannot
  // account for is the cheapest complete drain path a leaked key has: the
  // attacker calls transferFrom afterwards, off platform, where none of this
  // runs and the ceiling never applies to any of it.
  //
  // The split is the spender. Every protocol integration approves a contract
  // this repo already knows about, so an over-cap approval to one of those is
  // the legitimate pattern and stays allowed. An over-cap approval to anything
  // else is refused. Contracts declared userSpecifiedAddress carry no static
  // address and are deliberately absent from the allowlist: a caller-supplied
  // spender is exactly the case that must not be auto-trusted.
  const permittedApproval =
    fn === "approve" && isKnownProtocolSpender(params.spender);

  return compareAgainstCap({
    microUsd,
    capMicroUsd: BigInt(getDefaultStablecoinTransferCapMicroUsd()),
    blocked: !permittedApproval,
    verb: fn === "approve" ? "approval" : "transfer",
    unit: token.symbol,
    event: {
      organizationId: params.organizationId,
      surface: params.context,
      chainId: params.chainId,
      tokenAddress: params.tokenAddress.toLowerCase(),
      symbol: token.symbol,
      erc20Function: fn,
      spender: params.spender?.toLowerCase() ?? null,
    },
  });
}

/**
 * Shared tail for every entry shape: compare, emit the signal, allow or deny.
 *
 * Split out because the batch path had grown its own copy of all four moving
 * parts -- the comparison, the cap read, the security event and the wording of
 * the denial -- so a new field on the event or a reworded message silently kept
 * the old form on one path.
 *
 * `blocked: false` is the one case that reports without refusing: an
 * allowlisted approval above the cap, recorded precisely because it is allowed.
 */
function compareAgainstCap(params: {
  microUsd: bigint;
  capMicroUsd: bigint;
  blocked: boolean;
  verb: string;
  /** Token symbol for a single call, or a description for a batch. */
  unit: string;
  /** What the figure bounds, as it reads in the denial. */
  limit?: string;
  event: Record<string, unknown>;
}): StablecoinCapDecision {
  const { microUsd, capMicroUsd, blocked, verb, unit } = params;
  if (microUsd <= capMicroUsd) {
    return ALLOWED;
  }

  logSecurityEvent(
    blocked
      ? "stablecoin_transfer_cap_exceeded"
      : "stablecoin_approval_above_cap",
    {
      ...params.event,
      amountMicroUsd: microUsd.toString(),
      capMicroUsd: capMicroUsd.toString(),
      blocked,
    }
  );

  if (!blocked) {
    return ALLOWED;
  }

  return {
    kind: "denied",
    error: `Stablecoin ${verb} of ${formatMicroUsd(microUsd)} ${unit} exceeds the ${formatMicroUsd(capMicroUsd)} USD ${params.limit ?? "per-transaction limit"}`,
  };
}

/**
 * Addresses this repo already directs value at: every contract declared by a
 * registered protocol, across every network it lists.
 *
 * Built once and cached. getRegisteredProtocols() is populated by protocol
 * modules at import time, and the set only grows as protocols register, so a
 * miss can only ever be conservative -- it refuses an approval, never admits
 * one it should not have.
 *
 * Contracts flagged userSpecifiedAddress are skipped: their address comes from
 * the caller at run time, so including them would allowlist whatever the
 * caller passed, which is the case this control exists to catch.
 */
let knownSpenders: Set<string> | null = null;
let knownSpendersFrom = -1;

function getKnownProtocolSpenders(): Set<string> {
  // Keyed on registry size rather than memoised outright. A protocol that
  // registers after the first call -- a lazily imported module, a different
  // entry point warming a different subset -- would otherwise be locked out
  // for the life of the process, making the verdict depend on which traffic
  // arrived first.
  const protocols = getRegisteredProtocols();
  if (knownSpenders && knownSpendersFrom === protocols.length) {
    return knownSpenders;
  }
  const addresses = new Set<string>();
  for (const protocol of protocols) {
    for (const contract of Object.values(protocol.contracts ?? {})) {
      if (contract.userSpecifiedAddress) {
        continue;
      }
      for (const address of Object.values(contract.addresses ?? {})) {
        if (typeof address === "string" && address.length > 0) {
          addresses.add(address.toLowerCase());
        }
      }
    }
  }
  knownSpenders = addresses;
  knownSpendersFrom = protocols.length;
  return addresses;
}

function isKnownProtocolSpender(spender: string | undefined): boolean {
  if (!spender) {
    return false;
  }
  return getKnownProtocolSpenders().has(spender.toLowerCase());
}

/**
 * Every token row for a chain. Split from loadStablecoin so the batch path can
 * read once rather than once per call: a 50-recipient payout was 50 identical
 * round trips on the pre-broadcast path, where the latency is user-visible.
 */
async function loadChainTokens(chainId: number): Promise<TokenRow[]> {
  return await db
    .select({
      tokenAddress: supportedTokens.tokenAddress,
      decimals: supportedTokens.decimals,
      symbol: supportedTokens.symbol,
      isStablecoin: supportedTokens.isStablecoin,
    })
    .from(supportedTokens)
    .where(eq(supportedTokens.chainId, chainId));
}

/** The registry row for a known stablecoin on this chain, or null. */
async function loadStablecoin(
  chainId: number,
  tokenAddress: string
): Promise<StablecoinToken | null> {
  if (!isHexAddress(tokenAddress)) {
    return null;
  }

  // Read the chain's whole token list (a handful of rows, on the chain_id
  // index) and match in JS. `supported_tokens.token_address` is seeded
  // lowercase but a resolved address is often checksummed, and an exact SQL
  // comparison against the wrong casing would silently find nothing -- which,
  // for a cap, means failing open.
  return matchStablecoin(await loadChainTokens(chainId), tokenAddress);
}

type TokenRow = {
  tokenAddress: string;
  decimals: number;
  symbol: string;
  isStablecoin: boolean;
};

function matchStablecoin(
  rows: readonly TokenRow[],
  tokenAddress: string
): StablecoinToken | null {
  const wanted = tokenAddress.toLowerCase();
  const token = rows.find(
    (row) => row.tokenAddress.toLowerCase() === wanted && row.isStablecoin
  );
  return token ? { decimals: token.decimals, symbol: token.symbol } : null;
}

function isOutflowName(name: string): name is OutflowFn {
  return Object.hasOwn(OUTFLOW_SHAPES, name);
}

function matchOutflowFunction(
  functionName: string,
  inputTypes: readonly string[]
): OutflowFn | null {
  // `abiFunction` may arrive fully qualified ("transfer(address,uint256)").
  const parenIndex = functionName.indexOf("(");
  const bareName = (
    parenIndex === -1 ? functionName : functionName.slice(0, parenIndex)
  ).trim();

  if (!isOutflowName(bareName)) {
    return null;
  }

  // A same-named function with a different signature is a different function.
  const expected = OUTFLOW_SHAPES[bareName].inputTypes;
  const declared = inputTypes.map(canonicalAbiType);
  if (
    declared.length !== expected.length ||
    !declared.every((type, index) => type === expected[index])
  ) {
    return null;
  }
  return bareName;
}

/**
 * Canonicalise a declared ABI type so an alias cannot slip past the shape
 * comparison above.
 *
 * `inputTypes` reaches this module as the RAW strings from the caller-supplied
 * ABI, while the selector is computed from the canonical form. Solidity treats
 * `uint` as an alias of `uint256`, so an ABI declaring
 * `transfer(address,uint)` encodes selector 0xa9059cbb -- byte-identical to a
 * real ERC-20 transfer -- yet a literal string comparison against "uint256"
 * fails, matchOutflowFunction returns null, and the caller short-circuits to
 * ALLOWED without ever loading the token or comparing an amount. That is a
 * complete bypass of this ceiling via a one-word change to an
 * attacker-supplied ABI.
 *
 * ParamType.from applies the same normalisation ethers uses when building the
 * selector, so the two agree. A type ethers cannot parse is passed through
 * unchanged: it will not match a shape, but it also cannot be encoded into a
 * transaction, so there is nothing to bypass.
 */
function canonicalAbiType(type: string): string {
  try {
    return ethers.ParamType.from(type).format("sighash");
  } catch {
    return type;
  }
}

function decodeErc20Outflow(
  data: string
): { fn: OutflowFn; amountBase: bigint; spender: string | undefined } | null {
  if (!data?.startsWith("0x")) {
    return null;
  }

  let parsed: ethers.TransactionDescription | null = null;
  try {
    parsed = getErc20Interface().parseTransaction({ data });
  } catch {
    return null;
  }

  const fn = matchOutflowFunction(
    parsed?.name ?? "",
    parsed?.fragment.inputs.map((input) => input.type) ?? []
  );
  if (!(parsed && fn)) {
    return null;
  }

  const amountBase = toBaseUnits(parsed.args[OUTFLOW_SHAPES[fn].amountIndex]);
  // Argument 0 is the spender for approve and the recipient otherwise. Only
  // the approve reading is load-bearing; the rest is carried for telemetry.
  const spender =
    typeof parsed.args[0] === "string" ? parsed.args[0] : undefined;
  return amountBase === null ? null : { fn, amountBase, spender };
}

/** Coerce an ABI uint256 argument, however the caller expressed it, to bigint. */
function toBaseUnits(value: unknown): bigint | null {
  if (typeof value === "bigint") {
    return value;
  }
  if (typeof value === "number") {
    return Number.isSafeInteger(value) ? BigInt(value) : null;
  }
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!(DECIMAL_INTEGER_RE.test(trimmed) || HEX_INTEGER_RE.test(trimmed))) {
    return null;
  }
  try {
    return BigInt(trimmed);
  } catch {
    return null;
  }
}

/**
 * Restate a token base-unit amount as micro-USD, relying on the ~1:1 peg. Both
 * directions are exact integer rescales: no rounding is applied, so a
 * sub-micro-USD remainder on a high-decimal stablecoin is truncated, which can
 * only ever lower the figure by less than one millionth of a dollar.
 */
function rescaleToMicroUsd(amountBase: bigint, decimals: number): bigint {
  if (decimals === MICRO_USD_DECIMALS) {
    return amountBase;
  }
  if (decimals > MICRO_USD_DECIMALS) {
    return amountBase / BigInt(10) ** BigInt(decimals - MICRO_USD_DECIMALS);
  }
  return amountBase * BigInt(10) ** BigInt(MICRO_USD_DECIMALS - decimals);
}

/** Render micro-USD as a plain decimal string, e.g. 200000000 -> "200.00". */
function formatMicroUsd(microUsd: bigint): string {
  const scale = BigInt(10) ** BigInt(MICRO_USD_DECIMALS);
  const whole = microUsd / scale;
  const cents = (microUsd % scale) / BigInt(10_000);
  return `${whole}.${cents.toString().padStart(2, "0")}`;
}
