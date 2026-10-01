/**
 * Event-trigger registration checks.
 *
 * Each case here is a condition under which the event tracker declines to
 * register the workflow, logs it inside its own pod, and leaves the workflow
 * reporting Enabled while never running. The differential suite in
 * validate-workflow-trigger-differential.test.ts pins these against the real
 * `buildRegistration`; this file asserts the code, the message and the
 * parameterPath a caller actually reads.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  type ValidatorWorkflow,
  validateWorkflow,
} from "@/lib/mcp/validate-workflow";
import type { ProtocolEventAddressResolver } from "@/lib/mcp/validate-workflow-trigger";
import { resolveProtocolEventAddress } from "@/lib/workflow/protocol-event-address";
import { actionNode, edge, makeWorkflow } from "./fixtures/validate-workflow";

const CONTRACT = "0x6B175474E89094C44Da98b954EedeAC495271d0F";

const TRANSFER_EVENT = {
  type: "event",
  name: "Transfer",
  inputs: [
    { name: "from", type: "address", indexed: true },
    { name: "to", type: "address", indexed: true },
    { name: "value", type: "uint256", indexed: false },
  ],
  anonymous: false,
};

const APPROVAL_EVENT = {
  type: "event",
  name: "Approval",
  inputs: [{ name: "owner", type: "address", indexed: true }],
  anonymous: false,
};

function eventTrigger(overrides: Record<string, unknown> = {}) {
  return {
    id: "trigger-1",
    type: "trigger",
    data: {
      label: "Event",
      type: "trigger",
      config: {
        triggerType: "Event",
        network: "1",
        contractAddress: CONTRACT,
        contractABI: JSON.stringify([TRANSFER_EVENT, APPROVAL_EVENT]),
        eventName: "Transfer",
        ...overrides,
      },
    },
  };
}

function validateTrigger(
  overrides: Record<string, unknown> = {},
  opts: {
    chainIds?: Set<number>;
    chainWebsockets?: Map<number, string | null>;
    resolveProtocolEventAddress?: ProtocolEventAddressResolver;
  } = {}
) {
  const wf: ValidatorWorkflow = makeWorkflow({
    nodes: [eventTrigger(overrides), actionNode("a1", { network: "1" })],
    edges: [edge("e1", "trigger-1", "a1")],
  });
  return validateWorkflow(wf, {
    chainIds: opts.chainIds ?? new Set([1]),
    chainWebsockets:
      opts.chainWebsockets ?? new Map([[1, "wss://mainnet.example/ws"]]),
    resolveProtocolEventAddress:
      opts.resolveProtocolEventAddress ?? resolveProtocolEventAddress,
  });
}

function codes(result: { errors: { code: string }[] }): string[] {
  return result.errors.map((e) => e.code);
}

describe("Event trigger registration", () => {
  it("accepts a fully configured trigger", () => {
    const result = validateTrigger();
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it("reports a chain with no WebSocket endpoint", () => {
    const result = validateTrigger(
      {},
      { chainWebsockets: new Map([[1, null]]) }
    );
    const err = result.errors.find(
      (e) => e.code === "trigger-chain-has-no-websocket"
    );
    expect(err).toBeDefined();
    expect(err?.parameterPath).toBe("nodes[0].config.network");
    expect(result.valid).toBe(false);
  });

  it("reports a WebSocket column holding a non-WebSocket URL", () => {
    const result = validateTrigger(
      {},
      { chainWebsockets: new Map([[1, "https://mainnet.example"]]) }
    );
    expect(codes(result)).toContain("trigger-chain-has-no-websocket");
  });

  it("skips the WebSocket check when the caller supplies no chain map", () => {
    const wf = makeWorkflow({
      nodes: [eventTrigger()],
      edges: [],
    });
    // No chainWebsockets: the check must not fire rather than report every
    // trigger as unregisterable.
    const result = validateWorkflow(wf, { chainIds: new Set([1]) });
    expect(codes(result)).not.toContain("trigger-chain-has-no-websocket");
  });

  it("reports a missing contract address", () => {
    const result = validateTrigger({ contractAddress: "" });
    const err = result.errors.find(
      (e) => e.code === "trigger-missing-contract-address"
    );
    expect(err?.parameterPath).toBe("nodes[0].config.contractAddress");
  });

  it("allows a missing address the events route resolves from a protocol slug", () => {
    // The Hub's create-from-protocol-event path builds a trigger with no
    // contractAddress; app/api/workflows/events/route.ts fills it in from
    // these two fields before the tracker ever sees the node.
    const result = validateTrigger({
      contractAddress: "",
      _eventProtocolSlug: "safe",
      _eventSlug: "added-owner",
    });
    expect(codes(result)).not.toContain("trigger-missing-contract-address");
  });

  it("reports a protocol event whose protocol is not deployed on the trigger's chain", () => {
    // The slugs are present, but the route resolves nothing for this chain,
    // so the address stays empty and the tracker refuses the workflow.
    const result = validateTrigger(
      {
        network: "11155111",
        contractAddress: "",
        _eventProtocolSlug: "safe",
        _eventSlug: "added-owner",
      },
      {
        chainIds: new Set([1, 11_155_111]),
        chainWebsockets: new Map([[11_155_111, "wss://sepolia.example/ws"]]),
      }
    );
    const err = result.errors.find(
      (e) => e.code === "trigger-missing-contract-address"
    );
    expect(err?.parameterPath).toBe("nodes[0].config.contractAddress");
    expect(err?.message).toContain("safe/added-owner");
  });

  it("reports empty protocol slugs, which the route reads as absent", () => {
    const result = validateTrigger({
      contractAddress: "",
      _eventProtocolSlug: "",
      _eventSlug: "",
    });
    expect(codes(result)).toContain("trigger-missing-contract-address");
  });

  it("skips a protocol-event address when the caller supplies no resolver", () => {
    const wf = makeWorkflow({
      nodes: [
        eventTrigger({
          contractAddress: "",
          _eventProtocolSlug: "safe",
          _eventSlug: "added-owner",
        }),
      ],
      edges: [],
    });
    const result = validateWorkflow(wf, { chainIds: new Set([1]) });
    expect(codes(result)).not.toContain("trigger-missing-contract-address");
  });

  it("does not run on a Solana Event trigger", () => {
    // Solana triggers store programId and idl and register through the
    // Solana tracker, never buildRegistration.
    const wf = makeWorkflow({
      nodes: [
        {
          id: "trigger-1",
          type: "trigger",
          data: {
            label: "Event",
            type: "trigger",
            config: {
              triggerType: "Event",
              network: "101",
              programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
              idl: "{}",
              eventName: "Transfer",
            },
          },
        },
      ],
      edges: [],
    });
    const result = validateWorkflow(wf, {
      chainIds: new Set([101]),
      chainWebsockets: new Map([[101, null]]),
      resolveProtocolEventAddress,
    });
    expect(codes(result).filter((c) => c.startsWith("trigger-"))).toEqual([]);
  });

  it("reports a missing event name", () => {
    const result = validateTrigger({ eventName: "" });
    const err = result.errors.find(
      (e) => e.code === "trigger-missing-event-name"
    );
    expect(err?.parameterPath).toBe("nodes[0].config.eventName");
  });

  it("reports a missing ABI", () => {
    const result = validateTrigger({ contractABI: "" });
    expect(codes(result)).toContain("trigger-missing-abi");
  });

  it("reports an ABI that is not JSON", () => {
    const result = validateTrigger({ contractABI: "{not json" });
    expect(codes(result)).toContain("trigger-abi-not-json");
  });

  it("reports an ABI that is not an array", () => {
    const result = validateTrigger({
      contractABI: JSON.stringify({ type: "event" }),
    });
    expect(codes(result)).toContain("trigger-abi-not-array");
  });

  it("reports an ABI with no event fragments", () => {
    const result = validateTrigger({
      contractABI: JSON.stringify([{ type: "function", name: "transfer" }]),
    });
    expect(codes(result)).toContain("trigger-abi-has-no-events");
  });

  it("reports an event fragment with no inputs array", () => {
    // buildEventAbi maps over inputs with no guard, so this throws inside the
    // tracker and drops the whole workflow, including the wanted event.
    const result = validateTrigger({
      contractABI: JSON.stringify([
        TRANSFER_EVENT,
        { type: "event", name: "Broken" },
      ]),
    });
    const err = result.errors.find(
      (e) => e.code === "trigger-abi-event-missing-inputs"
    );
    expect(err).toBeDefined();
    expect(err?.message).toContain("Broken");
  });

  it("reports an event name absent from the ABI and lists what is there", () => {
    const result = validateTrigger({ eventName: "Nonexistent" });
    const err = result.errors.find(
      (e) => e.code === "trigger-event-not-in-abi"
    );
    expect(err?.message).toContain("Transfer");
    expect(err?.message).toContain("Approval");
  });

  it("accepts an eventName in full signature form", () => {
    // The listener resolves through iface.getEvent, which takes a signature.
    const result = validateTrigger({
      eventName: "Transfer(address,address,uint256)",
    });
    expect(result.errors).toEqual([]);
  });

  it("reports a bare eventName that matches more than one overload", () => {
    const result = validateTrigger({
      contractABI: JSON.stringify([
        TRANSFER_EVENT,
        {
          type: "event",
          name: "Transfer",
          inputs: [{ name: "value", type: "uint256", indexed: false }],
        },
      ]),
    });
    const err = result.errors.find(
      (e) => e.code === "trigger-event-name-ambiguous"
    );
    expect(err?.parameterPath).toBe("nodes[0].config.eventName");
  });

  it("reports an event whose tuple input the tracker's interface drops", () => {
    // buildEventAbi serialises `tuple order` with no components, which ethers
    // cannot parse, so the fragment is absent when the listener looks it up.
    const result = validateTrigger({
      eventName: "Filled",
      contractABI: JSON.stringify([
        TRANSFER_EVENT,
        {
          type: "event",
          name: "Filled",
          inputs: [
            {
              name: "order",
              type: "tuple",
              indexed: false,
              components: [{ name: "maker", type: "address" }],
            },
          ],
        },
      ]),
    });
    expect(codes(result)).toContain("trigger-event-not-in-abi");
  });

  it("reports an event fragment whose inputs contain null", () => {
    const result = validateTrigger({
      contractABI: JSON.stringify([
        TRANSFER_EVENT,
        { type: "event", name: "Broken", inputs: [null] },
      ]),
    });
    expect(codes(result)).toContain("trigger-abi-event-missing-inputs");
  });

  it("does not run on a non-Event trigger", () => {
    const wf = makeWorkflow({
      nodes: [
        {
          id: "trigger-1",
          type: "trigger",
          data: {
            label: "Schedule",
            type: "trigger",
            config: { triggerType: "Schedule", scheduleCron: "*/5 * * * *" },
          },
        },
      ],
      edges: [],
    });
    const result = validateWorkflow(wf, {
      chainIds: new Set([1]),
      chainWebsockets: new Map([[1, null]]),
    });
    expect(codes(result).filter((c) => c.startsWith("trigger-"))).toEqual([]);
  });

  it("leaves a legacy chain name to the existing chain check", () => {
    // The tracker parses with Number(), so "ethereum" is refused there. The
    // existing unknown-chain-id check already reports it; this module must not
    // resolve the name and pass the trigger as registerable.
    const result = validateTrigger({ network: "ethereum" });
    expect(codes(result)).toContain("unknown-chain-id");
    expect(result.valid).toBe(false);
  });
});
