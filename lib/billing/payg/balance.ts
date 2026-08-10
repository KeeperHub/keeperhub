import { Contract, JsonRpcProvider } from "ethers";
import { USDC_BASE_ADDRESS } from "@/lib/agentic-wallet/constants";
import { PAYG_DEFAULT_CHAIN_ID } from "./constants";

const BALANCE_OF_ABI = ["function balanceOf(address) view returns (uint256)"];

// Module-level singleton so a per-execution check does not build a new
// connection pool each time. Mirrors lib/payments/x402/reconcile.ts.
const provider = new JsonRpcProvider(
  process.env.BASE_RPC_URL ?? "https://mainnet.base.org"
);

const usdcByChainId: Record<number, string> = {
  [PAYG_DEFAULT_CHAIN_ID]: USDC_BASE_ADDRESS,
};

/**
 * Whether the payer holds at least `amountRaw` USDC, read straight from the
 * token contract.
 *
 * Settlement signs the EIP-3009 authorization with Turnkey before the
 * facilitator ever reports a shortfall, so an org with an empty wallet burns a
 * signing call and a facilitator round-trip on every retry. A blocked org's
 * triggers keep firing, so that is the common case, not the rare one. This read
 * is the cheap way to stop before either.
 *
 * Returns null when the answer is unknown (unsupported chain, RPC failure), and
 * the caller settles as before. A flaky RPC must not block an org that can pay.
 */
export async function hasSufficientUsdc(params: {
  payerAddress: string;
  amountRaw: bigint;
  chainId: number;
}): Promise<boolean | null> {
  const token = usdcByChainId[params.chainId];
  if (!token) {
    return null;
  }
  try {
    const contract = new Contract(token, BALANCE_OF_ABI, provider);
    const balance = (await contract.balanceOf(params.payerAddress)) as bigint;
    return balance >= params.amountRaw;
  } catch {
    return null;
  }
}
