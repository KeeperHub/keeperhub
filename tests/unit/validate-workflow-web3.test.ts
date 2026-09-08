// RED phase: tests for VALID-05 (chain ID existence) and VALID-06
// (token / contract address format). All tests must FAIL before
// validate-workflow-web3.ts is created.

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  type ValidatorWorkflow,
  validateWorkflow,
} from "@/lib/mcp/validate-workflow";
import {
  actionNode,
  edge,
  makeWorkflow,
  triggerNode,
} from "./fixtures/validate-workflow";

// ---------------------------------------------------------------------------
// VALID-05: Chain ID existence (opts.chainIds)
// ---------------------------------------------------------------------------

describe("validateWorkflow — unknown-chain-id (VALID-05)", () => {
  it("passes when action node network is in the chainIds Set", () => {
    const wf = makeWorkflow({
      nodes: [triggerNode(), actionNode("a1", { network: "1" })],
      edges: [edge("e1", "trigger-1", "a1")],
    });
    const result = validateWorkflow(wf, { chainIds: new Set([1, 8453]) });
    const err = result.errors.find((e) => e.code === "unknown-chain-id");
    expect(err).toBeUndefined();
    expect(result.valid).toBe(true);
  });

  it("errors when action node network is NOT in the chainIds Set", () => {
    const wf = makeWorkflow({
      nodes: [triggerNode(), actionNode("a1", { network: "9999" })],
      edges: [edge("e1", "trigger-1", "a1")],
    });
    const result = validateWorkflow(wf, { chainIds: new Set([1, 8453]) });
    const err = result.errors.find((e) => e.code === "unknown-chain-id");
    expect(err).toBeDefined();
    expect(err?.parameterPath).toBe("nodes[1].config.network");
    expect(err?.message).toContain("9999");
  });

  it("skips a network supplied by a template reference", () => {
    // A marketplace workflow takes its chain from the caller, which the
    // Marketplace docs explicitly instruct. The value is a template resolved at
    // execution time, so there is no chain id to check statically — the address
    // checks in this module already skip these for the same reason.
    const wf = makeWorkflow({
      nodes: [
        triggerNode(),
        actionNode("a1", { network: "{{@trigger-1:Manual.network}}" }),
      ],
      edges: [edge("e1", "trigger-1", "a1")],
    });
    const result = validateWorkflow(wf, { chainIds: new Set([1, 8453]) });
    expect(
      result.errors.find((e) => e.code === "unknown-chain-id")
    ).toBeUndefined();
  });

  it.each([
    ["an unclosed template", "{{ not closed"],
    ["an empty template body", "{{}}"],
    [
      "a template that is only part of the value",
      "1{{@trigger-1:Manual.network}}",
    ],
  ])("still errors on %s", (_label, network) => {
    // The skip covers a value that is entirely one reference.
    const wf = makeWorkflow({
      nodes: [triggerNode(), actionNode("a1", { network })],
      edges: [edge("e1", "trigger-1", "a1")],
    });
    expect(
      validateWorkflow(wf, { chainIds: new Set([1, 8453]) }).errors.find(
        (e) => e.code === "unknown-chain-id"
      )
    ).toBeDefined();
  });

  it("still errors on a templated network on the trigger itself", () => {
    // Nothing resolves a trigger's own network. The event listener parses it
    // with Number() and skips the workflow when that fails, so a templated
    // trigger network registers no listener and the workflow never fires -
    // and this error is the only static signal that says why.
    const wf = makeWorkflow({
      nodes: [
        {
          id: "trigger-1",
          type: "trigger",
          data: {
            label: "Trigger",
            type: "trigger",
            config: {
              triggerType: "Event",
              network: "{{@trigger-1:Event.chainId}}",
            },
          },
        },
        actionNode("a1", { network: "1" }),
      ],
      edges: [edge("e1", "trigger-1", "a1")],
    });
    expect(
      validateWorkflow(wf, { chainIds: new Set([1, 8453]) }).errors.find(
        (e) => e.code === "unknown-chain-id"
      )
    ).toBeDefined();
  });

  it("still errors on a trigger that carries no triggerType", () => {
    // sanitize-nodes only injects triggerType for Schedule nodes, so a trigger
    // created or imported without one keeps its trigger identity through
    // data.type alone. Reading it as an action would take the skip and report
    // clean on the one node whose network nothing resolves.
    const wf = makeWorkflow({
      nodes: [
        {
          id: "trigger-1",
          type: "trigger",
          data: {
            label: "Trigger",
            type: "trigger",
            config: { network: "{{@x:Y.chainId}}" },
          },
        },
        actionNode("a1", { network: "1" }),
      ],
      edges: [edge("e1", "trigger-1", "a1")],
    });
    expect(
      validateWorkflow(wf, { chainIds: new Set([1, 8453]) }).errors.find(
        (e) => e.code === "unknown-chain-id"
      )
    ).toBeDefined();
  });

  it("skips a reference whose body contains an opening brace", () => {
    // TEMPLATE_PATTERN is /\{\{([^}]+)\}\}/g, so "{{a{b}}" resolves at
    // execution time. Rejecting it here would be the false positive this skip
    // exists to remove.
    const wf = makeWorkflow({
      nodes: [triggerNode(), actionNode("a1", { network: "{{a{b}}" })],
      edges: [edge("e1", "trigger-1", "a1")],
    });
    expect(
      validateWorkflow(wf, { chainIds: new Set([1, 8453]) }).errors.find(
        (e) => e.code === "unknown-chain-id"
      )
    ).toBeUndefined();
  });

  it("errors when network value is a non-numeric string", () => {
    const wf = makeWorkflow({
      nodes: [triggerNode(), actionNode("a1", { network: "abc" })],
      edges: [edge("e1", "trigger-1", "a1")],
    });
    const result = validateWorkflow(wf, { chainIds: new Set([1, 8453]) });
    const err = result.errors.find((e) => e.code === "unknown-chain-id");
    expect(err).toBeDefined();
    expect(err?.parameterPath).toBe("nodes[1].config.network");
  });

  it("skips chain check entirely when chainIds is undefined (no false errors)", () => {
    const wf = makeWorkflow({
      nodes: [triggerNode(), actionNode("a1", { network: "99999" })],
      edges: [edge("e1", "trigger-1", "a1")],
    });
    const result = validateWorkflow(wf);
    const err = result.errors.find((e) => e.code === "unknown-chain-id");
    expect(err).toBeUndefined();
  });

  it("skips chain check when chainIds is undefined but still runs token check", () => {
    const wf = makeWorkflow({
      nodes: [
        triggerNode(),
        actionNode("a1", {
          network: "99999",
          contractAddress: "0xnotanaddress",
        }),
      ],
      edges: [edge("e1", "trigger-1", "a1")],
    });
    const result = validateWorkflow(wf);
    const chainErr = result.errors.find((e) => e.code === "unknown-chain-id");
    const addrErr = result.errors.find(
      (e) => e.code === "invalid-token-address"
    );
    expect(chainErr).toBeUndefined();
    expect(addrErr).toBeDefined();
  });

  it("validates trigger nodes too (trigger is a node with config.network)", () => {
    const eventTrigger = {
      id: "trigger-1",
      type: "trigger",
      data: {
        label: "Event Trigger",
        type: "trigger",
        config: {
          triggerType: "Event",
          network: "9999",
          contractAddress: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
        },
      },
    };
    const wf: ValidatorWorkflow = {
      id: "wf-event",
      nodes: [eventTrigger],
      edges: [],
      inputSchema: null,
      outputMapping: null,
      isListed: false,
      workflowType: "read",
    };
    const result = validateWorkflow(wf, { chainIds: new Set([1]) });
    const err = result.errors.find((e) => e.code === "unknown-chain-id");
    expect(err).toBeDefined();
    expect(err?.parameterPath).toBe("nodes[0].config.network");
  });
});

// ---------------------------------------------------------------------------
// Pitfall 12 multi-chain regression guard: per-node network validation
// ---------------------------------------------------------------------------

describe("validateWorkflow — Pitfall 12 multi-chain regression guard", () => {
  it("validates each node's network independently — no false positives on WETH-across-chains", () => {
    // Workflow declares chain: "8453" at the top level (Base) but has two
    // nodes referencing WETH on mainnet (chain 1) and Base (chain 8453).
    // chainIds Set includes both. Expect zero errors.
    const wf: ValidatorWorkflow = {
      id: "wf-multichain",
      nodes: [
        {
          id: "trigger-1",
          type: "trigger",
          data: {
            label: "Trigger",
            type: "trigger",
            config: { triggerType: "Manual" },
          },
        },
        {
          id: "action-mainnet-weth",
          type: "action",
          data: {
            label: "Read Mainnet WETH",
            type: "action",
            config: {
              actionType: "web3/read-contract",
              network: "1",
              contractAddress: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
            },
          },
        },
        {
          id: "action-base-weth",
          type: "action",
          data: {
            label: "Read Base WETH",
            type: "action",
            config: {
              actionType: "web3/read-contract",
              network: "8453",
              contractAddress: "0x4200000000000000000000000000000000000006",
            },
          },
        },
      ],
      edges: [
        edge("e1", "trigger-1", "action-mainnet-weth"),
        edge("e2", "trigger-1", "action-base-weth"),
      ],
      inputSchema: null,
      outputMapping: null,
      isListed: false,
      workflowType: "read",
    };

    const result = validateWorkflow(wf, { chainIds: new Set([1, 8453]) });
    expect(result.errors).toHaveLength(0);
    expect(result.valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// VALID-06: Token / contract address format (ethers.isAddress)
// ---------------------------------------------------------------------------

describe("validateWorkflow — invalid-token-address (VALID-06)", () => {
  it("passes for a valid checksummed contractAddress", () => {
    const wf = makeWorkflow({
      nodes: [
        triggerNode(),
        actionNode("a1", {
          contractAddress: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
        }),
      ],
      edges: [edge("e1", "trigger-1", "a1")],
    });
    const result = validateWorkflow(wf);
    const err = result.errors.find((e) => e.code === "invalid-token-address");
    expect(err).toBeUndefined();
  });

  it("errors for an invalid contractAddress", () => {
    const wf = makeWorkflow({
      nodes: [
        triggerNode(),
        actionNode("a1", { contractAddress: "0xnotanaddress" }),
      ],
      edges: [edge("e1", "trigger-1", "a1")],
    });
    const result = validateWorkflow(wf);
    const err = result.errors.find((e) => e.code === "invalid-token-address");
    expect(err).toBeDefined();
    expect(err?.parameterPath).toBe("nodes[1].config.contractAddress");
    expect(err?.message).toContain("0xnotanaddress");
  });

  it("does NOT error for an empty contractAddress (empty is a different validation surface)", () => {
    const wf = makeWorkflow({
      nodes: [triggerNode(), actionNode("a1", { contractAddress: "" })],
      edges: [edge("e1", "trigger-1", "a1")],
    });
    const result = validateWorkflow(wf);
    const err = result.errors.find((e) => e.code === "invalid-token-address");
    expect(err).toBeUndefined();
  });

  it("does NOT error when contractAddress is absent from config", () => {
    const wf = makeWorkflow();
    const result = validateWorkflow(wf);
    const err = result.errors.find((e) => e.code === "invalid-token-address");
    expect(err).toBeUndefined();
  });

  it("passes for a valid Solana base58 contractAddress on a Solana network", () => {
    const wf = makeWorkflow({
      nodes: [
        triggerNode(),
        actionNode("a1", {
          network: "101",
          contractAddress: "4zYdhhTJJKbYJ3Yqa2WGpBi25V1JcZVVBQWYKAY9tegL",
        }),
      ],
      edges: [edge("e1", "trigger-1", "a1")],
    });
    const result = validateWorkflow(wf);
    const err = result.errors.find((e) => e.code === "invalid-token-address");
    expect(err).toBeUndefined();
  });

  it("errors for an EVM contractAddress on a Solana network, naming the Solana format", () => {
    const wf = makeWorkflow({
      nodes: [
        triggerNode(),
        actionNode("a1", {
          network: "101",
          contractAddress: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
        }),
      ],
      edges: [edge("e1", "trigger-1", "a1")],
    });
    const result = validateWorkflow(wf);
    const err = result.errors.find((e) => e.code === "invalid-token-address");
    expect(err).toBeDefined();
    expect(err?.message).toContain("not a valid Solana address");
  });

  it("errors for a Solana contractAddress on an EVM network, naming the EVM format", () => {
    const wf = makeWorkflow({
      nodes: [
        triggerNode(),
        actionNode("a1", {
          network: "1",
          contractAddress: "4zYdhhTJJKbYJ3Yqa2WGpBi25V1JcZVVBQWYKAY9tegL",
        }),
      ],
      edges: [edge("e1", "trigger-1", "a1")],
    });
    const result = validateWorkflow(wf);
    const err = result.errors.find((e) => e.code === "invalid-token-address");
    expect(err).toBeDefined();
    expect(err?.message).toContain("not a valid EVM address");
  });

  it("errors for an invalid address embedded in tokenConfig JSON (custom mode)", () => {
    const wf = makeWorkflow({
      nodes: [
        triggerNode(),
        actionNode("a1", {
          tokenConfig: JSON.stringify({
            mode: "custom",
            customToken: { address: "0xnotaddr", symbol: "X" },
          }),
        }),
      ],
      edges: [edge("e1", "trigger-1", "a1")],
    });
    const result = validateWorkflow(wf);
    const err = result.errors.find((e) => e.code === "invalid-token-address");
    expect(err).toBeDefined();
    expect(err?.parameterPath).toBe(
      "nodes[1].config.tokenConfig.customToken.address"
    );
  });

  it("does NOT error for malformed tokenConfig JSON (silently skipped — no false positives)", () => {
    const wf = makeWorkflow({
      nodes: [
        triggerNode(),
        actionNode("a1", { tokenConfig: "{malformed json" }),
      ],
      edges: [edge("e1", "trigger-1", "a1")],
    });
    const result = validateWorkflow(wf);
    const err = result.errors.find((e) => e.code === "invalid-token-address");
    expect(err).toBeUndefined();
  });

  it("does NOT error for tokenConfig JSON with mode=native (no embedded address)", () => {
    const wf = makeWorkflow({
      nodes: [
        triggerNode(),
        actionNode("a1", {
          tokenConfig: JSON.stringify({ mode: "native" }),
        }),
      ],
      edges: [edge("e1", "trigger-1", "a1")],
    });
    const result = validateWorkflow(wf);
    const err = result.errors.find((e) => e.code === "invalid-token-address");
    expect(err).toBeUndefined();
  });

  it("does NOT error for a contractAddress that is a stored-format template reference", () => {
    const wf = makeWorkflow({
      nodes: [
        triggerNode(),
        actionNode("a1", {
          contractAddress: "{{@prep:Prep.governor_address_safe}}",
        }),
      ],
      edges: [edge("e1", "trigger-1", "a1")],
    });
    const result = validateWorkflow(wf);
    const err = result.errors.find((e) => e.code === "invalid-token-address");
    expect(err).toBeUndefined();
  });

  it("treats a contractAddress containing any template token as dynamic (skips format check even with a literal prefix)", () => {
    // Policy: a value with a {{...}} token is dynamic and cannot be
    // statically format-checked, so it is skipped rather than flagged —
    // even if it carries a literal-looking prefix.
    const wf = makeWorkflow({
      nodes: [
        triggerNode(),
        actionNode("a1", { contractAddress: "0xbad{{Prep.suffix}}" }),
      ],
      edges: [edge("e1", "trigger-1", "a1")],
    });
    const result = validateWorkflow(wf);
    const err = result.errors.find((e) => e.code === "invalid-token-address");
    expect(err).toBeUndefined();
  });

  it("does NOT error for a contractAddress that is a display-format template reference", () => {
    const wf = makeWorkflow({
      nodes: [
        triggerNode(),
        actionNode("a1", { contractAddress: "{{Prep.tokenAddress}}" }),
      ],
      edges: [edge("e1", "trigger-1", "a1")],
    });
    const result = validateWorkflow(wf);
    const err = result.errors.find((e) => e.code === "invalid-token-address");
    expect(err).toBeUndefined();
  });

  it("does NOT error for a template address embedded in tokenConfig JSON", () => {
    const wf = makeWorkflow({
      nodes: [
        triggerNode(),
        actionNode("a1", {
          tokenConfig: JSON.stringify({
            mode: "custom",
            customToken: {
              address: "{{@prep:Prep.token_address}}",
              symbol: "X",
            },
          }),
        }),
      ],
      edges: [edge("e1", "trigger-1", "a1")],
    });
    const result = validateWorkflow(wf);
    const err = result.errors.find((e) => e.code === "invalid-token-address");
    expect(err).toBeUndefined();
  });

  it("STILL errors for a literal non-address contractAddress (template skip does not mask real errors)", () => {
    const wf = makeWorkflow({
      nodes: [
        triggerNode(),
        actionNode("a1", { contractAddress: "0xnotanaddress" }),
      ],
      edges: [edge("e1", "trigger-1", "a1")],
    });
    const result = validateWorkflow(wf);
    const err = result.errors.find((e) => e.code === "invalid-token-address");
    expect(err).toBeDefined();
    expect(err?.message).toContain("0xnotanaddress");
  });

  it("does NOT crash or error on deeply malformed / adversarial node config", () => {
    const wf: ValidatorWorkflow = {
      id: "wf-adversarial",
      nodes: [
        {
          id: "trigger-1",
          data: { type: "trigger", config: { triggerType: "Manual" } },
        },
        null as unknown as object,
        { id: "a1", data: null },
        { id: "a2", data: { config: null } },
        { id: "a3" },
      ],
      edges: [],
      inputSchema: null,
      outputMapping: null,
      isListed: false,
      workflowType: "read",
    };
    expect(() => validateWorkflow(wf)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Opts signature: validateWorkflow(workflow, opts?)
// ---------------------------------------------------------------------------

describe("validateWorkflow — opts signature", () => {
  it("accepts no opts argument (backward-compat)", () => {
    const result = validateWorkflow(makeWorkflow());
    expect(result.valid).toBe(true);
  });

  it("accepts empty opts object", () => {
    const result = validateWorkflow(makeWorkflow(), {});
    expect(result.valid).toBe(true);
  });

  it("accepts opts.chainIds as a Set<number>", () => {
    const result = validateWorkflow(makeWorkflow(), {
      chainIds: new Set([1, 8453]),
    });
    expect(result.valid).toBe(true);
  });
});
