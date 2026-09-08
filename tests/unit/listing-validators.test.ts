import { describe, expect, it } from "vitest";

import {
  findBareAtLiterals,
  isInputSchemaPresent,
} from "@/lib/mcp/listing-validators";

const triggerNode = (config: Record<string, unknown>) => ({
  id: "trigger-1",
  type: "trigger",
  data: {
    label: "Manual Trigger",
    type: "trigger",
    config: { triggerType: "Manual", ...config },
  },
});

const actionNode = (config: Record<string, unknown>) => ({
  id: "action-1",
  type: "action",
  data: {
    label: "Some Action",
    type: "action",
    config,
  },
});

describe("findBareAtLiterals", () => {
  it("returns empty when nodes is not an array", () => {
    expect(findBareAtLiterals(null)).toEqual([]);
    expect(findBareAtLiterals(undefined)).toEqual([]);
    expect(findBareAtLiterals({})).toEqual([]);
    expect(findBareAtLiterals("nodes")).toEqual([]);
  });

  it("returns empty for clean node configs", () => {
    const nodes = [
      triggerNode({}),
      actionNode({ network: "1", actionType: "web3/read" }),
    ];
    expect(findBareAtLiterals(nodes)).toEqual([]);
  });

  it("detects @40 trapped from autocomplete", () => {
    const nodes = [actionNode({ address: "@40", actionType: "web3/read" })];
    expect(findBareAtLiterals(nodes)).toEqual(["@40"]);
  });

  it("detects @trigger-1 left orphaned by autocomplete dismissal", () => {
    const nodes = [
      actionNode({
        condition: "@trigger-1 < 100",
        actionType: "Condition",
      }),
    ];
    expect(findBareAtLiterals(nodes)).toEqual(["@trigger-1"]);
  });

  it("ignores wrapped {{@nodeId:Label.field}} references", () => {
    const nodes = [
      actionNode({
        condition:
          "{{@price-1:Get Token Price.price}} < {{@trigger-1:Manual Trigger.threshold}}",
        actionType: "Condition",
      }),
    ];
    expect(findBareAtLiterals(nodes)).toEqual([]);
  });

  it("ignores email-like patterns", () => {
    const nodes = [
      actionNode({
        recipient: "support@example.com",
        actionType: "notify/email",
      }),
    ];
    expect(findBareAtLiterals(nodes)).toEqual([]);
  });

  it("skips code/* action types to avoid TS-decorator false positives", () => {
    const nodes = [
      {
        id: "code-1",
        type: "action",
        data: {
          label: "Custom Code",
          type: "action",
          config: {
            actionType: "code/run-code",
            code: "@Component({ selector: 'foo' })\nclass Foo {}",
          },
        },
      },
    ];
    expect(findBareAtLiterals(nodes)).toEqual([]);
  });

  it("finds multiple literals across multiple nodes", () => {
    const nodes = [
      actionNode({ address: "@40", actionType: "web3/read" }),
      actionNode({ token: "@bar-2", actionType: "web3/read" }),
    ];
    expect(findBareAtLiterals(nodes)).toEqual(["@40", "@bar-2"]);
  });

  it("walks nested config objects and arrays", () => {
    const nodes = [
      actionNode({
        actionType: "web3/read",
        nested: {
          deeper: { value: "@40" },
          list: ["clean", "{{@trigger-1:Manual Trigger.foo}}", "@bad"],
        },
      }),
    ];
    expect(findBareAtLiterals(nodes).sort()).toEqual(["@40", "@bad"]);
  });

  it("ignores nodes with no config block", () => {
    const nodes = [
      { id: "x", type: "action", data: { label: "no config" } },
      { id: "y", type: "action" },
    ];
    expect(findBareAtLiterals(nodes)).toEqual([]);
  });

  it("does not flag mid-token @ characters", () => {
    // actionType chosen NOT in the skip list so the regex is actually consulted.
    const nodes = [
      actionNode({
        message: "discord://channel/123#general",
        url: "https://api.example.com/v1/path?token=foo@bar",
        hex: "0x1234@5678abcd",
        actionType: "web3/read-contract",
      }),
    ];
    expect(findBareAtLiterals(nodes)).toEqual([]);
  });

  it("flags bare-@ when preceded by a quote (JSON-encoded config)", () => {
    const nodes = [
      actionNode({
        condition: 'value: "@trigger-1" must be set',
        actionType: "web3/read-contract",
      }),
    ];
    expect(findBareAtLiterals(nodes)).toEqual(["@trigger-1"]);
  });

  it("flags bare-@ when preceded by =, (, [, or other non-word characters", () => {
    const nodes = [
      actionNode({ a: "key=@val", actionType: "web3/read-contract" }),
      actionNode({ b: "(@nested)", actionType: "web3/read-contract" }),
      actionNode({ c: "[@listed]", actionType: "web3/read-contract" }),
      actionNode({ d: "x>@piped", actionType: "web3/read-contract" }),
    ];
    expect(findBareAtLiterals(nodes).sort()).toEqual([
      "@listed",
      "@nested",
      "@piped",
      "@val",
    ]);
  });

  it("skips messaging action types so @everyone/@here/@username is not flagged", () => {
    const nodes = [
      {
        id: "discord-1",
        type: "action",
        data: {
          type: "action",
          config: {
            actionType: "discord/send-message",
            content: "Alert @here token spiked, @user1 please review",
          },
        },
      },
      {
        id: "slack-1",
        type: "action",
        data: {
          type: "action",
          config: {
            actionType: "slack/post-message",
            text: "@channel daily summary",
          },
        },
      },
      {
        id: "telegram-1",
        type: "action",
        data: {
          type: "action",
          config: {
            actionType: "telegram/send-message",
            text: "@everyone read this",
          },
        },
      },
    ];
    expect(findBareAtLiterals(nodes)).toEqual([]);
  });

  it("skips ai-gateway and ai action types so prompts with @-mentions are not flagged", () => {
    const nodes = [
      {
        id: "ai-1",
        type: "action",
        data: {
          type: "action",
          config: {
            actionType: "ai-gateway/chat",
            prompt: "Tell @user about the latest @trends in defi",
          },
        },
      },
      {
        id: "ai-2",
        type: "action",
        data: {
          type: "action",
          config: {
            actionType: "ai/summarize",
            input: "Summarize @article-42 highlights",
          },
        },
      },
    ];
    expect(findBareAtLiterals(nodes)).toEqual([]);
  });

  it("skips email action types so user@domain.com bodies don't trigger", () => {
    const nodes = [
      {
        id: "email-1",
        type: "action",
        data: {
          type: "action",
          config: {
            actionType: "email/send",
            body: "Hello @customer your invoice is ready",
          },
        },
      },
    ];
    expect(findBareAtLiterals(nodes)).toEqual([]);
  });

  it("normalizes colon-form action types (code:run-code) to apply skip", () => {
    const nodes = [
      {
        id: "code-colon",
        type: "action",
        data: {
          type: "action",
          config: {
            actionType: "code:run-code",
            code: "@Component({ selector: 'foo' })\nclass Foo {}",
          },
        },
      },
    ];
    expect(findBareAtLiterals(nodes)).toEqual([]);
  });

  it("falls back to data.actionType when config.actionType is missing", () => {
    // Some legacy/in-flight node shapes carry actionType at data top-level.
    const nodes = [
      {
        id: "legacy-code",
        type: "action",
        data: {
          actionType: "code/run-code",
          config: {
            code: "@Inject() class Foo {}",
          },
        },
      },
    ];
    expect(findBareAtLiterals(nodes)).toEqual([]);
  });

  it("still scans nodes with missing or non-string actionType", () => {
    const nodes = [
      {
        id: "no-action-type",
        type: "action",
        data: {
          config: { address: "@40" },
        },
      },
      {
        id: "non-string",
        type: "action",
        data: {
          actionType: 42,
          config: { address: "@bad-1" },
        },
      },
    ];
    expect(findBareAtLiterals(nodes).sort()).toEqual(["@40", "@bad-1"]);
  });

  it("bounds output at MAX_FINDINGS (10) to keep memory predictable", () => {
    const config: Record<string, string> = { actionType: "web3/read-contract" };
    for (let i = 0; i < 50; i++) {
      config[`field${i}`] = `@bad-${i}`;
    }
    const result = findBareAtLiterals([actionNode(config)]);
    expect(result.length).toBe(10);
  });

  it("survives deeply-nested node configs without stack overflow", () => {
    // Build a 10k-deep nested object to confirm MAX_DEPTH guard prevents the
    // RangeError that would otherwise propagate as a 500 from the route.
    type Nest = { next?: Nest; leaf?: string };
    let nested: Nest = { leaf: "@deep" };
    for (let i = 0; i < 10_000; i++) {
      nested = { next: nested };
    }
    const nodes = [
      actionNode({ actionType: "web3/read-contract", payload: nested }),
    ];
    expect(() => findBareAtLiterals(nodes)).not.toThrow();
  });

  it("skips strings longer than the size cap to prevent worker-pin", () => {
    // A 300KB string exceeds MAX_STRING_LEN (256KB). The bare-@ inside is
    // intentionally not surfaced — the gate trades off this rare large-field
    // case for predictable performance bounds.
    const huge = `@bad${"x".repeat(300_000)}`;
    const nodes = [
      actionNode({ actionType: "web3/read-contract", blob: huge }),
    ];
    expect(findBareAtLiterals(nodes)).toEqual([]);
  });
});

describe("isInputSchemaPresent", () => {
  it("accepts a JSON-schema-shaped object", () => {
    expect(
      isInputSchemaPresent({
        type: "object",
        properties: { address: { type: "string" } },
        required: ["address"],
      })
    ).toBe(true);
  });

  it("accepts an empty object (zero-input workflows)", () => {
    expect(isInputSchemaPresent({})).toBe(true);
    expect(isInputSchemaPresent({ type: "object" })).toBe(true);
  });

  it("rejects null", () => {
    expect(isInputSchemaPresent(null)).toBe(false);
  });

  it("rejects undefined", () => {
    expect(isInputSchemaPresent(undefined)).toBe(false);
  });

  it("rejects arrays", () => {
    expect(isInputSchemaPresent([])).toBe(false);
    expect(isInputSchemaPresent([{ type: "object" }])).toBe(false);
  });

  it("rejects primitives", () => {
    expect(isInputSchemaPresent("schema")).toBe(false);
    expect(isInputSchemaPresent(42)).toBe(false);
    expect(isInputSchemaPresent(true)).toBe(false);
  });
});
