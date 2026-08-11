/**
 * Tier 1 fork simulation harness.
 *
 * Runs every registry action for a (protocol, chain) directly against an
 * anvil fork - no app, no webhook, no Turnkey. Impersonation replaces
 * signing and direct RPC replaces the executor, but the semantics mirror
 * the e2e coverage suites exactly: testData setup (native gas, ERC20s,
 * approvals, protocol steps) provisions state first, reads are eth_call
 * with decoded outputs asserted through the same output oracle, and
 * writes are real impersonated transactions in registry order so later
 * writes see earlier writes' state (borrow needs supply, repay needs
 * borrow).
 *
 * What a green Tier 1 run proves: the action's encoding and its
 * semantics against the real (forked) protocol contracts. What it does
 * not prove: the platform's webhook/executor/signing path - that is
 * Tier 2's job, which only needs representatives because that path is
 * shared by all actions.
 *
 * Skips follow testData.skipped with the same reasons as the e2e suites.
 */

import { Contract, Interface, JsonRpcProvider, parseUnits } from "ethers";
import { expect, test } from "vitest";
import { getProtocol, type ProtocolDefinition } from "@/lib/protocol-registry";
import { resolveBinding } from "@/lib/test-data/build-workflow";
import { TOKEN_REGISTRY } from "@/lib/test-data/chain-test-data";
import {
  type EncodedAction,
  encodeBoundAction,
  encodeSetupSteps,
} from "@/lib/test-data/encode-action";
import { planPhaseFixtures } from "@/lib/test-data/plan";
import type { SetupOutputs } from "@/lib/test-data/types";
import { structureAbiOutputs } from "@/plugins/web3/steps/structure-abi-result";
import {
  ERC20_ABI,
  ensureErc20Acquired,
  runActionFabrications,
  runFabricatedApprovals,
  runForkImpersonatedCalls,
  withImpersonation,
} from "../../protocol-coverage/_shared/funding";
import { checkOutputExpectation } from "../../protocol-coverage/_shared/oracle";

/** Fixed simulation wallet: any address works under impersonation; fixed
 *  keeps behavior reproducible across runs. Distinct from anvil's dev
 *  accounts to avoid colliding with their pre-existing nonces/balances. */
export const SIM_WALLET = "0x5115000000000000000000000000000000000051";

const WRITE_TIMEOUT_MS = 120_000;
// Hang guard, not a performance assertion. 30s was measured too tight for
// the largest cold-read fan-outs through an archive upstream (a MetaMorpho
// totalAssets first touch exceeded it); cache-loaded forks make warmed
// reads near-instant, so the headroom costs nothing on the happy path.
const READ_TIMEOUT_MS = 90_000;

/** Mirror of the platform gas strategy's default 2.0x estimate multiplier
 *  (lib/web3/gas-defaults.ts GLOBAL_DEFAULT). Sending with the node-filled
 *  exact estimate OOGs on time-dependent gas: savings-rate vaults (sUSDS,
 *  stUSDS, sDAI) run a drip whose cost moves between the estimation block
 *  and the execution block, and the exact-estimate send dies with
 *  status-0 receipts at gasUsed == gasLimit (observed on the 2026-07-08
 *  sweep; same mechanism as the USDCx OOG note in the methodology doc). */
const GAS_LIMIT_MULTIPLIER = BigInt(2);

async function sendImpersonatedOnce(
  provider: JsonRpcProvider,
  from: string,
  tx: { to: string; data?: string; value?: bigint }
): Promise<void> {
  await withImpersonation(provider, from, async (signer) => {
    const estimated = await signer.estimateGas(tx);
    const sent = await signer.sendTransaction({
      ...tx,
      gasLimit: estimated * GAS_LIMIT_MULTIPLIER,
    });
    const receipt = await sent.wait();
    if (receipt?.status !== 1) {
      throw new Error(`impersonated tx to ${tx.to} reverted`);
    }
  });
}

async function impersonatedSend(
  provider: JsonRpcProvider,
  from: string,
  tx: { to: string; data?: string; value?: bigint }
): Promise<void> {
  try {
    await sendImpersonatedOnce(provider, from, tx);
  } catch {
    // A reverted send left no state behind, so one retry is safe. Public
    // fork upstreams intermittently serve stale slots to mid-execution
    // state fetches, producing reason-less reverts that replay green on
    // the same fork moments later; the retry absorbs exactly that class,
    // while a genuine revert fails again deterministically.
    await new Promise((resolve) => setTimeout(resolve, 2000));
    await sendImpersonatedOnce(provider, from, tx);
  }
}

async function provisionSetup(
  provider: JsonRpcProvider,
  protocolSlug: string,
  chainId: string,
  rpcUrl: string
): Promise<void> {
  const protocol = getProtocol(protocolSlug);
  const setup = protocol?.testData?.[chainId]?.setup;
  if (!(protocol && setup)) {
    throw new Error(`no setup spec for ${protocolSlug} on ${chainId}`);
  }

  // 10 ETH native gas via cheatcode.
  await provider.send("anvil_setBalance", [SIM_WALLET, "0x8ac7230489e80000"]);

  // Privileged third-party provisioning (impersonated wards etc.) runs
  // before token acquisition and setup steps, same as the coverage
  // preflight; the rpcUrl override skips the chains-table lookup.
  await runForkImpersonatedCalls(protocolSlug, chainId, SIM_WALLET, rpcUrl);

  for (const required of setup.requiredTokens) {
    // Shared with the coverage suites' preflight; the rpcUrl override
    // skips its chains-table lookup (this tier has no database).
    await ensureErc20Acquired(
      chainId,
      SIM_WALLET,
      required.symbol,
      required.human,
      rpcUrl
    );
  }

  // Fork-only setup allowances written straight to storage (parity with
  // the coverage preflight); no-op when the protocol declares none.
  await runFabricatedApprovals(protocolSlug, chainId, SIM_WALLET, rpcUrl);

  for (const approval of setup.approvals) {
    const entry = TOKEN_REGISTRY[chainId]?.[approval.token];
    if (!entry) {
      throw new Error(`TOKEN_REGISTRY missing ${approval.token}`);
    }
    // Same resolver the builder uses for approval.spender, including its
    // throw on a missing contract address (an empty spender would encode
    // approve(0x0) and revert opaquely downstream).
    const spender = resolveBinding(
      approval.spender,
      "address",
      protocol,
      chainId,
      SIM_WALLET
    );
    const token = new Contract(entry.address, ERC20_ABI, provider);
    await impersonatedSend(provider, SIM_WALLET, {
      to: entry.address,
      data: token.interface.encodeFunctionData("approve", [
        spender,
        parseUnits(approval.human, entry.decimals),
      ]),
    });
  }

  // Setup steps encode from the setup workflow's own node configs (their
  // inputs differ from the action fixtures), impersonated in order.
  for (const step of encodeSetupSteps(protocolSlug, chainId, SIM_WALLET)) {
    await impersonatedSend(provider, SIM_WALLET, {
      to: step.to,
      data: step.data,
      value: step.value,
    });
  }
}

function serializeResult(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v))
  );
}

// Output-bearing fragment for the GDAv1Forwarder.createPool capture. The
// registry action strips the outputs (write actions show none), but the
// on-chain function returns (bool success, address pool); an eth_call of the
// producer's calldata returns those, so the harness reads the pool address
// without decoding an event log.
const GDA_CREATE_POOL_RETURN_ABI = [
  "function createPool(address,address,(bool,bool)) returns (bool success, address pool)",
];

/**
 * Run the (protocol, chain) fork-tier captures and return their values as
 * SetupOutputs for fromSetupOutput bindings. Runs after setup provisioning
 * and before the action sweep. For the "gda-pool" kind it eth_calls the
 * producer's calldata to read the (bool, address) return, then sends the same
 * tx at the same nonce so the pool deploys at exactly that address:
 * provisioning it here (rather than relying on the create-pool action in the
 * sweep) decouples the GDA consumers from sweep ordering and guarantees the
 * pool exists when they run. See OutputCapture in lib/test-data/types.ts.
 */
async function captureOutputs(
  provider: JsonRpcProvider,
  protocol: ProtocolDefinition,
  chainId: string
): Promise<SetupOutputs> {
  const captures = protocol.testData?.[chainId]?.captures;
  const out: SetupOutputs = {};
  if (!captures) {
    return out;
  }
  const iface = new Interface(GDA_CREATE_POOL_RETURN_ABI);
  for (const [producerSlug, capture] of Object.entries(captures)) {
    const action = protocol.actions.find((a) => a.slug === producerSlug);
    if (!action) {
      throw new Error(`capture references unknown action "${producerSlug}"`);
    }
    // capture.kind is "gda-pool" (the only kind today).
    const encoded = encodeBoundAction(protocol, action, chainId, SIM_WALLET);
    const ret = await provider.call({
      to: encoded.to,
      data: encoded.data,
      from: SIM_WALLET,
    });
    // Return is (bool success, address pool); take the pool at index 1.
    const pool = String(iface.decodeFunctionResult("createPool", ret)[1]);
    await impersonatedSend(provider, SIM_WALLET, {
      to: encoded.to,
      data: encoded.data,
      value: encoded.value,
    });
    out[capture.as] = { ...(out[capture.as] ?? {}), [capture.field]: pool };
  }
  return out;
}

async function runRead(
  provider: JsonRpcProvider,
  encoded: EncodedAction
): Promise<unknown> {
  const ret = await provider.call({
    to: encoded.to,
    data: encoded.data,
    from: SIM_WALLET,
  });
  const fragment = encoded.ethersFragment as Parameters<
    Interface["decodeFunctionResult"]
  >[0];
  const decoded = encoded.iface.decodeFunctionResult(fragment, ret);
  const values = serializeResult([...decoded]);
  return structureAbiOutputs(values as unknown[], encoded.abiOutputs);
}

export function runSimulation(opts: {
  protocol: string;
  chainId: string;
  rpcUrl: string;
}): void {
  const protocol = getProtocol(opts.protocol);
  if (!protocol) {
    test.skip(`protocol ${opts.protocol} not registered`, () => {
      /* no-op */
    });
    return;
  }
  const provider = new JsonRpcProvider(opts.rpcUrl, undefined, {
    staticNetwork: true,
    // See simulate-events.ts: this harness mutates chain state between
    // reads, so ethers' 250ms same-request cache can serve a pre-mutation
    // block to a post-mutation read.
    cacheTimeout: -1,
  });

  // Populated by the provision step below and read by the action tests
  // (fromSetupOutput bindings). Tests in a file run in order, so captures
  // are recorded before any action that consumes them, mirroring how the
  // write sweep relies on registry order for its own state dependencies.
  const capturedOutputs: SetupOutputs = {};

  test(
    `setup: provision ${opts.protocol} state`,
    async () => {
      await provisionSetup(provider, opts.protocol, opts.chainId, opts.rpcUrl);
      Object.assign(
        capturedOutputs,
        await captureOutputs(provider, protocol, opts.chainId)
      );
    },
    WRITE_TIMEOUT_MS * 3
  );

  const expectations = protocol.testData?.[opts.chainId]?.expectations ?? {};
  const writeExpectations =
    protocol.testData?.[opts.chainId]?.writeExpectations ?? {};

  for (const phase of ["read", "write"] as const) {
    const plan = planPhaseFixtures(
      protocol,
      opts.protocol,
      opts.chainId,
      phase
    );
    for (const c of plan) {
      if (c.kind === "no-actions") {
        continue;
      }
      if (c.kind === "no-protocol") {
        continue;
      }
      if (c.kind === "skip") {
        test.skip(`${phase} ${c.action.slug} (${c.reason})`, () => {
          /* documented in testData.skipped */
        });
        continue;
      }
      const action = c.action;
      test(
        `${phase} ${action.slug}`,
        async () => {
          const encoded = encodeBoundAction(
            protocol,
            action,
            opts.chainId,
            SIM_WALLET,
            capturedOutputs
          );
          if (phase === "read") {
            const result = await runRead(provider, encoded);
            const checks = expectations[action.slug] ?? [];
            for (const expectation of checks) {
              const failure = checkOutputExpectation(
                { success: true, result },
                expectation
              );
              expect(failure, failure ?? "").toBeNull();
            }
          } else {
            // Cheatcode preconditions declared for this action (e.g.
            // marking the wallet's real sUSDe cooldown elapsed before
            // unstake); no-op for actions that declare none.
            await runActionFabrications(
              opts.protocol,
              opts.chainId,
              SIM_WALLET,
              action.slug,
              opts.rpcUrl
            );
            await impersonatedSend(provider, SIM_WALLET, {
              to: encoded.to,
              data: encoded.data,
              value: encoded.value,
            });
            // Post-write oracle: a mined receipt alone cannot prove the
            // write did the right thing, so probe declared read actions
            // against the post-state. See writeExpectations in
            // lib/test-data/types.ts.
            for (const check of writeExpectations[action.slug] ?? []) {
              const readAction = protocol.actions.find(
                (a) => a.slug === check.read
              );
              if (!readAction) {
                throw new Error(
                  `writeExpectations for ${action.slug} references unknown read action "${check.read}"`
                );
              }
              const probe = encodeBoundAction(
                protocol,
                readAction,
                opts.chainId,
                SIM_WALLET,
                capturedOutputs
              );
              const result = await runRead(provider, probe);
              const failure = checkOutputExpectation(
                { success: true, result },
                check.expect
              );
              expect(failure, failure ?? "").toBeNull();
            }
          }
        },
        phase === "read" ? READ_TIMEOUT_MS : WRITE_TIMEOUT_MS
      );
    }
  }
}
