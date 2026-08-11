import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Regex at top level per Biome useTopLevelRegex rule
const NO_QUERY_STRING_RE = /\/api\/mcp\/workflows$/;

// KEEP-393: regex constants used in 402-augmentation tests, hoisted to
// module scope per the lint/performance/useTopLevelRegex rule.
const SLUG_RE = /yield-cmp/;
const AMOUNT_RE = /50000/;
const NETWORK_RE = /eip155:8453/;
const PAYMENT_SIGNER_RE = /paymentSigner\.fetch/;
const AGENTCASH_RE = /mcp__agentcash__fetch/;
const PAID_WEIRD_RE = /Paid workflow "weird"/;
const API_402_PREFIX_RE = /^API call failed: 402/;
const API_500_RE = /API call failed: 500/;
// Multi-accepts[] follow-up regexes.
const OPTION_1_OF_2_RE = /Option 1\/2/;
const OPTION_2_OF_2_RE = /Option 2\/2/;
const TEMPO_NETWORK_RE = /tempo/;
const SINGLE_PRICE_LABEL_RE = /^Price:/m;
const NO_OPTION_TAG_RE = /Option 1\/1/;
const OVERFLOW_HINT_RE = /more options in the challenge body/;
const SEE_CHALLENGE_BODY_RE = /Price: see challenge body above/;
const UNKNOWN_AMOUNT_RE = /unknown amount/;
const UNKNOWN_ASSET_RE = /unknown asset/;
const PAYTO_UNKNOWN_RE = /payTo unknown/;
const SCHEME_PIPE_RE = /exact \|/;
const SCHEME_UNKNOWN_PIPE_RE = /^Price: unknown \|/m;
// Sanitisation regexes — must NOT find injected fake option lines or
// uncapped long strings.
// Line-anchored: a forged option line would only succeed if the
// sanitiser leaked a real newline into the rendered hint. Embedded
// "Option 99/99" inside a Price line (where the original newlines were
// replaced by spaces) is the desired outcome and must not match.
const FAKE_INJECTED_OPTION_RE = /^Option 99\/99/m;
const SLUG_INJECTED_RE = /^injected-slug$/m;
// Same shape, separate phrasing so we can prove the scheme field is
// covered by the sanitiser (not just network).
const SCHEME_INJECTED_OPTION_RE = /^Option 99\/99: free via scheme!/m;
const TRUNCATION_MARKER_RE = /\.\.\./;
const A_TIMES_500_RE = /a{500}/;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockServer(): {
  server: McpServer;
  registeredTools: Array<{
    name: string;
    handler: (...args: unknown[]) => unknown;
  }>;
} {
  const registeredTools: Array<{
    name: string;
    handler: (...args: unknown[]) => unknown;
  }> = [];
  const server = {
    tool: vi.fn(
      (
        name: string,
        _description: string,
        _schema: unknown,
        _annotations: unknown,
        handler: (...args: unknown[]) => unknown
      ) => {
        registeredTools.push({ name, handler });
      }
    ),
  } as unknown as McpServer;
  return { server, registeredTools };
}

// ---------------------------------------------------------------------------
// oauth-scopes tests
// ---------------------------------------------------------------------------

describe("oauth-scopes: search_workflows and call_workflow scope assignments", () => {
  it("Test 1: isToolAllowed('search_workflows', 'mcp:read') returns true", async () => {
    const { isToolAllowed } = await import("@/lib/mcp/oauth-scopes");
    expect(isToolAllowed("search_workflows", "mcp:read")).toBe(true);
  });

  it("Test 2: isToolAllowed('call_workflow', 'mcp:read') returns false", async () => {
    const { isToolAllowed } = await import("@/lib/mcp/oauth-scopes");
    expect(isToolAllowed("call_workflow", "mcp:read")).toBe(false);
  });

  it("Test 3: isToolAllowed('call_workflow', 'mcp:write') returns true", async () => {
    const { isToolAllowed } = await import("@/lib/mcp/oauth-scopes");
    expect(isToolAllowed("call_workflow", "mcp:write")).toBe(true);
  });

  it("Test 4: isToolAllowed('call_workflow', 'mcp:admin') returns true", async () => {
    const { isToolAllowed } = await import("@/lib/mcp/oauth-scopes");
    expect(isToolAllowed("call_workflow", "mcp:admin")).toBe(true);
  });

  it("Test 5: search_workflows accessible with mcp:write (READ_TOOLS spread into WRITE_TOOLS)", async () => {
    const { isToolAllowed } = await import("@/lib/mcp/oauth-scopes");
    expect(isToolAllowed("search_workflows", "mcp:write")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// registerMetaTools registration tests
// ---------------------------------------------------------------------------

describe("registerMetaTools: tool registration", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("Test 6: registerMetaTools registers all 10 meta-tools (4 protocol/marketplace + 4 curator + validate_workflow + prepare_test_pin_data)", async () => {
    const { server, registeredTools } = makeMockServer();
    const { registerMetaTools } = await import("@/lib/mcp/tools");
    registerMetaTools(server, "http://localhost:3000", "Bearer test-token");
    expect(registeredTools.length).toBe(10);
    expect(registeredTools.map((t) => t.name)).toEqual([
      "search_protocol_actions",
      "execute_protocol_action",
      "search_workflows",
      "call_workflow",
      "list_workflow",
      "unlist_workflow",
      "update_workflow_listing",
      "validate_workflow",
      "prepare_test_pin_data",
      "get_workflow_listing",
    ]);
  });

  it("Test 7: registerMetaTools registers search_workflows as the 3rd tool", async () => {
    const { server, registeredTools } = makeMockServer();
    const { registerMetaTools } = await import("@/lib/mcp/tools");
    registerMetaTools(server, "http://localhost:3000", "Bearer test-token");
    const names = registeredTools.map((t) => t.name);
    expect(names).toContain("search_workflows");
    expect(names.indexOf("search_workflows")).toBe(2);
  });

  it("Test 8: registerMetaTools registers call_workflow as the 4th tool", async () => {
    const { server, registeredTools } = makeMockServer();
    const { registerMetaTools } = await import("@/lib/mcp/tools");
    registerMetaTools(server, "http://localhost:3000", "Bearer test-token");
    const names = registeredTools.map((t) => t.name);
    expect(names).toContain("call_workflow");
    expect(names.indexOf("call_workflow")).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// search_workflows behavior tests
// ---------------------------------------------------------------------------

describe("search_workflows tool behavior", () => {
  const BASE_URL = "http://localhost:3000";
  const AUTH = "Bearer tok";

  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        headers: {
          get: (_key: string) => "application/json",
        },
        json: async () => ({ workflows: [], total: 0 }),
        text: async () => "",
      })
    );
  });

  async function invokeSearchWorkflows(
    args: Record<string, unknown>,
    scope?: string
  ) {
    const { server, registeredTools } = makeMockServer();
    const { registerMetaTools } = await import("@/lib/mcp/tools");
    registerMetaTools(server, BASE_URL, AUTH, scope);
    const tool = registeredTools.find((t) => t.name === "search_workflows");
    if (!tool) {
      throw new Error("search_workflows not registered");
    }
    return tool.handler(args);
  }

  it("Test 9: search_workflows with query='swap' calls GET /api/mcp/workflows?q=swap", async () => {
    await invokeSearchWorkflows({ query: "swap" });
    const fetchMock = vi.mocked(globalThis.fetch);
    expect(fetchMock).toHaveBeenCalledOnce();
    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toContain("/api/mcp/workflows");
    expect(calledUrl).toContain("q=swap");
  });

  it("Test 10: search_workflows with category='defi' calls GET /api/mcp/workflows?category=defi", async () => {
    await invokeSearchWorkflows({ category: "defi" });
    const fetchMock = vi.mocked(globalThis.fetch);
    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toContain("category=defi");
  });

  it("Test 11: search_workflows with chain='8453' calls GET /api/mcp/workflows?chain=8453", async () => {
    await invokeSearchWorkflows({ chain: "8453" });
    const fetchMock = vi.mocked(globalThis.fetch);
    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toContain("chain=8453");
  });

  it("Test 12: search_workflows with all 3 params builds correct query string", async () => {
    await invokeSearchWorkflows({
      query: "swap",
      category: "defi",
      chain: "8453",
    });
    const fetchMock = vi.mocked(globalThis.fetch);
    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toContain("q=swap");
    expect(calledUrl).toContain("category=defi");
    expect(calledUrl).toContain("chain=8453");
  });

  it("Test 13: search_workflows with no params calls GET /api/mcp/workflows with no query string", async () => {
    await invokeSearchWorkflows({});
    const fetchMock = vi.mocked(globalThis.fetch);
    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toMatch(NO_QUERY_STRING_RE);
  });

  it("Test 14: search_workflows uses GET method", async () => {
    await invokeSearchWorkflows({ query: "test" });
    const fetchMock = vi.mocked(globalThis.fetch);
    const options = fetchMock.mock.calls[0][1] as RequestInit;
    expect(options.method).toBe("GET");
  });

  it("Test 15: search_workflows returns content text with JSON", async () => {
    const result = (await invokeSearchWorkflows({ query: "test" })) as {
      content: Array<{ type: string; text: string }>;
    };
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
    const parsed = JSON.parse(result.content[0].text) as unknown;
    expect(parsed).toHaveProperty("workflows");
  });

  it("Test 16: search_workflows with scope 'mcp:read' is allowed (not denied)", async () => {
    const result = (await invokeSearchWorkflows(
      { query: "test" },
      "mcp:read"
    )) as { content: Array<{ type: string; text: string }> };
    const text = result.content[0].text;
    const parsed = JSON.parse(text) as { error?: string };
    expect(parsed.error).not.toBe("Forbidden");
  });
});

// ---------------------------------------------------------------------------
// call_workflow behavior tests
// ---------------------------------------------------------------------------

describe("call_workflow tool behavior", () => {
  const BASE_URL = "http://localhost:3000";
  const AUTH = "Bearer tok";

  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        headers: {
          get: (_key: string) => "application/json",
        },
        json: async () => ({ executionId: "exec-1", status: "running" }),
        text: async () => "",
      })
    );
  });

  async function invokeCallWorkflow(
    args: Record<string, unknown>,
    scope?: string
  ) {
    const { server, registeredTools } = makeMockServer();
    const { registerMetaTools } = await import("@/lib/mcp/tools");
    registerMetaTools(server, BASE_URL, AUTH, scope);
    const tool = registeredTools.find((t) => t.name === "call_workflow");
    if (!tool) {
      throw new Error("call_workflow not registered");
    }
    return tool.handler(args);
  }

  it("Test 17: call_workflow forwards slug to POST /api/mcp/workflows/{slug}/call", async () => {
    await invokeCallWorkflow({
      slug: "my-workflow",
      inputs: { amount: "100" },
    });
    const fetchMock = vi.mocked(globalThis.fetch);
    expect(fetchMock).toHaveBeenCalledOnce();
    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toContain("/api/mcp/workflows/my-workflow/call");
    const options = fetchMock.mock.calls[0][1] as RequestInit;
    expect(options.method).toBe("POST");
  });

  it("Test 18: call_workflow uses slug directly without org prefix", async () => {
    await invokeCallWorkflow({
      slug: "usdc-transfer",
      inputs: {},
    });
    const fetchMock = vi.mocked(globalThis.fetch);
    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toContain("/api/mcp/workflows/usdc-transfer/call");
    expect(calledUrl).not.toContain("?org=");
  });

  it("Test 19: call_workflow sends inputs as POST body", async () => {
    const inputs = { amount: "50", recipient: "0xABC" };
    await invokeCallWorkflow({
      slug: "my-workflow",
      inputs,
    });
    const fetchMock = vi.mocked(globalThis.fetch);
    const options = fetchMock.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(options.body as string) as Record<string, unknown>;
    expect(body.amount).toBe("50");
    expect(body.recipient).toBe("0xABC");
  });

  it("Test 20: call_workflow returns content text with JSON response", async () => {
    const result = (await invokeCallWorkflow({
      slug: "my-workflow",
      inputs: {},
    })) as { content: Array<{ type: string; text: string }> };
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
    const parsed = JSON.parse(result.content[0].text) as {
      executionId: string;
    };
    expect(parsed.executionId).toBe("exec-1");
  });

  it("Test 21: call_workflow for write workflow returns calldata response from call route", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        headers: {
          get: (_key: string) => "application/json",
        },
        json: async () => ({
          type: "calldata",
          to: "0xCONTRACT",
          data: "0xABCDEF",
          value: "0",
        }),
        text: async () => "",
      })
    );
    const result = (await invokeCallWorkflow({
      slug: "write-workflow",
      inputs: { recipient: "0xABC" },
    })) as { content: Array<{ type: string; text: string }> };
    const parsed = JSON.parse(result.content[0].text) as {
      type: string;
      to: string;
    };
    expect(parsed.type).toBe("calldata");
    expect(parsed.to).toBe("0xCONTRACT");
  });

  it("Test 22: call_workflow with scope 'mcp:write' is allowed", async () => {
    const result = (await invokeCallWorkflow(
      { slug: "my-workflow", inputs: {} },
      "mcp:write"
    )) as { content: Array<{ type: string; text: string }> };
    const parsed = JSON.parse(result.content[0].text) as { error?: string };
    expect(parsed.error).not.toBe("Forbidden");
  });

  // KEEP-393: paid workflows return HTTP 402 with an x402 challenge body.
  // Previously the tool surfaced the raw `API call failed: 402 ...` message
  // and left agents to figure out how to pay. The augmented error now
  // names the price + chain + asset and lists the three concrete auto-pay
  // paths (paymentSigner.fetch, mcp__agentcash__fetch, marketplace UI).
  describe("Test 23.5: call_workflow 402 augmentation (KEEP-393)", () => {
    function mockFetch402(challengeBody: string): void {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: false,
          status: 402,
          statusText: "Payment Required",
          headers: {
            get: (_key: string) => "application/json",
          },
          json: async () => JSON.parse(challengeBody),
          text: async () => challengeBody,
        })
      );
    }

    it("augments 402 error with parsed price, chain, asset, and 3 retry paths", async () => {
      const challenge = JSON.stringify({
        x402Version: 2,
        error: "Payment required",
        resource: { url: "https://app/api/mcp/workflows/yield-cmp/call" },
        accepts: [
          {
            scheme: "exact",
            network: "eip155:8453",
            asset: "0x833589fcD6eDb6E08f4c7C32D4f71b54bdA02913",
            amount: "50000",
            payTo: "0x52a93213b2748c8121691110ffb1c9389bd22308",
          },
        ],
      });
      mockFetch402(challenge);
      await expect(
        invokeCallWorkflow({ slug: "yield-cmp", inputs: {} })
      ).rejects.toThrow(SLUG_RE);

      mockFetch402(challenge);
      await expect(
        invokeCallWorkflow({ slug: "yield-cmp", inputs: {} })
      ).rejects.toThrow(AMOUNT_RE);

      mockFetch402(challenge);
      await expect(
        invokeCallWorkflow({ slug: "yield-cmp", inputs: {} })
      ).rejects.toThrow(NETWORK_RE);

      mockFetch402(challenge);
      await expect(
        invokeCallWorkflow({ slug: "yield-cmp", inputs: {} })
      ).rejects.toThrow(PAYMENT_SIGNER_RE);

      mockFetch402(challenge);
      await expect(
        invokeCallWorkflow({ slug: "yield-cmp", inputs: {} })
      ).rejects.toThrow(AGENTCASH_RE);
    });

    it("falls back to generic hint when 402 body is unparseable", async () => {
      mockFetch402("<html>402</html>");
      // Match the fallback line that appears regardless of body shape.
      await expect(
        invokeCallWorkflow({ slug: "weird", inputs: {} })
      ).rejects.toThrow(PAID_WEIRD_RE);

      mockFetch402("<html>402</html>");
      await expect(
        invokeCallWorkflow({ slug: "weird", inputs: {} })
      ).rejects.toThrow(PAYMENT_SIGNER_RE);
    });

    it("preserves the original 'API call failed: 402' prefix for callers that pattern-match", async () => {
      // The augmentation is purely additive — the original error message
      // appears unchanged at the start, so callers that grep for the
      // status line continue to work.
      mockFetch402(JSON.stringify({ x402Version: 2, accepts: [] }));
      await expect(
        invokeCallWorkflow({ slug: "preserved", inputs: {} })
      ).rejects.toThrow(API_402_PREFIX_RE);
    });

    it("does NOT augment non-402 errors (e.g. 500)", async () => {
      // 5xx and other failures stay verbatim — only 402 carries the
      // payment-retry semantics worth annotating.
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: false,
          status: 500,
          statusText: "Internal Server Error",
          headers: { get: (_k: string) => "application/json" },
          json: async () => ({ error: "boom" }),
          text: async () => "boom",
        })
      );
      await expect(
        invokeCallWorkflow({ slug: "explode", inputs: {} })
      ).rejects.toThrow(API_500_RE);
      // Augmentation strings must NOT leak into 5xx errors.
      try {
        await invokeCallWorkflow({ slug: "explode", inputs: {} });
      } catch (e) {
        const msg = (e as Error).message;
        expect(msg).not.toContain("paymentSigner.fetch");
        expect(msg).not.toContain("Paid workflow");
      }
    });

    // Reviewer follow-ups (KEEP-393): multi-accepts surfacing, empty
    // accepts handling, non-string field tolerance.
    it("surfaces every accepts[] option with Option N/M tagging when challenge offers multiple", async () => {
      // Realistic dual-protocol challenge: x402 on Base + MPP on Tempo.
      mockFetch402(
        JSON.stringify({
          x402Version: 2,
          accepts: [
            {
              scheme: "exact",
              network: "eip155:8453",
              asset: "0x833589fcD6eDb6E08f4c7C32D4f71b54bdA02913",
              amount: "50000",
              payTo: "0x52a93213b2748c8121691110ffb1c9389bd22308",
            },
            {
              scheme: "mpp",
              network: "tempo",
              asset: "0x20c000000000000000000000b9537d11c60e8b50",
              amount: "50000",
              payTo: "0x52a93213b2748c8121691110ffb1c9389bd22308",
            },
          ],
        })
      );
      await expect(
        invokeCallWorkflow({ slug: "dual", inputs: {} })
      ).rejects.toThrow(OPTION_1_OF_2_RE);

      mockFetch402(
        JSON.stringify({
          x402Version: 2,
          accepts: [
            { scheme: "exact", network: "eip155:8453", amount: "50000" },
            { scheme: "mpp", network: "tempo", amount: "50000" },
          ],
        })
      );
      await expect(
        invokeCallWorkflow({ slug: "dual", inputs: {} })
      ).rejects.toThrow(OPTION_2_OF_2_RE);

      mockFetch402(
        JSON.stringify({
          x402Version: 2,
          accepts: [
            { scheme: "exact", network: "eip155:8453", amount: "50000" },
            { scheme: "mpp", network: "tempo", amount: "50000" },
          ],
        })
      );
      await expect(
        invokeCallWorkflow({ slug: "dual", inputs: {} })
      ).rejects.toThrow(TEMPO_NETWORK_RE);
    });

    it("uses single 'Price:' label (no Option N/M) when only one accepts entry", async () => {
      // Capture the rejected error once, then assert both presence of
      // "Price:" and absence of "Option 1/1" against the same string.
      // Using rejects.toThrow + a follow-up read avoids the try/catch
      // false-pass trap (test silently passes if call resolves).
      mockFetch402(
        JSON.stringify({
          x402Version: 2,
          accepts: [
            { scheme: "exact", network: "eip155:8453", amount: "50000" },
          ],
        })
      );
      const promise = invokeCallWorkflow({ slug: "single", inputs: {} });
      await expect(promise).rejects.toThrow(SINGLE_PRICE_LABEL_RE);

      mockFetch402(
        JSON.stringify({
          x402Version: 2,
          accepts: [
            { scheme: "exact", network: "eip155:8453", amount: "50000" },
          ],
        })
      );
      // Re-invoke and read the captured error so we can assert
      // negative-match. expect.assertions guards against the call ever
      // resolving (regression where 402 stops surfacing).
      expect.assertions(3);
      try {
        await invokeCallWorkflow({ slug: "single", inputs: {} });
      } catch (e) {
        expect((e as Error).message).not.toMatch(NO_OPTION_TAG_RE);
        expect((e as Error).message).toMatch(SINGLE_PRICE_LABEL_RE);
      }
    });

    it("falls back to generic price line when accepts is an empty array", async () => {
      mockFetch402(JSON.stringify({ x402Version: 2, accepts: [] }));
      await expect(
        invokeCallWorkflow({ slug: "no-accepts", inputs: {} })
      ).rejects.toThrow(SEE_CHALLENGE_BODY_RE);
    });

    it("tolerates non-string field types in an accepts entry (degrades gracefully)", async () => {
      // amount: 50000 (number, not string) and asset: null. Type guards
      // in formatAcceptOption must convert these to "unknown amount" /
      // "unknown asset" rather than throwing or rendering [object Object].
      mockFetch402(
        JSON.stringify({
          x402Version: 2,
          accepts: [
            {
              scheme: "exact",
              network: "eip155:8453",
              asset: null,
              amount: 50_000,
              payTo: { addr: "0xabc" },
            },
          ],
        })
      );
      await expect(
        invokeCallWorkflow({ slug: "weird-types", inputs: {} })
      ).rejects.toThrow(UNKNOWN_AMOUNT_RE);

      mockFetch402(
        JSON.stringify({
          x402Version: 2,
          accepts: [
            {
              scheme: "exact",
              network: "eip155:8453",
              asset: null,
              amount: 50_000,
              payTo: { addr: "0xabc" },
            },
          ],
        })
      );
      await expect(
        invokeCallWorkflow({ slug: "weird-types", inputs: {} })
      ).rejects.toThrow(UNKNOWN_ASSET_RE);

      mockFetch402(
        JSON.stringify({
          x402Version: 2,
          accepts: [
            {
              scheme: "exact",
              network: "eip155:8453",
              asset: null,
              amount: 50_000,
              payTo: { addr: "0xabc" },
            },
          ],
        })
      );
      // Scheme is the literal "exact" supplied above; this confirms the
      // pipe-separated rendering survives the type-guard pass.
      await expect(
        invokeCallWorkflow({ slug: "weird-types", inputs: {} })
      ).rejects.toThrow(SCHEME_PIPE_RE);

      // Object-typed payTo must render as "payTo unknown" — no
      // [object Object] leakage, no throw.
      mockFetch402(
        JSON.stringify({
          x402Version: 2,
          accepts: [
            {
              scheme: "exact",
              network: "eip155:8453",
              asset: null,
              amount: 50_000,
              payTo: { addr: "0xabc" },
            },
          ],
        })
      );
      await expect(
        invokeCallWorkflow({ slug: "weird-types", inputs: {} })
      ).rejects.toThrow(PAYTO_UNKNOWN_RE);
    });

    it("caps the option list and shows an overflow hint when accepts has many entries", async () => {
      // Generate 7 accepts to exceed the cap of 5.
      const many = Array.from({ length: 7 }, (_, i) => ({
        scheme: "exact",
        network: `eip155:${8453 + i}`,
        amount: "50000",
        asset: "0xasset",
        payTo: "0xpayto",
      }));
      mockFetch402(JSON.stringify({ x402Version: 2, accepts: many }));
      await expect(
        invokeCallWorkflow({ slug: "many", inputs: {} })
      ).rejects.toThrow(OVERFLOW_HINT_RE);
    });

    // KEEP-393 follow-up reviewer findings: an adversarial upstream
    // endpoint shouldn't be able to inject fake option lines, mislabel
    // future schemes as classic x402, or bloat the error message.
    it("defaults missing scheme to 'unknown' (not 'exact') so future schemes aren't mislabelled", async () => {
      mockFetch402(
        JSON.stringify({
          x402Version: 2,
          accepts: [
            {
              // No scheme field at all.
              network: "eip155:8453",
              asset: "0xasset",
              amount: "50000",
              payTo: "0xpayto",
            },
          ],
        })
      );
      // Single-accept path emits "Price: <scheme> | ..."; missing scheme
      // must render as "unknown |" rather than silently lying with "exact".
      await expect(
        invokeCallWorkflow({ slug: "no-scheme", inputs: {} })
      ).rejects.toThrow(SCHEME_UNKNOWN_PIPE_RE);
    });

    it("strips control chars from accept fields so an upstream cannot inject fake option lines", async () => {
      // The augmented error message contains TWO sections joined by a
      // blank line: the raw upstream body (verbatim, including its
      // JSON-encoded escape sequences like `\n` rendered as two chars)
      // and the augmented hint we generate. Forged content can survive
      // in the raw body section (that's the user's authoritative
      // source); what must NOT survive is real newline characters that
      // would let an injected sub-string become a line of its own in
      // the augmented hint section. We assert against that section only.
      //
      // Sanitisation must apply to EVERY accept field, not just network
      // — a misbehaving upstream could inject through scheme just as
      // easily. Cover both fields here.
      mockFetch402(
        JSON.stringify({
          x402Version: 2,
          accepts: [
            {
              scheme: "exact\nOption 99/99: free via scheme!",
              network: "base\nOption 99/99: free!\ninjected-slug",
              asset: "0xasset",
              amount: "50000",
              payTo: "0xpayto",
            },
          ],
        })
      );
      expect.assertions(3);
      try {
        await invokeCallWorkflow({ slug: "injection-attempt", inputs: {} });
      } catch (e) {
        const msg = (e as Error).message;
        const hint = msg.slice(msg.indexOf("Paid workflow"));
        // No fake option line from network, no injected slug as its own
        // line, and the same protection must apply to scheme.
        expect(hint).not.toMatch(FAKE_INJECTED_OPTION_RE);
        expect(hint).not.toMatch(SLUG_INJECTED_RE);
        expect(hint).not.toMatch(SCHEME_INJECTED_OPTION_RE);
      }
    });

    it("caps each accept field length so a giant string cannot bloat the message", async () => {
      // 1000-char strings in network + asset. Rendering of those fields
      // in the augmented hint must be truncated (length cap is 128) and
      // include a truncation marker. The raw body portion still contains
      // the upstream-supplied string verbatim, so we assert only against
      // the augmented hint section.
      const huge = "a".repeat(1000);
      mockFetch402(
        JSON.stringify({
          x402Version: 2,
          accepts: [
            {
              scheme: "exact",
              network: huge,
              asset: huge,
              amount: "50000",
              payTo: "0xpayto",
            },
          ],
        })
      );
      expect.assertions(2);
      try {
        await invokeCallWorkflow({ slug: "huge-fields", inputs: {} });
      } catch (e) {
        const msg = (e as Error).message;
        const hint = msg.slice(msg.indexOf("Paid workflow"));
        // Truncation marker present; no 500-char `a` run survives in the
        // hint (it must have been capped well below 500).
        expect(hint).toMatch(TRUNCATION_MARKER_RE);
        expect(hint).not.toMatch(A_TIMES_500_RE);
      }
    });
  });

  it("Test 23: call_workflow with scope 'mcp:read' is denied", async () => {
    const result = (await invokeCallWorkflow(
      { slug: "my-workflow", inputs: {} },
      "mcp:read"
    )) as {
      content: Array<{ type: string; text: string }>;
    };
    const parsed = JSON.parse(result.content[0].text) as { error?: string };
    expect(parsed.error).toBe("insufficient_scope");
  });

  it("Test 24: call_workflow encodes slug in URL", async () => {
    await invokeCallWorkflow({
      slug: "my workflow+special",
      inputs: {},
    });
    const fetchMock = vi.mocked(globalThis.fetch);
    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toContain(
      "/api/mcp/workflows/my%20workflow%2Bspecial/call"
    );
  });
});

// ---------------------------------------------------------------------------
// call route: write workflow detection tests
// ---------------------------------------------------------------------------

describe("POST /api/mcp/workflows/[slug]/call: write workflow returns calldata", () => {
  const {
    mockDbSelect,
    mockDbInsert,
    mockDbUpdate,
    mockBuildPaymentConfig,
    mockHashPaymentSignature,
    mockFindExistingPayment,
    mockRecordPayment,
    mockResolveCreatorWallet,
    mockExtractPayerAddress,
    mockWithX402,
    mockStart,
    mockExecuteWorkflow,
    mockEnforceExecutionLimit,
    mockCheckConcurrencyLimit,
    mockLogSystemError,
    mockGenerateCalldata,
    mockAuthenticateApiKey,
    mockAuthenticateOAuthToken,
    mockBuildCallCompletionResponse,
  } = vi.hoisted(() => ({
    mockDbSelect: vi.fn(),
    mockDbInsert: vi.fn(),
    mockDbUpdate: vi.fn(),
    mockBuildPaymentConfig: vi.fn(),
    mockHashPaymentSignature: vi.fn(),
    mockFindExistingPayment: vi.fn(),
    mockRecordPayment: vi.fn(),
    mockResolveCreatorWallet: vi.fn(),
    mockExtractPayerAddress: vi.fn(),
    mockWithX402: vi.fn(),
    mockStart: vi.fn(),
    mockExecuteWorkflow: vi.fn(),
    mockEnforceExecutionLimit: vi.fn(),
    mockCheckConcurrencyLimit: vi.fn(),
    mockLogSystemError: vi.fn(),
    mockGenerateCalldata: vi.fn(),
    mockAuthenticateApiKey: vi.fn(),
    mockAuthenticateOAuthToken: vi.fn(),
    mockBuildCallCompletionResponse: vi.fn(),
  }));

  vi.mock("@/lib/db", () => ({
    db: {
      select: mockDbSelect,
      insert: mockDbInsert,
      update: mockDbUpdate,
    },
  }));

  vi.mock("@/lib/api-key-auth", () => ({
    authenticateApiKey: mockAuthenticateApiKey,
  }));

  vi.mock("@/lib/mcp/oauth-auth", () => ({
    authenticateOAuthToken: mockAuthenticateOAuthToken,
  }));

  vi.mock("@/lib/db/schema", () => ({
    workflows: {
      id: "id",
      listedSlug: "listed_slug",
      isListed: "is_listed",
      tagId: "tag_id",
      enabled: "enabled",
      deletedAt: "deleted_at",
      deactivatedAt: "deactivated_at",
      organizationId: "organization_id",
      userId: "user_id",
    },
    workflowExecutions: { id: "id" },
    tags: { id: "id", name: "name" },
    organization: { id: "id", deactivatedAt: "deactivated_at" },
  }));

  vi.mock("@/lib/payments/x402/server", () => ({
    server: { register: vi.fn() },
  }));

  vi.mock("@/lib/payments/x402/payment-gate", () => ({
    buildPaymentConfig: mockBuildPaymentConfig,
    hashPaymentSignature: mockHashPaymentSignature,
    findExistingPayment: mockFindExistingPayment,
    recordPayment: mockRecordPayment,
    resolveCreatorWallet: mockResolveCreatorWallet,
    extractPayerAddress: mockExtractPayerAddress,
  }));

  vi.mock("@/lib/payments/x402/reconcile", () => ({
    isTimeoutError: vi.fn().mockReturnValue(false),
    pollForPaymentConfirmation: vi.fn().mockResolvedValue(false),
  }));

  vi.mock("@x402/next", () => ({
    withX402: mockWithX402,
  }));

  vi.mock("workflow/api", () => ({
    start: mockStart,
  }));

  vi.mock("@/lib/workflow/executor/executor.workflow", () => ({
    executeWorkflow: mockExecuteWorkflow,
  }));

  vi.mock("@/lib/billing/execution-guard", () => ({
    enforceExecutionLimit: mockEnforceExecutionLimit,
    EXECUTION_LIMIT_ERROR: "Monthly execution limit exceeded",
  }));

  // The call route charges PAYG between insert and start; mock it (its module
  // pulls in `server-only`) so importing the route in these tests stays a no-op.
  vi.mock("@/lib/billing/payg/charge", () => ({
    chargePaygIfBillable: vi.fn().mockResolvedValue({ applicable: false }),
  }));

  vi.mock("@/lib/features/route-guard", () => ({
    enforceWorkflowFeatures: vi.fn().mockResolvedValue({ blocked: false }),
    FEATURE_UPGRADE_REQUIRED_ERROR:
      "This workflow uses features that require a paid plan.",
  }));

  vi.mock("@/app/api/execute/_lib/concurrency-limit", () => ({
    checkConcurrencyLimit: mockCheckConcurrencyLimit,
  }));

  vi.mock("@/lib/payments/x402/execution-wait", () => ({
    buildCallCompletionResponse: mockBuildCallCompletionResponse,
  }));

  vi.mock("@/lib/logging", () => ({
    ErrorCategory: { WORKFLOW_ENGINE: "workflow_engine" },
    logSystemError: mockLogSystemError,
  }));

  vi.mock("@/lib/mcp/calldata", () => ({
    generateCalldataForWorkflow: mockGenerateCalldata,
  }));

  vi.mock("@/lib/errors/classify", () => ({
    classifyExecutionError: () => ({
      errorCategory: "workflow_engine",
      errorType: "system",
    }),
  }));
  vi.mock("@/lib/errors/finalize-error", () => ({
    recordExecutionErrorFinalized: vi.fn().mockResolvedValue(undefined),
  }));

  const WRITE_WORKFLOW = {
    id: "wf-write-1",
    name: "Write Workflow",
    description: "A write workflow",
    organizationId: "org-1",
    listedSlug: "write-workflow",
    inputSchema: null,
    outputMapping: null,
    priceUsdcPerCall: "0",
    isListed: true,
    enabled: true,
    workflowType: "write",
    nodes: [
      {
        data: {
          actionType: "write-contract",
          config: {
            contractAddress: "0xCONTRACT",
            abi: '[{"name":"transfer","type":"function","inputs":[{"name":"to","type":"address"},{"name":"amount","type":"uint256"}],"outputs":[{"type":"bool"}],"stateMutability":"nonpayable"}]',
            abiFunction: "transfer",
            functionArgs: '["0xRECIPIENT", "1000"]',
          },
        },
      },
    ],
    edges: [],
    userId: "user-1",
  };

  function setupDbSelectWorkflow(row: unknown) {
    // lookupWorkflow joins tags (for tagName) and organization (for the owning
    // org's active/not-deactivated executability clause); the real chain is
    // select().from().leftJoin().innerJoin().where().limit(). Mirror that shape
    // here or the real code throws on the missing .innerJoin().
    mockDbSelect.mockReturnValue({
      from: vi.fn().mockReturnValue({
        leftJoin: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue(row ? [row] : []),
            }),
          }),
        }),
      }),
    });
  }

  function makeWriteRequest(
    slug: string,
    body: Record<string, unknown> = {}
  ): Request {
    return new Request(`http://localhost/api/mcp/workflows/${slug}/call`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockEnforceExecutionLimit.mockResolvedValue({
      blocked: false,
      limitResult: null,
    });
    mockCheckConcurrencyLimit.mockResolvedValue({ allowed: true });
    mockStart.mockResolvedValue({ runId: "run-1" });
    mockRecordPayment.mockResolvedValue(undefined);
    mockBuildPaymentConfig.mockReturnValue({ accepts: { price: "$1.50" } });
    mockHashPaymentSignature.mockReturnValue("hash-abc");
    mockFindExistingPayment.mockResolvedValue(null);
    mockResolveCreatorWallet.mockResolvedValue("0xCREATOR");
    mockGenerateCalldata.mockReturnValue({
      success: true,
      to: "0xCONTRACT",
      data: "0xABCDEF",
      value: "0",
    });
    mockExtractPayerAddress.mockReturnValue(null);
    mockDbUpdate.mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    });
    // Default: completion wait times out so we fall back to running response.
    mockBuildCallCompletionResponse.mockImplementation((executionId: string) =>
      Promise.resolve({ executionId, status: "running" })
    );
    // Default: caller is authenticated. The write workflow path requires
    // an API key or MCP OAuth token, same as the free read path.
    mockAuthenticateOAuthToken.mockResolvedValue({
      authenticated: true,
      organizationId: "caller-org-1",
      userId: "caller-user-1",
    });
    mockAuthenticateApiKey.mockResolvedValue({
      authenticated: true,
      organizationId: "caller-org-1",
      apiKeyId: "key-1",
    });
  });

  it("Test 26: write workflow returns {type: 'calldata', to, data, value} instead of executing", async () => {
    setupDbSelectWorkflow(WRITE_WORKFLOW);
    const { POST } = await import("@/app/api/mcp/workflows/[slug]/call/route");
    const request = makeWriteRequest("write-workflow");
    const params = Promise.resolve({ slug: "write-workflow" });
    const response = await POST(request, { params });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.type).toBe("calldata");
    expect(body.to).toBe("0xCONTRACT");
    expect(body.data).toBe("0xABCDEF");
    expect(body.value).toBe("0");
    expect(mockStart).not.toHaveBeenCalled();
  });

  it("Test 27: write workflow with calldata generation failure returns 400", async () => {
    setupDbSelectWorkflow(WRITE_WORKFLOW);
    mockGenerateCalldata.mockReturnValue({
      success: false,
      error: "No write action node found in workflow",
    });
    const { POST } = await import("@/app/api/mcp/workflows/[slug]/call/route");
    const request = makeWriteRequest("write-workflow");
    const params = Promise.resolve({ slug: "write-workflow" });
    const response = await POST(request, { params });
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain("No write action node");
  });

  it("Test 28: read workflow (workflowType='read') still executes normally", async () => {
    const READ_WORKFLOW = {
      id: "wf-read-1",
      name: "Read Workflow",
      description: null,
      organizationId: "org-1",
      listedSlug: "read-workflow",
      inputSchema: null,
      outputMapping: null,
      priceUsdcPerCall: "0",
      isListed: true,
      enabled: true,
      workflowType: "read",
      nodes: [],
      edges: [],
      userId: "user-1",
    };
    setupDbSelectWorkflow(READ_WORKFLOW);
    mockDbInsert.mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: "exec-read-1" }]),
      }),
    });
    const { POST } = await import("@/app/api/mcp/workflows/[slug]/call/route");
    const request = makeWriteRequest("read-workflow");
    const params = Promise.resolve({ slug: "read-workflow" });
    const response = await POST(request, { params });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.executionId).toBe("exec-read-1");
    expect(body.status).toBe("running");
    expect(mockStart).toHaveBeenCalled();
    expect(mockGenerateCalldata).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// search_protocol_actions query filtering
// ---------------------------------------------------------------------------

describe("search_protocol_actions: query filtering", () => {
  const SCHEMA_ACTIONS = {
    "uniswap/swap-exact-input": {
      actionType: "uniswap/swap-exact-input",
      label: "Uniswap V3: Swap Exact Input",
      description:
        "Swap an exact amount of input tokens for as many output tokens as possible (single-hop)",
    },
    "web3/approve-token": {
      actionType: "web3/approve-token",
      label: "Approve ERC20 Token",
      description:
        "Approve a spender contract to spend ERC20 tokens on behalf of your wallet (required before swaps and DeFi interactions)",
    },
    "web3/check-balance": {
      actionType: "web3/check-balance",
      label: "Get Native Token Balance",
      description: "Get native token balance (ETH, MATIC, etc.) of any address",
    },
  };

  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        headers: { get: (_key: string) => "application/json" },
        json: async () => ({ actions: SCHEMA_ACTIONS }),
        text: async () => "",
      })
    );
  });

  async function invokeSearch(args: Record<string, unknown>) {
    const { server, registeredTools } = makeMockServer();
    const { registerMetaTools } = await import("@/lib/mcp/tools");
    registerMetaTools(server, "http://localhost:3000", "Bearer tok");
    const tool = registeredTools.find(
      (t) => t.name === "search_protocol_actions"
    );
    if (!tool) {
      throw new Error("search_protocol_actions not registered");
    }
    const result = (await tool.handler(args)) as {
      content: [{ text: string }];
    };
    return JSON.parse(result.content[0].text) as {
      count: number;
      actions: Array<{ actionType: string }>;
      hint?: string;
    };
  }

  it("Test 29: multi-word query matches actions carrying every term", async () => {
    const body = await invokeSearch({ query: "token swap" });
    expect(body.actions.map((a) => a.actionType)).toEqual([
      "uniswap/swap-exact-input",
      "web3/approve-token",
    ]);
  });

  it("Test 30: term order does not change the result set", async () => {
    const forward = await invokeSearch({ query: "token swap" });
    const reversed = await invokeSearch({ query: "swap token" });
    expect(reversed.actions.map((a) => a.actionType)).toEqual(
      forward.actions.map((a) => a.actionType)
    );
  });

  it("Test 31: the advertised 'ETH balance' example matches", async () => {
    const body = await invokeSearch({ query: "ETH balance" });
    expect(body.actions.map((a) => a.actionType)).toEqual([
      "web3/check-balance",
    ]);
  });

  it("Test 32: single-word query still matches across all three fields", async () => {
    const body = await invokeSearch({ query: "swap" });
    expect(body.count).toBe(2);
  });

  it("Test 33: an unmatched query returns a hint naming the query", async () => {
    const body = await invokeSearch({ query: "perpetual futures" });
    expect(body.count).toBe(0);
    expect(body.hint).toContain("perpetual futures");
    expect(body.hint).toContain("does not mean the capability is missing");
  });

  it("Test 34: an unmatched protocol filter is called out in the hint", async () => {
    const body = await invokeSearch({
      query: "zzz-no-match",
      protocol: "uniswap-v3",
    });
    expect(body.hint).toContain("uniswap-v3");
    expect(body.hint).toContain("Drop it to search every protocol");
  });

  it("Test 35: omitting the query returns every action", async () => {
    const body = await invokeSearch({});
    expect(body.count).toBe(3);
    expect(body.hint).toBeUndefined();
  });
});
