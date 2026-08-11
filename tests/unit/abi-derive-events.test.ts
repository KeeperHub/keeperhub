import { describe, expect, it } from "vitest";
import {
  type AbiDrivenContract,
  deriveEventsFromAbi,
} from "@/lib/abi/protocol-derive";

function contract(
  abi: unknown[],
  events?: AbiDrivenContract["events"]
): AbiDrivenContract {
  return {
    label: "Test Contract",
    abi: JSON.stringify(abi),
    addresses: { "1": "0x0000000000000000000000000000000000000001" },
    ...(events ? { events } : {}),
  };
}

describe("deriveEventsFromAbi", () => {
  it("returns an empty array when the ABI has no event entries", () => {
    const abi = [
      {
        type: "function",
        name: "foo",
        stateMutability: "view",
        inputs: [],
        outputs: [],
      },
    ];

    expect(deriveEventsFromAbi("test", contract(abi))).toEqual([]);
  });

  it("derives slug as camelToKebab(eventName) and label as camelToTitle when no override is supplied", () => {
    const abi = [
      {
        type: "event",
        name: "TokensMinted",
        anonymous: false,
        inputs: [{ name: "to", type: "address", indexed: true }],
      },
    ];

    const [event] = deriveEventsFromAbi("test", contract(abi));
    expect(event.slug).toBe("tokens-minted");
    expect(event.label).toBe("Tokens Minted");
    expect(event.eventName).toBe("TokensMinted");
    expect(event.contract).toBe("test");
  });

  it("falls back to a generic description when no override is supplied", () => {
    const abi = [
      {
        type: "event",
        name: "Transfer",
        anonymous: false,
        inputs: [],
      },
    ];

    const [event] = deriveEventsFromAbi("test", contract(abi));
    expect(event.description).toBe(
      "Fires when Transfer is emitted by the contract"
    );
  });

  it("applies slug, label, and description from an override keyed by the raw event name", () => {
    const abi = [
      {
        type: "event",
        name: "DepositReceived",
        anonymous: false,
        inputs: [],
      },
    ];

    const [event] = deriveEventsFromAbi(
      "test",
      contract(abi, {
        DepositReceived: {
          slug: "custom-slug",
          label: "Custom Label",
          description: "Custom description",
        },
      })
    );

    expect(event.slug).toBe("custom-slug");
    expect(event.label).toBe("Custom Label");
    expect(event.description).toBe("Custom description");
  });

  it("preserves indexed flags and falls back to arg<index> for unnamed inputs", () => {
    const abi = [
      {
        type: "event",
        name: "OddEvent",
        anonymous: false,
        inputs: [
          { name: "", type: "address", indexed: true },
          { name: "amount", type: "uint256" },
        ],
      },
    ];

    const [event] = deriveEventsFromAbi("test", contract(abi));
    expect(event.inputs).toEqual([
      { name: "arg0", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
    ]);
  });

  it("throws when the ABI declares an anonymous event", () => {
    const abi = [
      {
        type: "event",
        name: "HiddenEvent",
        anonymous: true,
        inputs: [],
      },
    ];

    expect(() => deriveEventsFromAbi("test", contract(abi))).toThrow(
      /Anonymous event "HiddenEvent"/
    );
  });

  it("ignores non-event ABI entries", () => {
    const abi = [
      {
        type: "function",
        name: "foo",
        stateMutability: "view",
        inputs: [],
        outputs: [],
      },
      {
        type: "event",
        name: "Bar",
        anonymous: false,
        inputs: [],
      },
      { type: "constructor", inputs: [] },
    ];

    const events = deriveEventsFromAbi("test", contract(abi));
    expect(events).toHaveLength(1);
    expect(events[0].eventName).toBe("Bar");
  });
});
