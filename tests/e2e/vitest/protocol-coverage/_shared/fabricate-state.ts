/**
 * Cheatcode state fabrication for precondition-gated fixtures.
 *
 * On an anvil fork, on-chain preconditions the setup workflow cannot buy
 * or sequence (an ERC20 balance with no whale or faucet, an unelapsed
 * unstake cooldown) can be written directly into contract storage with
 * anvil_setStorageAt. Both helpers here locate the target slot by
 * probing: they compute candidate mapping slots from the holder address
 * and ascending slot indices, verify each candidate against the
 * contract's own view function, and restore any slot that did not
 * verify - so a wrong guess can never leave stray state behind, and a
 * token whose accounting is not a plain mapping (e.g. stETH's
 * share-derived balanceOf) fails loudly instead of silently
 * mis-provisioning.
 *
 * Consumed by tests/e2e/vitest/protocol-coverage/_shared/funding.ts:
 * ensureErc20Acquired falls back to fabricateErc20Balance on fork chains
 * with no FORK_WHALES/FAUCETS entry, and runActionFabrications executes
 * the per-action `fabrications` declared in testData (see
 * StateFabrication in lib/test-data/types.ts).
 */

import { ethers } from "ethers";

const BALANCE_VIEW_ABI = ["function balanceOf(address) view returns (uint256)"];

const ALLOWANCE_VIEW_ABI = [
  "function allowance(address owner, address spender) view returns (uint256)",
];

/** StakedUSDeV2-style cooldown surface: a packed one-word struct
 *  (uint104 cooldownEnd | uint152 underlyingAmount) in a
 *  mapping(address => UserCooldown). */
const COOLDOWNS_VIEW_ABI = [
  "function cooldowns(address) view returns (uint104 cooldownEnd, uint152 underlyingAmount)",
];

/** Bits occupied by cooldownEnd (uint104) in the packed struct word. */
const COOLDOWN_END_BITS = BigInt(104);

/** Mapping-slot probe ceiling. Verified layouts sit far below it (USDe
 *  balances at 2, MKR at 1, WETH at 3, sUSDe cooldowns at 15 - all
 *  eth_getStorageAt vs view-function checks on mainnet, 2026-07-08);
 *  the headroom covers contracts with deeper inherited storage. */
const MAX_PROBE_SLOTS = 64;

const abiCoder = ethers.AbiCoder.defaultAbiCoder();

/** Candidate storage slots for mapping[holder] at root slot `index`:
 *  Solidity hashes key-then-slot, Vyper hashes slot-then-key. */
function candidateSlots(holder: string, index: number): string[] {
  return [
    ethers.keccak256(abiCoder.encode(["address", "uint256"], [holder, index])),
    ethers.keccak256(abiCoder.encode(["uint256", "address"], [index, holder])),
  ];
}

/**
 * Write `value` into `slot` of `contractAddress`, run `verify`, and
 * restore the slot's previous value when verification fails. Returns
 * whether the write verified (and was kept).
 */
async function setSlotIfVerifies(
  provider: ethers.JsonRpcProvider,
  contractAddress: string,
  slot: string,
  value: bigint,
  verify: () => Promise<boolean>
): Promise<boolean> {
  const previous = (await provider.send("eth_getStorageAt", [
    contractAddress,
    slot,
    "latest",
  ])) as string;
  await provider.send("anvil_setStorageAt", [
    contractAddress,
    slot,
    ethers.toBeHex(value, 32),
  ]);
  if (await verify()) {
    return true;
  }
  await provider.send("anvil_setStorageAt", [
    contractAddress,
    slot,
    ethers.toBeHex(BigInt(previous), 32),
  ]);
  return false;
}

/**
 * Fabricate an ERC20 balance on an anvil fork by writing the holder's
 * balances-mapping slot directly. Probes ascending slot indices in both
 * Solidity and Vyper mapping layouts and keeps the first candidate whose
 * write is confirmed by balanceOf; every failed candidate is restored.
 *
 * Returns silently when the holder already meets `targetWei`. Throws
 * when no probed slot verifies (unknown layout, or a token whose
 * balanceOf is not a plain stored mapping - e.g. rebasing share
 * accounting like stETH), naming the alternatives.
 */
export async function fabricateErc20Balance(
  provider: ethers.JsonRpcProvider,
  tokenAddress: string,
  holder: string,
  targetWei: bigint
): Promise<void> {
  const token = new ethers.Contract(tokenAddress, BALANCE_VIEW_ABI, provider);
  const balance: bigint = await token.balanceOf(holder);
  if (balance >= targetWei) {
    return;
  }

  for (let index = 0; index < MAX_PROBE_SLOTS; index += 1) {
    for (const slot of candidateSlots(holder, index)) {
      const kept = await setSlotIfVerifies(
        provider,
        tokenAddress,
        slot,
        targetWei,
        async () => (await token.balanceOf(holder)) === targetWei
      );
      if (kept) {
        return;
      }
    }
  }
  throw new Error(
    `fabricateErc20Balance: no balances-mapping slot for ${tokenAddress} verified in the first ${MAX_PROBE_SLOTS} indices (Solidity and Vyper layouts). ` +
      "The token's balanceOf is likely derived (rebasing/shares) rather than a stored mapping; add a FORK_WHALES or FAUCETS entry in lib/test-data/chain-test-data.ts instead."
  );
}

/**
 * Fabricate an ERC20 allowance on an anvil fork by writing the
 * allowance nested-mapping slot directly, so a spender (a vault, a
 * converter, a lending pool) can pull the holder's tokens without the
 * holder submitting a real approve transaction. Probes ascending root
 * slot indices in the standard Solidity nested layout
 * (allowance[owner][spender] at keccak(spender . keccak(owner . index)))
 * and keeps the first candidate confirmed by the allowance view;
 * failed candidates are restored.
 *
 * Used instead of the setup workflow's approve-token nodes on the
 * mainnet fork, where that node's gas-sponsorship-fallback path takes
 * minutes per approval and blows the setup timeout. Verified layouts:
 * USDS/DAI slot 3, MKR slot 2, WETH/USDe standard (mainnet, 2026-07-08).
 * Returns silently when the allowance already covers `amountWei`; throws
 * when no probed slot verifies (non-standard allowance storage).
 */
export async function fabricateErc20Allowance(
  provider: ethers.JsonRpcProvider,
  tokenAddress: string,
  owner: string,
  spender: string,
  amountWei: bigint
): Promise<void> {
  const token = new ethers.Contract(tokenAddress, ALLOWANCE_VIEW_ABI, provider);
  const current: bigint = await token.allowance(owner, spender);
  if (current >= amountWei) {
    return;
  }

  for (let index = 0; index < MAX_PROBE_SLOTS; index += 1) {
    const inner = ethers.keccak256(
      abiCoder.encode(["address", "uint256"], [owner, index])
    );
    const slot = ethers.keccak256(
      ethers.concat([abiCoder.encode(["address"], [spender]), inner])
    );
    const kept = await setSlotIfVerifies(
      provider,
      tokenAddress,
      slot,
      amountWei,
      async () => (await token.allowance(owner, spender)) === amountWei
    );
    if (kept) {
      return;
    }
  }
  throw new Error(
    `fabricateErc20Allowance: no allowance nested-mapping slot for ${tokenAddress} verified in the first ${MAX_PROBE_SLOTS} indices (Solidity layout). ` +
      "The token's allowance storage is non-standard; declare a real approval instead of a fabricatedApproval."
  );
}

/**
 * Rewrite a StakedUSDeV2-style pending cooldown so it reads as elapsed,
 * preserving the escrowed amount. Must run after a real cooldownAssets/
 * cooldownShares call: the real call funds the silo and writes the
 * packed struct this helper locates (by probing for the exact packed
 * word the cooldowns() view reports), so only the timestamp is
 * fabricated - the unstake that follows moves real escrowed funds.
 *
 * No-ops when the cooldown is already elapsed. Throws when the holder
 * has no pending cooldown (harness ordering bug) or no probed slot
 * matches the packed struct.
 */
export async function fabricateElapsedCooldown(
  provider: ethers.JsonRpcProvider,
  contractAddress: string,
  holder: string
): Promise<void> {
  const vault = new ethers.Contract(
    contractAddress,
    COOLDOWNS_VIEW_ABI,
    provider
  );
  const [cooldownEnd, underlyingAmount] = (await vault.cooldowns(holder)) as [
    bigint,
    bigint,
  ];
  if (underlyingAmount === BigInt(0) && cooldownEnd === BigInt(0)) {
    throw new Error(
      `fabricateElapsedCooldown: ${holder} has no pending cooldown on ${contractAddress}; a real cooldown call must run first (it funds the silo the unstake draws from).`
    );
  }
  const latest = await provider.getBlock("latest");
  if (!latest) {
    throw new Error("fabricateElapsedCooldown: no latest block");
  }
  if (cooldownEnd <= BigInt(latest.timestamp)) {
    return;
  }

  const packed = (underlyingAmount << COOLDOWN_END_BITS) | cooldownEnd;
  const elapsed = (underlyingAmount << COOLDOWN_END_BITS) | BigInt(1);
  for (let index = 0; index < MAX_PROBE_SLOTS; index += 1) {
    for (const slot of candidateSlots(holder, index)) {
      const current = BigInt(
        (await provider.send("eth_getStorageAt", [
          contractAddress,
          slot,
          "latest",
        ])) as string
      );
      if (current !== packed) {
        continue;
      }
      const kept = await setSlotIfVerifies(
        provider,
        contractAddress,
        slot,
        elapsed,
        async () => {
          const [end, amount] = (await vault.cooldowns(holder)) as [
            bigint,
            bigint,
          ];
          return end === BigInt(1) && amount === underlyingAmount;
        }
      );
      if (kept) {
        return;
      }
    }
  }
  throw new Error(
    `fabricateElapsedCooldown: no slot on ${contractAddress} matched the packed cooldown struct for ${holder} in the first ${MAX_PROBE_SLOTS} indices. ` +
      "The contract's cooldowns storage is not the StakedUSDeV2 packed layout (uint104 cooldownEnd | uint152 underlyingAmount)."
  );
}
