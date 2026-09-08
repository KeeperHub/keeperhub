/**
 * Tier 1 event-decoding simulation.
 *
 * The registry declares protocol events consumed by the Event trigger, but
 * the Tier 2 runner fires workflows over the webhook endpoint, which ignores
 * trigger config entirely - so event decoding has no execution coverage. This
 * harness closes that gap: for each registered event it emits a real,
 * impersonated transaction on the fork (reusing an existing write fixture
 * where one already emits the event, else a targeted emitter call), then
 * asserts the event-trigger decoder parses the emitted log into the shape the
 * trigger layer consumes.
 *
 * The decoder under test is the registry's own event ABI fragment
 * (buildEventAbiFragment) fed to an ethers Interface - the exact artifact the
 * Event trigger stores as contractABI and decodes logs with (see
 * plugins/web3/steps/query-events.ts decodeEventArgs and
 * lib/workflow/editor/trigger-output-fields.ts getEventTriggerOutputFields).
 * A pass proves the registry event definition (name, param types, indexed
 * flags) matches the real on-chain event and decodes into named args.
 *
 * Events that cannot be emitted on the fork are documented skips in
 * testData[chain].events.skipped, keyed by event slug with a reason naming
 * the real constraint - the vitest reporter surfaces them on every run.
 */

import {
  Contract,
  concat,
  Interface,
  id,
  JsonRpcProvider,
  type Log,
  parseEther,
  type TransactionReceipt,
  ZeroAddress,
  ZeroHash,
  zeroPadValue,
} from "ethers";
import { beforeAll, expect, test } from "vitest";
import {
  buildEventAbiFragment,
  getProtocol,
  type ProtocolEvent,
} from "@/lib/protocol-registry";
import { encodeBoundAction } from "@/lib/test-data/encode-action";
import {
  ensureErc20Acquired,
  withImpersonation,
} from "../../protocol-coverage/_shared/funding";
import { SIM_WALLET } from "./simulate";

// Emitting a fresh Safe plus a handful of self-called state transitions runs
// several sequential impersonated transactions through the fork; keep the
// emit phase's budget generous while the per-event decode assertions stay
// cheap (pure decode of already-collected logs).
const EMIT_TIMEOUT_MS = 240_000;
// BigInt literals (0n) are unavailable under the repo's sub-ES2020 tsconfig
// target, so bigint args go through BigInt(); mirrors simulate.ts.
const ZERO = BigInt(0);
const ONE = BigInt(1);
const TWO = BigInt(2);
const GAS_LIMIT_MULTIPLIER = TWO;

type TxRequest = { to: string; data?: string; value?: bigint };

async function sendAndWait(
  provider: JsonRpcProvider,
  from: string,
  tx: TxRequest
): Promise<TransactionReceipt> {
  return withImpersonation(provider, from, async (signer) => {
    const estimated = await signer.estimateGas(tx);
    const sent = await signer.sendTransaction({
      ...tx,
      gasLimit: estimated * GAS_LIMIT_MULTIPLIER,
    });
    const receipt = await sent.wait();
    if (receipt?.status !== 1) {
      throw new Error(`event emitter tx to ${tx.to} reverted`);
    }
    return receipt;
  });
}

function serializeArgs(
  inputs: readonly { name: string }[],
  args: readonly unknown[]
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [index, input] of inputs.entries()) {
    const name = input.name || `arg${index}`;
    out[name] = JSON.parse(
      JSON.stringify(args[index], (_, v) =>
        typeof v === "bigint" ? v.toString() : v
      )
    );
  }
  return out;
}

/**
 * Assert the registry event ABI fragment decodes a real emitted log into the
 * trigger-layer shape: a topic-0 match locates the log, parseLog decodes it,
 * and every declared input surfaces as a named, serializable arg.
 */
function assertEventDecodes(event: ProtocolEvent, logs: readonly Log[]): void {
  const iface = new Interface(JSON.parse(buildEventAbiFragment(event)));
  const fragment = iface.getEvent(event.eventName);
  if (!fragment) {
    throw new Error(`no event fragment for ${event.eventName}`);
  }
  const match = logs.find((l) => l.topics[0] === fragment.topicHash);
  expect(
    match,
    `no emitted log matched topic0 for event ${event.slug} (${event.eventName})`
  ).toBeDefined();
  if (!match) {
    return;
  }
  const parsed = iface.parseLog({
    topics: [...match.topics],
    data: match.data,
  });
  expect(parsed, `parseLog returned null for ${event.slug}`).not.toBeNull();
  if (!parsed) {
    return;
  }
  expect(parsed.name).toBe(event.eventName);
  const args = serializeArgs(fragment.inputs, parsed.args);
  expect(Object.keys(args)).toHaveLength(event.inputs.length);
  for (const input of event.inputs) {
    expect(
      Object.hasOwn(args, input.name),
      `decoded args missing declared input ${input.name}`
    ).toBe(true);
  }
}

// -- Emitters ----------------------------------------------------------------

type Emitter = (
  provider: JsonRpcProvider,
  chainId: string,
  rpcUrl: string
) => Promise<Log[]>;

/** rETH deposit: the existing write fixture. depositPool.deposit emits
 *  DepositReceived and the rETH mint it triggers emits TokensMinted. */
async function emitRocketPool(
  provider: JsonRpcProvider,
  chainId: string
): Promise<Log[]> {
  const protocol = getProtocol("rocket-pool");
  const deposit = protocol?.actions.find((a) => a.slug === "deposit");
  if (!(protocol && deposit)) {
    throw new Error("rocket-pool deposit fixture unavailable");
  }
  const encoded = encodeBoundAction(protocol, deposit, chainId, SIM_WALLET);
  const receipt = await sendAndWait(provider, SIM_WALLET, {
    to: encoded.to,
    data: encoded.data,
    value: encoded.value,
  });
  return [...receipt.logs];
}

/** stETH.submit stakes ETH for stETH and emits Submitted; needs only native
 *  gas, so a targeted call covers it without the whale a wrap would need. */
async function emitLido(
  provider: JsonRpcProvider,
  chainId: string
): Promise<Log[]> {
  const steth = getProtocol("lido")?.contracts.steth?.addresses[chainId];
  if (!steth) {
    throw new Error(`lido steth address missing for chain ${chainId}`);
  }
  const iface = new Interface([
    "function submit(address _referral) payable returns (uint256)",
  ]);
  const receipt = await sendAndWait(provider, SIM_WALLET, {
    to: steth,
    data: iface.encodeFunctionData("submit", [ZeroAddress]),
    value: parseEther("0.01"),
  });
  return [...receipt.logs];
}

// Canonical Safe v1.4.1 deployments (same address on every chain).
const SAFE_FACTORY = "0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67";
const SAFE_SINGLETON = "0x41675C099F32341bf84BFc5382aF534df5C7461a";
const SAFE_SENTINEL = "0x0000000000000000000000000000000000000001";
const SAFE_DUMMY_OWNER = "0x000000000000000000000000000000000000a001";
const SAFE_DUMMY_OWNER_2 = "0x000000000000000000000000000000000000a002";
const SAFE_DUMMY_MODULE = "0x000000000000000000000000000000000000a003";
const SAFE_DUMMY_HANDLER = "0x000000000000000000000000000000000000a004";

const SAFE_IFACE = new Interface([
  "function setup(address[] _owners, uint256 _threshold, address to, bytes data, address fallbackHandler, address paymentToken, uint256 payment, address paymentReceiver)",
  "function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) returns (bool)",
  "function addOwnerWithThreshold(address owner, uint256 _threshold)",
  "function removeOwner(address prevOwner, address owner, uint256 _threshold)",
  "function enableModule(address module)",
  "function disableModule(address prevModule, address module)",
  "function setGuard(address guard)",
  "function setFallbackHandler(address handler)",
  "function approveHash(bytes32 hashToApprove)",
]);
const SAFE_FACTORY_IFACE = new Interface([
  "function createProxyWithNonce(address _singleton, bytes initializer, uint256 saltNonce) returns (address proxy)",
]);

/**
 * Deploy a fresh 1-of-1 Safe owned by the impersonated wallet and drive it
 * through its state-changing calls to emit each Safe event. execTransaction is
 * authorized with an approved-hash signature (r = owner, s = 0, v = 1): Safe's
 * checkSignatures accepts it when msg.sender is that owner, so no ECDSA key or
 * EIP-712 hash is needed. Every threshold-raising call is sequenced last so
 * each execTransaction still validates against a threshold of 1 at call time.
 */
async function emitSafe(
  provider: JsonRpcProvider,
  _chainId: string
): Promise<Log[]> {
  const setupData = SAFE_IFACE.encodeFunctionData("setup", [
    [SIM_WALLET],
    ONE,
    ZeroAddress,
    "0x",
    ZeroAddress,
    ZeroAddress,
    ZERO,
    ZeroAddress,
  ]);
  const saltNonce = BigInt(Date.now());
  const createData = SAFE_FACTORY_IFACE.encodeFunctionData(
    "createProxyWithNonce",
    [SAFE_SINGLETON, setupData, saltNonce]
  );
  const predicted = await provider.call({
    to: SAFE_FACTORY,
    data: createData,
    from: SIM_WALLET,
  });
  const [safeAddr] = SAFE_FACTORY_IFACE.decodeFunctionResult(
    "createProxyWithNonce",
    predicted
  ) as unknown as [string];

  const logs: Log[] = [];
  const deployReceipt = await sendAndWait(provider, SIM_WALLET, {
    to: SAFE_FACTORY,
    data: createData,
  });
  logs.push(...deployReceipt.logs);

  const signature = concat([zeroPadValue(SIM_WALLET, 32), ZeroHash, "0x01"]);
  const execTransaction = async (innerData: string): Promise<void> => {
    const data = SAFE_IFACE.encodeFunctionData("execTransaction", [
      safeAddr,
      ZERO,
      innerData,
      0,
      ZERO,
      ZERO,
      ZERO,
      ZeroAddress,
      ZeroAddress,
      signature,
    ]);
    const receipt = await sendAndWait(provider, SIM_WALLET, {
      to: safeAddr,
      data,
    });
    logs.push(...receipt.logs);
  };

  await execTransaction(
    SAFE_IFACE.encodeFunctionData("addOwnerWithThreshold", [
      SAFE_DUMMY_OWNER,
      ONE,
    ])
  );
  await execTransaction(
    SAFE_IFACE.encodeFunctionData("enableModule", [SAFE_DUMMY_MODULE])
  );
  await execTransaction(
    SAFE_IFACE.encodeFunctionData("disableModule", [
      SAFE_SENTINEL,
      SAFE_DUMMY_MODULE,
    ])
  );
  await execTransaction(
    SAFE_IFACE.encodeFunctionData("setGuard", [ZeroAddress])
  );
  await execTransaction(
    SAFE_IFACE.encodeFunctionData("setFallbackHandler", [SAFE_DUMMY_HANDLER])
  );
  await execTransaction(
    SAFE_IFACE.encodeFunctionData("removeOwner", [
      SAFE_SENTINEL,
      SAFE_DUMMY_OWNER,
      ONE,
    ])
  );
  await execTransaction(
    SAFE_IFACE.encodeFunctionData("addOwnerWithThreshold", [
      SAFE_DUMMY_OWNER_2,
      TWO,
    ])
  );

  const approveReceipt = await sendAndWait(provider, SIM_WALLET, {
    to: safeAddr,
    data: SAFE_IFACE.encodeFunctionData("approveHash", [
      id("keeperhub-event-coverage"),
    ]),
  });
  logs.push(...approveReceipt.logs);
  return logs;
}

// -- Pendle (pinned mainnet fork) --------------------------------------------
// The wstETH market's registry SY "whale" is the market itself, so acquiring SY
// that way would drain its reserves and break the low-level receipt checks.
// Instead mint fresh SY from wstETH (its real whale), then drive the YT and
// market directly: every market event fires on a low-level call once the tokens
// are positioned (Uniswap-V2 style), avoiding the router's diamond selectors.
const PENDLE_MARKET = "0x34280882267ffa6383B363E278B027Be083bBe3b";
const PENDLE_SY = "0xcbC72d92b2dc8187414F6734718563898740C0BC";
const PENDLE_PT = "0xb253Eff1104802b97aC7E3aC9FdD73AecE295a2c";
const PENDLE_YT = "0x04B7Fa1e727d7290D6E24fA9b426d0c940283a95";
const PENDLE_WSTETH = "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0";
const PENDLE_ERC20 = new Interface([
  "function transfer(address,uint256) returns (bool)",
  "function approve(address,uint256) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
]);
const PENDLE_SY_IFACE = new Interface([
  "function deposit(address receiver, address tokenIn, uint256 amountTokenToDeposit, uint256 minSharesOut) returns (uint256)",
]);
const PENDLE_YT_IFACE = new Interface([
  "function mintPY(address receiverPT, address receiverYT) returns (uint256)",
  "function redeemPY(address receiver) returns (uint256)",
  "function redeemDueInterestAndRewards(address user, bool redeemInterest, bool redeemRewards) returns (uint256, uint256[])",
]);
const PENDLE_MARKET_IFACE = new Interface([
  "function mint(address receiver, uint256 netSyDesired, uint256 netPtDesired) returns (uint256,uint256,uint256)",
  "function burn(address receiverSy, address receiverPt, uint256 netLpToBurn) returns (uint256,uint256)",
  "function swapExactPtForSy(address receiver, uint256 exactPtIn, bytes data) returns (uint256,uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function readState(address) view returns (tuple(int256 totalPt,int256 totalSy,int256 totalLp,address treasury,int256 scalarRoot,uint256 expiry,uint256 lnFeeRateRoot,uint256 reserveFeePercent,uint256 lastLnImpliedRate))",
]);

async function emitPendle(
  provider: JsonRpcProvider,
  chainId: string,
  rpcUrl: string
): Promise<Log[]> {
  const logs: Log[] = [];
  const push = async (to: string, data: string) => {
    const r = await sendAndWait(provider, SIM_WALLET, { to, data });
    logs.push(...r.logs);
  };
  const balOf = (token: string): Promise<bigint> =>
    new Contract(token, PENDLE_ERC20, provider).balanceOf(
      SIM_WALLET
    ) as Promise<bigint>;

  // Fresh SY from wstETH (real whale), leaving the market's reserves intact.
  await ensureErc20Acquired(chainId, SIM_WALLET, "WSTETH", "60", rpcUrl);
  await push(
    PENDLE_WSTETH,
    PENDLE_ERC20.encodeFunctionData("approve", [
      PENDLE_SY,
      parseEther("1000000"),
    ])
  );
  await push(
    PENDLE_SY,
    PENDLE_SY_IFACE.encodeFunctionData("deposit", [
      SIM_WALLET,
      PENDLE_WSTETH,
      parseEther("50"),
      ZERO,
    ])
  );

  // yt-mint: split SY into PT + YT via the YT contract.
  await push(
    PENDLE_SY,
    PENDLE_ERC20.encodeFunctionData("transfer", [PENDLE_YT, parseEther("6")])
  );
  await push(
    PENDLE_YT,
    PENDLE_YT_IFACE.encodeFunctionData("mintPY", [SIM_WALLET, SIM_WALLET])
  );

  // market-mint (+ update-implied-rate): low-level add sized to the pool ratio.
  // The market's low-level mint measures received SY as (token balance -
  // accounted totalSy); that difference is negative natively and grows if a
  // prior suite drained the market (its registry SY whale is the market
  // itself), so overshoot by the live gap plus a buffer to guarantee the
  // receipt check clears.
  const marketContract = new Contract(
    PENDLE_MARKET,
    PENDLE_MARKET_IFACE,
    provider
  );
  const st = await marketContract.readState(
    "0x0000000000000000000000000000000000000000"
  );
  const marketSyBalance = (await new Contract(
    PENDLE_SY,
    PENDLE_ERC20,
    provider
  ).balanceOf(PENDLE_MARKET)) as bigint;
  const accountedSy = BigInt(st.totalSy);
  const gap =
    accountedSy > marketSyBalance ? accountedSy - marketSyBalance : ZERO;
  const netPt = parseEther("1");
  const netSy = (netPt * accountedSy) / BigInt(st.totalPt);
  await push(
    PENDLE_SY,
    PENDLE_ERC20.encodeFunctionData("transfer", [
      PENDLE_MARKET,
      netSy + gap + parseEther("3"),
    ])
  );
  await push(
    PENDLE_PT,
    PENDLE_ERC20.encodeFunctionData("transfer", [PENDLE_MARKET, netPt])
  );
  await push(
    PENDLE_MARKET,
    PENDLE_MARKET_IFACE.encodeFunctionData("mint", [SIM_WALLET, netSy, netPt])
  );
  const lp = (await new Contract(
    PENDLE_MARKET,
    PENDLE_MARKET_IFACE,
    provider
  ).balanceOf(SIM_WALLET)) as bigint;

  // market-swap (+ update-implied-rate): low-level PT -> SY swap.
  await push(
    PENDLE_PT,
    PENDLE_ERC20.encodeFunctionData("transfer", [
      PENDLE_MARKET,
      parseEther("1"),
    ])
  );
  await push(
    PENDLE_MARKET,
    PENDLE_MARKET_IFACE.encodeFunctionData("swapExactPtForSy", [
      SIM_WALLET,
      parseEther("1"),
      "0x",
    ])
  );

  // market-burn: low-level burn of the LP just minted.
  if (lp > ZERO) {
    await push(
      PENDLE_MARKET,
      PENDLE_ERC20.encodeFunctionData("transfer", [PENDLE_MARKET, lp])
    );
    await push(
      PENDLE_MARKET,
      PENDLE_MARKET_IFACE.encodeFunctionData("burn", [
        SIM_WALLET,
        SIM_WALLET,
        lp,
      ])
    );
  }

  // yt-burn: recombine equal PT + YT back into SY.
  const ptBal = await balOf(PENDLE_PT);
  const ytBal = await balOf(PENDLE_YT);
  const eq = ptBal < ytBal ? ptBal : ytBal;
  await push(
    PENDLE_PT,
    PENDLE_ERC20.encodeFunctionData("transfer", [PENDLE_YT, eq])
  );
  await push(
    PENDLE_YT,
    PENDLE_ERC20.encodeFunctionData("transfer", [PENDLE_YT, eq])
  );
  await push(
    PENDLE_YT,
    PENDLE_YT_IFACE.encodeFunctionData("redeemPY", [SIM_WALLET])
  );

  // redeem-interest: advance time so SY interest accrues, then claim. The
  // wstETH market carries no external reward tokens, so RedeemRewards never
  // fires (a documented skip); RedeemInterest does.
  await provider.send("evm_increaseTime", [7 * 24 * 3600]);
  await provider.send("evm_mine", []);
  await push(
    PENDLE_YT,
    PENDLE_YT_IFACE.encodeFunctionData("redeemDueInterestAndRewards", [
      SIM_WALLET,
      true,
      true,
    ])
  );
  return logs;
}

// -- Aerodrome (Base fork) ---------------------------------------------------
// Pool ops need no whale (wrap ETH for WETH); AERO comes from the veAERO escrow
// under impersonation. Locks/vote/distribute drive the Voter + VotingEscrow.
const AERO_ROUTER = "0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43";
const AERO_VOTER = "0x16613524e02ad97eDfeF371bC883F2F5d6C480A5";
const AERO_ESCROW = "0xeBf418Fe2512e7E6bd9b87a8F0f294aCDC67e6B4";
const AERO_POOL = "0xcDAC0d6c6C59727a65F871236188350531885C43"; // WETH/USDC volatile
const AERO_FACTORY = "0x420DD381b31aEf6683db6B902084cB0FFECe40Da";
const AERO_AERO = "0x940181a94A35A4569E4529A3CDfB74e38FD98631";
const AERO_WETH = "0x4200000000000000000000000000000000000006";
const AERO_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const AERO_TEN_ETH_HEX = "0x8ac7230489e80000";
const AERO_ERC20 = new Interface([
  "function transfer(address,uint256) returns (bool)",
  "function approve(address,uint256) returns (bool)",
]);
const AERO_WETH_IFACE = new Interface(["function deposit() payable"]);
const AERO_ROUTER_IFACE = new Interface([
  "function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, (address from,address to,bool stable,address factory)[] routes, address to, uint256 deadline) returns (uint256[])",
]);
const AERO_VE_IFACE = new Interface([
  "function createLock(uint256 _value, uint256 _lockDuration) returns (uint256)",
  "function withdraw(uint256 _tokenId)",
]);
const AERO_VOTER_IFACE = new Interface([
  "function vote(uint256 _tokenId, address[] _poolVote, uint256[] _weights)",
  "function gauges(address) view returns (address)",
  "function distribute(address[] _gauges)",
]);
const AERO_DEPOSIT_TOPIC = id(
  "Deposit(address,uint256,uint8,uint256,uint256,uint256)"
);
const AERO_WEEK = BigInt(7 * 24 * 3600);
const AERO_HOUR = BigInt(3600);

// Mirrors VelodromeTimeLibrary.epochStart: epochs run Thu 00:00 UTC to Thu
// 00:00 UTC. Voter.onlyNewEpoch reverts with DistributeWindow for
// timestamp <= epochVoteStart (the first hour of a new epoch, Voter.sol:105)
// and with NotWhitelistedNFT for timestamp > epochVoteEnd (the last hour of
// the old one, Voter.sol:266), so a vote is only valid in the half-open
// range (epochVoteStart, epochVoteEnd].
function aeroEpochStart(timestamp: bigint): bigint {
  return timestamp - (timestamp % AERO_WEEK);
}

function isInAeroVoteWindow(timestamp: bigint): boolean {
  const start = aeroEpochStart(timestamp);
  return (
    timestamp > start + AERO_HOUR && timestamp <= start + AERO_WEEK - AERO_HOUR
  );
}

async function emitAerodrome(provider: JsonRpcProvider): Promise<Log[]> {
  const logs: Log[] = [];
  const push = async (to: string, data: string, value = ZERO) => {
    const r = await sendAndWait(provider, SIM_WALLET, { to, data, value });
    logs.push(...r.logs);
    return r;
  };
  const tokenIdFrom = (recLogs: readonly Log[]): bigint => {
    const dep = recLogs.find((l) => l.topics[0] === AERO_DEPOSIT_TOPIC);
    return dep ? BigInt(dep.topics[2]) : ZERO;
  };

  // Top up beyond the harness's 10 ETH so wrapping leaves gas headroom.
  await provider.send("anvil_setBalance", [
    SIM_WALLET,
    "0x56bc75e2d63100000", // 100 ETH
  ]);
  // WETH by wrapping ETH; AERO from the escrow (gas-funded via setBalance).
  await push(
    AERO_WETH,
    AERO_WETH_IFACE.encodeFunctionData("deposit", []),
    parseEther("10")
  );
  await provider.send("anvil_setBalance", [AERO_ESCROW, AERO_TEN_ETH_HEX]);
  const aeroFund = await sendAndWait(provider, AERO_ESCROW, {
    to: AERO_AERO,
    data: AERO_ERC20.encodeFunctionData("transfer", [
      SIM_WALLET,
      parseEther("5000"),
    ]),
  });
  logs.push(...aeroFund.logs);

  // pool-swap + pool-sync: WETH -> USDC through the volatile pool.
  await push(
    AERO_WETH,
    AERO_ERC20.encodeFunctionData("approve", [
      AERO_ROUTER,
      parseEther("1000000"),
    ])
  );
  await push(
    AERO_ROUTER,
    AERO_ROUTER_IFACE.encodeFunctionData("swapExactTokensForTokens", [
      parseEther("2"),
      ZERO,
      [[AERO_WETH, AERO_USDC, false, AERO_FACTORY]],
      SIM_WALLET,
      BigInt(4_102_444_800),
    ])
  );

  // ve-deposit: lock AERO for a year (voting power for the vote below).
  await push(
    AERO_AERO,
    AERO_ERC20.encodeFunctionData("approve", [
      AERO_ESCROW,
      parseEther("1000000"),
    ])
  );
  const lock1 = await push(
    AERO_ESCROW,
    AERO_VE_IFACE.encodeFunctionData("createLock", [
      parseEther("1000"),
      BigInt(365 * 24 * 3600),
    ])
  );
  const id1 = tokenIdFrom(lock1.logs);

  // voter-voted: warp to a fixed offset into the *next* epoch rather than a
  // fixed +2d delta from "now" - the old delta drifted in and out of the
  // epoch's voting window depending on when CI ran. Target epochStart(now) +
  // WEEK + 12h: always a fresh epoch, 11h clear of the opening
  // DistributeWindow and far clear (~155h) of the closing epochVoteEnd cutoff.
  const preVoteBlock = await provider.getBlock("latest");
  if (!preVoteBlock) {
    throw new Error("aerodrome fork: no latest block before vote warp");
  }
  const voteTarget =
    aeroEpochStart(BigInt(preVoteBlock.timestamp)) +
    AERO_WEEK +
    AERO_HOUR * BigInt(12);
  await provider.send("evm_increaseTime", [
    Number(voteTarget - BigInt(preVoteBlock.timestamp)),
  ]);
  await provider.send("evm_mine", []);
  const votedBlock = await provider.getBlock("latest");
  if (!votedBlock) {
    throw new Error("aerodrome fork: no latest block after vote warp");
  }
  expect(
    isInAeroVoteWindow(BigInt(votedBlock.timestamp)),
    `aerodrome vote warp landed at ${votedBlock.timestamp}, outside the Aerodrome voting window`
  ).toBe(true);
  await push(
    AERO_VOTER,
    AERO_VOTER_IFACE.encodeFunctionData("vote", [id1, [AERO_POOL], [ONE]])
  );

  // ve-withdraw: a short lock, warped past expiry, then withdrawn.
  const lock2 = await push(
    AERO_ESCROW,
    AERO_VE_IFACE.encodeFunctionData("createLock", [
      parseEther("100"),
      BigInt(7 * 24 * 3600),
    ])
  );
  const id2 = tokenIdFrom(lock2.logs);
  await provider.send("evm_increaseTime", [8 * 24 * 3600]);
  await provider.send("evm_mine", []);
  await push(AERO_ESCROW, AERO_VE_IFACE.encodeFunctionData("withdraw", [id2]));

  // distribute-reward: a fresh epoch, then distribute emissions to the voted
  // gauge (permissionless; drives minter.updatePeriod). Assert the epoch
  // actually flips instead of assuming the fixed 7-day warp always crosses
  // one (the same unchecked-assumption class of bug as the vote-window one).
  const gauge = (await new Contract(
    AERO_VOTER,
    AERO_VOTER_IFACE,
    provider
  ).gauges(AERO_POOL)) as string;
  const preDistributeBlock = await provider.getBlock("latest");
  if (!preDistributeBlock) {
    throw new Error("aerodrome fork: no latest block before distribute warp");
  }
  await provider.send("evm_increaseTime", [7 * 24 * 3600]);
  await provider.send("evm_mine", []);
  const distributeBlock = await provider.getBlock("latest");
  if (!distributeBlock) {
    throw new Error("aerodrome fork: no latest block after distribute warp");
  }
  expect(
    aeroEpochStart(BigInt(distributeBlock.timestamp)),
    "distribute-reward warp did not cross an Aerodrome epoch boundary"
  ).toBeGreaterThan(aeroEpochStart(BigInt(preDistributeBlock.timestamp)));
  await push(
    AERO_VOTER,
    AERO_VOTER_IFACE.encodeFunctionData("distribute", [[gauge]])
  );
  return logs;
}

const EMITTERS: Record<string, Emitter> = {
  "rocket-pool": emitRocketPool,
  lido: emitLido,
  safe: emitSafe,
  pendle: emitPendle,
  aerodrome: emitAerodrome,
};

export function runEventSimulation(opts: {
  protocol: string;
  chainId: string;
  rpcUrl: string;
}): void {
  const protocol = getProtocol(opts.protocol);
  const events = protocol?.events ?? [];
  if (!(protocol && events.length > 0)) {
    return;
  }

  const skipped = protocol.testData?.[opts.chainId]?.events?.skipped ?? {};
  const emittable = events.filter((e) => !skipped[e.slug]);

  const provider = new JsonRpcProvider(opts.rpcUrl, undefined, {
    staticNetwork: true,
    // ethers shares the result of identical requests made within
    // cacheTimeout ms (default 250). This harness mutates chain state
    // between reads - a getBlock("latest") before a warp and one after it
    // are an identical request, so the second read silently returns the
    // pre-warp block and any before/after comparison compares a block to
    // itself. Local anvil makes that round trip fast enough to always hit
    // the cache. Disable it: a harness that mutates chain state must never
    // read cached chain state.
    cacheTimeout: -1,
  });

  let collected: Log[] = [];
  if (emittable.length > 0) {
    const emitter = EMITTERS[opts.protocol];
    beforeAll(async () => {
      if (!emitter) {
        throw new Error(`no event emitter registered for ${opts.protocol}`);
      }
      // 10 ETH native gas for the impersonated wallet, matching the action
      // simulation harness.
      await provider.send("anvil_setBalance", [
        SIM_WALLET,
        "0x8ac7230489e80000",
      ]);
      collected = await emitter(provider, opts.chainId, opts.rpcUrl);
    }, EMIT_TIMEOUT_MS);
  }

  for (const event of events) {
    const reason = skipped[event.slug];
    if (reason) {
      test.skip(`event ${event.slug} (${reason})`, () => {
        /* documented in testData.events.skipped */
      });
      continue;
    }
    test(`event ${event.slug}`, () => {
      assertEventDecodes(event, collected);
    });
  }
}
