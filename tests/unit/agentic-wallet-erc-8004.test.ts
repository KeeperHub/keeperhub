/**
 * Unit tests for lib/agentic-wallet/erc-8004.ts.
 *
 * The two critical invariants we lock here:
 *
 *   1. The giveFeedback() calldata begins with selector 0x3c036a7e (validated
 *      against ethers + viem at write time). A regression in the ABI literal
 *      would silently break the on-chain commitment.
 *
 *   2. The canonical feedbackURI JSON is byte-stable: the same input must
 *      produce the same UTF-8 string regardless of insertion order, and
 *      `hashFeedbackContent` must equal `keccak256(canonicaliseFeedbackContent
 *      (...))`. This is what allows the on-chain `feedbackHash` to verify
 *      against the JSON served at /api/feedback/[id] later.
 */

import { keccak256, stringToBytes } from "viem";
import { describe, expect, it } from "vitest";
import {
  buildFeedbackUriContent,
  buildGiveFeedbackCalldata,
  canonicaliseFeedbackContent,
  type FeedbackUriContent,
  hashFeedbackContent,
} from "@/lib/agentic-wallet/erc-8004";

describe("buildGiveFeedbackCalldata", () => {
  it("encodes with selector 0x3c036a7e", () => {
    const calldata = buildGiveFeedbackCalldata({
      agentId: BigInt(31_875),
      value: BigInt(5),
      valueDecimals: 0,
      feedbackURI: "https://app.keeperhub.com/api/feedback/test123",
      feedbackHash:
        "0x0000000000000000000000000000000000000000000000000000000000000001",
    });
    expect(calldata.startsWith("0x3c036a7e")).toBe(true);
  });

  it("defaults tag1, tag2, endpoint to empty strings when omitted", () => {
    const a = buildGiveFeedbackCalldata({
      agentId: BigInt(1),
      value: BigInt(1),
      valueDecimals: 0,
      feedbackURI: "u",
      feedbackHash:
        "0x0000000000000000000000000000000000000000000000000000000000000000",
    });
    const b = buildGiveFeedbackCalldata({
      agentId: BigInt(1),
      value: BigInt(1),
      valueDecimals: 0,
      tag1: "",
      tag2: "",
      endpoint: "",
      feedbackURI: "u",
      feedbackHash:
        "0x0000000000000000000000000000000000000000000000000000000000000000",
    });
    expect(a).toBe(b);
  });

  it("produces different calldata for different agentIds", () => {
    const a = buildGiveFeedbackCalldata({
      agentId: BigInt(1),
      value: BigInt(5),
      valueDecimals: 0,
      feedbackURI: "u",
      feedbackHash:
        "0x0000000000000000000000000000000000000000000000000000000000000000",
    });
    const b = buildGiveFeedbackCalldata({
      agentId: BigInt(2),
      value: BigInt(5),
      valueDecimals: 0,
      feedbackURI: "u",
      feedbackHash:
        "0x0000000000000000000000000000000000000000000000000000000000000000",
    });
    expect(a).not.toBe(b);
  });
});

describe("buildFeedbackUriContent", () => {
  const fixedDate = new Date("2026-05-07T01:23:45.000Z");
  const args = {
    agentChainId: 1,
    agentId: BigInt(31_875),
    clientAddress: "0x8d56386b7beb7904072705def7d818aaa29c5421" as const,
    createdAt: fixedDate,
    value: BigInt(5),
    valueDecimals: 0,
  };

  it("emits required fields with stringified bigint values", () => {
    const out = buildFeedbackUriContent(args);
    expect(out.agentRegistry).toBe("erc-8004");
    expect(out.agentId).toBe("31875");
    expect(out.value).toBe("5");
    expect(out.createdAt).toBe(fixedDate.toISOString());
    expect(out.clientAddress).toBe(args.clientAddress);
  });

  it("omits comment when not provided", () => {
    const out = buildFeedbackUriContent(args);
    expect(out.comment).toBeUndefined();
  });

  it("includes mcp block only when both workflowSlug and executionId are provided", () => {
    const withMcp = buildFeedbackUriContent({
      ...args,
      workflowSlug: "usdc-yield-rates",
      executionId: "exec-1",
    });
    expect(withMcp.mcp).toEqual({
      workflowSlug: "usdc-yield-rates",
      executionId: "exec-1",
    });

    const withoutSlug = buildFeedbackUriContent({
      ...args,
      executionId: "exec-1",
    });
    expect(withoutSlug.mcp).toBeUndefined();
  });
});

describe("canonicaliseFeedbackContent", () => {
  const base: FeedbackUriContent = {
    agentRegistry: "erc-8004",
    agentChainId: 1,
    agentId: "31875",
    clientAddress: "0x8d56386b7beb7904072705def7d818aaa29c5421",
    createdAt: "2026-05-07T01:23:45.000Z",
    value: "5",
    valueDecimals: 0,
  };

  it("produces a deterministic byte string for the required-only shape", () => {
    const a = canonicaliseFeedbackContent(base);
    const b = canonicaliseFeedbackContent({ ...base });
    expect(a).toBe(b);
    // Required keys appear in spec order.
    expect(a.indexOf("agentRegistry")).toBeLessThan(a.indexOf("agentChainId"));
    expect(a.indexOf("agentChainId")).toBeLessThan(a.indexOf("agentId"));
    expect(a.indexOf("agentId")).toBeLessThan(a.indexOf("clientAddress"));
    expect(a.indexOf("clientAddress")).toBeLessThan(a.indexOf("createdAt"));
    expect(a.indexOf("createdAt")).toBeLessThan(a.indexOf("value"));
    expect(a.indexOf("value")).toBeLessThan(a.indexOf("valueDecimals"));
  });

  it("appends comment after required keys when present", () => {
    const out = canonicaliseFeedbackContent({ ...base, comment: "great" });
    expect(out.indexOf("valueDecimals")).toBeLessThan(out.indexOf("comment"));
  });

  it("appends mcp last when present", () => {
    const out = canonicaliseFeedbackContent({
      ...base,
      comment: "great",
      mcp: { workflowSlug: "wf", executionId: "ex" },
    });
    expect(out.indexOf("comment")).toBeLessThan(out.indexOf("mcp"));
  });
});

describe("hashFeedbackContent", () => {
  it("matches keccak256(canonicaliseFeedbackContent(content))", () => {
    const content: FeedbackUriContent = {
      agentRegistry: "erc-8004",
      agentChainId: 1,
      agentId: "31875",
      clientAddress: "0x8d56386b7beb7904072705def7d818aaa29c5421",
      createdAt: "2026-05-07T01:23:45.000Z",
      value: "5",
      valueDecimals: 0,
    };
    const expected = keccak256(
      stringToBytes(canonicaliseFeedbackContent(content))
    );
    expect(hashFeedbackContent(content)).toBe(expected);
  });

  it("is sensitive to value changes", () => {
    const a: FeedbackUriContent = {
      agentRegistry: "erc-8004",
      agentChainId: 1,
      agentId: "31875",
      clientAddress: "0x8d56386b7beb7904072705def7d818aaa29c5421",
      createdAt: "2026-05-07T01:23:45.000Z",
      value: "5",
      valueDecimals: 0,
    };
    const b: FeedbackUriContent = { ...a, value: "4" };
    expect(hashFeedbackContent(a)).not.toBe(hashFeedbackContent(b));
  });
});
