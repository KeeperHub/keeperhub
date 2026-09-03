/**
 * Unit tests for KEEP-458 programmatic workflow builders.
 *
 * Walks every (protocol, chain) with co-located testData, builds the setup +
 * all read/write workflows across all 5 trigger types, and asserts the built
 * shape matches what the executor expects. Replaces the prior on-disk
 * fixture validator with a runtime check — no JSON tree to keep in sync.
 *
 * Pure logic — no DB, no RPC. Runs on every PR via `pnpm test:unit`.
 */

import { describe, expect, it } from "vitest";
import "@/protocols";
import { getProtocol } from "@/lib/protocol-registry";
import {
  buildActionWorkflow,
  buildSetupWorkflow,
  listCoverageTargets,
  resolveBinding,
  TRIGGER_TYPES,
  toWebhookTriggered,
} from "@/lib/test-data/build-workflow";
import { amount, fromSetupOutput, wallet } from "@/lib/test-data/types";

const HEX_ADDRESS_REGEX = /^0x[0-9a-fA-F]{40}$/;
// Builder takes the persistent test wallet address as a runtime parameter
// (KEEP-529 made it HSM-generated, so the address differs per environment).
// The unit test passes a fixed placeholder; structural assertions still hold.
const TEST_WALLET = "0x0000000000000000000000000000000000000001";
const targets = listCoverageTargets();

describe("KEEP-458 build-workflow", () => {
  it("at least one protocol carries testData", () => {
    expect(targets.length).toBeGreaterThan(0);
  });

  for (const { protocolSlug, chainId } of targets) {
    describe(`${protocolSlug} (chain ${chainId})`, () => {
      const protocol = getProtocol(protocolSlug);

      describe("setup workflow", () => {
        const setup = buildSetupWorkflow({
          protocolSlug,
          chainId,
          walletAddress: TEST_WALLET,
        });

        it("approve nodes reference web3/approve-token with required keys", () => {
          const approveNodes = setup.nodes.filter(
            (n) =>
              n.type === "action" &&
              n.data?.config?.actionType === "web3/approve-token"
          );
          for (const node of approveNodes) {
            const cfg = node.data.config ?? {};
            expect(cfg.network).toBe(chainId);
            expect(cfg.tokenConfig).toEqual(expect.any(String));
            expect(cfg.spenderAddress).toMatch(HEX_ADDRESS_REGEX);
            expect(cfg.amount).toEqual(expect.any(String));
          }
        });
      });

      describe("action workflows", () => {
        if (!protocol) {
          return;
        }

        for (const action of protocol.actions) {
          // Per-variant coverage exists to catch builder bugs that only
          // surface for one trigger type. Bulk-iterating all 5 triggers
          // catches those without exploding into 5x assertions per check.
          for (const trigger of TRIGGER_TYPES) {
            const variant = `${action.slug} [${trigger}]`;
            describe(variant, () => {
              const built = buildActionWorkflow({
                protocolSlug,
                actionSlug: action.slug,
                chainId,
                trigger,
                walletAddress: TEST_WALLET,
              });

              it("emits exactly one trigger and at least one action node", () => {
                expect(
                  built.nodes.filter((n) => n.type === "trigger")
                ).toHaveLength(1);
                expect(built.nodes.some((n) => n.type === "action")).toBe(true);
              });

              it("action node agrees with the protocol registry", () => {
                const actionNode = built.nodes.find((n) => n.type === "action");
                expect(actionNode).toBeDefined();
                const cfg = actionNode?.data?.config ?? {};
                expect(cfg.actionType).toBe(`${protocolSlug}/${action.slug}`);
                expect(cfg.network).toBe(chainId);
                const meta = JSON.parse(cfg._protocolMeta as string) as {
                  protocolSlug: string;
                  contractKey: string;
                  functionName: string;
                  actionType: "read" | "write";
                };
                expect(meta.protocolSlug).toBe(protocolSlug);
                expect(meta.contractKey).toBe(action.contract);
                expect(meta.functionName).toBe(action.function);
                expect(meta.actionType).toBe(action.type);
              });

              it("required action inputs are present", () => {
                const actionNode = built.nodes.find((n) => n.type === "action");
                const cfg = actionNode?.data?.config ?? {};
                const required = action.inputs.filter(
                  (i) => i.required ?? i.default === undefined
                );
                for (const input of required) {
                  expect(cfg).toHaveProperty(input.name);
                }
              });

              it("network is a registered deployment of the action's contract", () => {
                const contractDef = protocol.contracts[action.contract];
                expect(contractDef).toBeDefined();
                // Skipped actions may reference a contract with no
                // deployment on this chain (e.g. chronicle's DAI/USD feed
                // and SelfKisser on mainnet) - the skip reason documents
                // the gap and the Tier 0 goldens record them as
                // unencodable-while-skipped. Runnable actions must
                // resolve a real deployment.
                const skippedHere =
                  protocol.testData?.[chainId]?.skipped?.[action.slug] !==
                  undefined;
                if (
                  contractDef &&
                  !(contractDef.userSpecifiedAddress || skippedHere)
                ) {
                  expect(contractDef.addresses[chainId]).toBeTruthy();
                }
              });

              it("_executable reflects the chainData enabled flag", () => {
                // Targets come from listCoverageTargets() so chainData is
                // guaranteed present; without an explicit enabled:false the
                // workflow is executable. Catches a regression where the
                // builder ignored chainData.enabled or hardcoded the flag.
                const chainData = protocol.testData?.[chainId];
                expect(chainData).toBeDefined();
                const expected = chainData?.enabled !== false;
                expect(built._executable).toBe(expected);
              });
            });
          }
        }
      });
    });
  }
});

/**
 * Metadata-roundtrip coverage. The per-action bulk loop above no longer
 * asserts these per variant -- one pinpoint test for each metadata field is
 * sufficient to catch a builder regression that ignores its input args (the
 * bug would fire identically across every variant, so 115 redundant
 * assertions add no signal). Anchored on aave-v3/supply because it covers
 * read/write/setup-style inputs without depending on the wider iteration.
 */
describe("KEEP-458 builders honour their inputs", () => {
  it("setup workflow takes _phase=setup, _trigger=Manual, _protocol, _chainId", () => {
    const setup = buildSetupWorkflow({
      protocolSlug: "aave-v3",
      chainId: "11155111",
      walletAddress: TEST_WALLET,
    });
    expect(setup._phase).toBe("setup");
    expect(setup._trigger).toBe("Manual");
    expect(setup._protocol).toBe("aave-v3");
    expect(setup._chainId).toBe("11155111");
  });

  it.each([
    ...TRIGGER_TYPES,
  ])("action workflow with trigger=%s round-trips all metadata", (trigger) => {
    const built = buildActionWorkflow({
      protocolSlug: "aave-v3",
      actionSlug: "supply",
      chainId: "11155111",
      trigger,
      walletAddress: TEST_WALLET,
    });
    expect(built._trigger).toBe(trigger);
    expect(built._phase).toBe("write");
    expect(built._protocol).toBe("aave-v3");
    expect(built._chainId).toBe("11155111");
  });
});

/**
 * Pinpoint check that the `walletAddress` arg actually propagates through
 * the builder to the resolved config. A regression where the builder ignored
 * the parameter (e.g. fell back to a hardcoded constant) would slip past the
 * bulk per-action assertions above.
 */
describe("KEEP-458 wallet address propagation", () => {
  it("resolves wallet() bindings to the caller-supplied address", () => {
    const built = buildActionWorkflow({
      protocolSlug: "aave-v3",
      actionSlug: "supply",
      chainId: "11155111",
      trigger: "Manual",
      walletAddress: TEST_WALLET,
    });
    const actionNode = built.nodes.find((n) => n.type === "action");
    expect(actionNode?.data?.config?.onBehalfOf).toBe(TEST_WALLET);
  });
});

/**
 * Direct coverage for `toWebhookTriggered`. The function is the load-bearing
 * fix that lets the test runner fire any-trigger workflows via the
 * webhook endpoint (which rejects non-Webhook triggers with HTTP 400).
 * Losing it silently would re-introduce that bug.
 */
describe("KEEP-458 toWebhookTriggered", () => {
  const built = buildActionWorkflow({
    protocolSlug: "aave-v3",
    actionSlug: "supply",
    chainId: "11155111",
    trigger: "Schedule",
    walletAddress: TEST_WALLET,
  });
  const rewritten = toWebhookTriggered(built);

  it("rewrites the trigger node's config to {triggerType: 'Webhook'}", () => {
    const trigger = rewritten.nodes.find((n) => n.type === "trigger");
    expect(trigger?.data?.config).toEqual({ triggerType: "Webhook" });
  });

  it("updates the _trigger metadata to 'Webhook'", () => {
    expect(rewritten._trigger).toBe("Webhook");
  });

  it("leaves action nodes byte-identical to the source", () => {
    const sourceAction = built.nodes.find((n) => n.type === "action");
    const rewrittenAction = rewritten.nodes.find((n) => n.type === "action");
    expect(rewrittenAction).toEqual(sourceAction);
  });

  it("does not mutate the input workflow", () => {
    const sourceTrigger = built.nodes.find((n) => n.type === "trigger");
    expect(sourceTrigger?.data?.config).toEqual({
      triggerType: "Schedule",
      cron: "0 0 * * *",
      timezone: "UTC",
    });
  });
});

/**
 * Direct coverage for `resolveBinding`'s wallet() gating. wallet() must only
 * resolve on scalar `address` inputs -- honouring it on a uint/bool/bytes
 * slot would silently encode a 0x-prefixed string into the wrong ABI type
 * and the engine would surface a much less actionable error downstream.
 * This is symmetric with the existing string-token-symbol path, which also
 * only resolves on `inputType === "address"`.
 */
describe("KEEP-458 resolveBinding wallet() gating", () => {
  const protocol = getProtocol("aave-v3");
  if (!protocol) {
    throw new Error("aave-v3 must be registered for this test");
  }

  it("resolves wallet() on a scalar address input", () => {
    expect(
      resolveBinding(wallet(), "address", protocol, "11155111", TEST_WALLET)
    ).toBe(TEST_WALLET);
  });

  it("throws when wallet() is bound to a uint256 input", () => {
    expect(() =>
      resolveBinding(wallet(), "uint256", protocol, "11155111", TEST_WALLET)
    ).toThrowError(/wallet\(\) binding on a non-address input/);
  });

  it("throws when wallet() is bound to a bool input", () => {
    expect(() =>
      resolveBinding(wallet(), "bool", protocol, "11155111", TEST_WALLET)
    ).toThrowError(/non-address input/);
  });

  it("throws on address[] (array types are not honoured)", () => {
    // Symmetric with the string-symbol path's exact `=== "address"` check.
    // Array slots need explicit handling; wallet() on `address[]` is almost
    // certainly a user error and must fail loud.
    expect(() =>
      resolveBinding(wallet(), "address[]", protocol, "11155111", TEST_WALLET)
    ).toThrowError(/non-address input/);
  });

  it("throws when inputType is undefined", () => {
    expect(() =>
      resolveBinding(wallet(), undefined, protocol, "11155111", TEST_WALLET)
    ).toThrowError(/non-address input/);
  });

  it("still resolves non-wallet bindings on non-address inputs", () => {
    // Sanity-check the gate is wallet-specific: amount() / native() / plain
    // strings on non-address inputs continue to resolve as before.
    expect(
      resolveBinding(
        amount("DAI", "1"),
        "uint256",
        protocol,
        "11155111",
        TEST_WALLET
      )
    ).toBe("1000000000000000000");
    expect(
      resolveBinding("0", "uint16", protocol, "11155111", TEST_WALLET)
    ).toBe("0");
  });
});

/**
 * fromSetupOutput piping: a binding that resolves to a value a prior step
 * produced (Superfluid GDA pool actions bind the pool create-pool deploys).
 * The resolver reads the value from the SetupOutputs the caller passes; the
 * fork simulation harness populates it, and a skipped/skippedCoverage action
 * built without it falls back to the placeholder rather than throwing.
 */
describe("KEEP-938 resolveBinding fromSetupOutput piping", () => {
  const protocol = getProtocol("superfluid");
  if (!protocol) {
    throw new Error("superfluid must be registered for this test");
  }
  const POOL = "0x1234567890123456789012345678901234567890";
  const captures = { "create-pool": { pool: POOL } };

  it("resolves to the captured value when the capture is present", () => {
    expect(
      resolveBinding(
        fromSetupOutput("create-pool", "pool"),
        "address",
        protocol,
        "1",
        TEST_WALLET,
        captures
      )
    ).toBe(POOL);
  });

  it("throws when the capture is absent", () => {
    expect(() =>
      resolveBinding(
        fromSetupOutput("create-pool", "pool"),
        "address",
        protocol,
        "1",
        TEST_WALLET
      )
    ).toThrowError(/has no captured value/);
  });

  it("throws when the step is present but the field is missing", () => {
    expect(() =>
      resolveBinding(
        fromSetupOutput("create-pool", "missing"),
        "address",
        protocol,
        "1",
        TEST_WALLET,
        captures
      )
    ).toThrowError(/has no captured value/);
  });

  it("buildActionWorkflow pipes a captured value into the action config", () => {
    const built = buildActionWorkflow({
      protocolSlug: "superfluid",
      actionSlug: "connect-pool",
      chainId: "1",
      trigger: "Manual",
      walletAddress: TEST_WALLET,
      setupOutputs: captures,
    });
    const actionNode = built.nodes.find((n) => n.type === "action");
    expect(actionNode?.data?.config?.pool).toBe(POOL);
  });

  it("substitutes a placeholder for a skippedCoverage action built without the capture", () => {
    // connect-pool is in superfluid's skippedCoverage, so the builder must
    // not throw when no capture is supplied (the unit-test / seeder build
    // path) - it emits the same unused placeholder an unbound address input
    // on a skipped action gets.
    const built = buildActionWorkflow({
      protocolSlug: "superfluid",
      actionSlug: "connect-pool",
      chainId: "1",
      trigger: "Manual",
      walletAddress: TEST_WALLET,
    });
    const actionNode = built.nodes.find((n) => n.type === "action");
    expect(actionNode?.data?.config?.pool).toBe(`0x${"0".repeat(40)}`);
  });
});
