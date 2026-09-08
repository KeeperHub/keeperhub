/**
 * Shared Turnkey activity envelope types + status handling for the signing
 * helpers (lib/agentic-wallet/sign.ts, sign-typed-data.ts, sign-eth-tx.ts,
 * lib/turnkey/solana-signer.ts). One copy of the call / status-check /
 * result-unwrap skeleton: CONSENSUS_NEEDED maps to the caller's
 * policy-blocked error class, any other non-COMPLETED status or a missing
 * result maps to the caller's upstream error class. Error classes stay
 * exported from their original modules so existing imports and instanceof
 * checks are unchanged.
 *
 * plugins/tempo-tx-core keeps its own copy of this envelope; it is owned
 * separately and intentionally not migrated here.
 */

export type TurnkeySignature = { r: string; s: string; v: string };

export type TurnkeySignRawPayloadActivityResult = {
  signRawPayloadResult?: TurnkeySignature;
};

export type TurnkeySignTransactionActivityResult = {
  signTransactionResult?: { signedTransaction?: string };
};

export type TurnkeyActivityResponse<TResult> = {
  activity?: {
    status?: string;
    result?: TResult;
  };
};

export type TurnkeyActivityErrorSpec = {
  /** Error class thrown on ACTIVITY_STATUS_CONSENSUS_NEEDED. */
  policyBlockedError: new (
    message: string
  ) => Error;
  /** Error class thrown on any other non-COMPLETED status or missing result. */
  upstreamError: new (
    message: string
  ) => Error;
  policyBlockedMessage: string;
  /** Appended to the `Turnkey returned status <status>` message. */
  statusMessageSuffix?: string;
  missingResultMessage: string;
};

/**
 * Invokes `client[method](params)` on a Turnkey API client and unwraps the
 * activity envelope. The method is called as a property access so the SDK
 * client keeps its `this` binding.
 */
export async function runTurnkeyActivity<TResult, TValue>(
  client: unknown,
  method: string,
  params: Record<string, unknown>,
  extract: (result: TResult | undefined) => TValue | undefined,
  errors: TurnkeyActivityErrorSpec
): Promise<TValue> {
  const invocable = client as Record<
    string,
    (args: unknown) => Promise<TurnkeyActivityResponse<TResult>>
  >;
  const response = await invocable[method](params);

  const activity = response?.activity;
  const status = activity?.status;
  if (status === "ACTIVITY_STATUS_CONSENSUS_NEEDED") {
    throw new errors.policyBlockedError(errors.policyBlockedMessage);
  }
  if (status !== "ACTIVITY_STATUS_COMPLETED") {
    throw new errors.upstreamError(
      `Turnkey returned status ${status ?? "unknown"}${errors.statusMessageSuffix ?? ""}`
    );
  }
  const value = extract(activity?.result);
  if (!value) {
    throw new errors.upstreamError(errors.missingResultMessage);
  }
  return value;
}
