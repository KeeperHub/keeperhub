/**
 * Integration tests for GET /api/action-schemas and
 * GET /api/action-schemas/{actionType}.
 *
 * Covers:
 *   - Bearer kh_ auth gate (missing header, wrong scheme, wrong prefix)
 *   - Full-collection response shape (actions / triggers / chains /
 *     platform / templateSyntax / tips / etc.)
 *   - ?type=, ?category=, ?includeChains= query params
 *   - Single-action lookup: 200 on match, 404 on miss, URL-decoded path
 *
 * Run with: pnpm vitest tests/integration/action-schemas-route.test.ts
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// Plugin registry stub: one web3 plugin with a read-contract action.
const mockPlugins = [
  {
    type: "web3",
    requiresCredentials: false,
    actions: [
      {
        slug: "read-contract",
        label: "Read Contract",
        description: "Read a value from a smart contract",
        category: "web3",
        requiresCredentials: false,
        configFields: [
          {
            key: "contractAddress",
            type: "template-input",
            required: true,
            placeholder: "0x...",
          },
          {
            key: "abi",
            type: "abi-with-auto-fetch",
            required: true,
            placeholder: "JSON ABI",
          },
        ],
        outputFields: [
          { field: "result", description: "Decoded return value" },
        ],
      },
    ],
  },
  {
    type: "discord",
    requiresCredentials: true,
    actions: [
      {
        slug: "send-message",
        label: "Send Message",
        description: "Post a message via a Discord webhook",
        category: "discord",
        configFields: [
          {
            key: "discordMessage",
            type: "template-textarea",
            required: true,
            placeholder: "Hello, world!",
          },
        ],
        outputFields: [{ field: "messageId", description: "Discord ID" }],
      },
    ],
  },
];

vi.mock("@/plugins/registry", () => ({
  getAllIntegrations: () => mockPlugins,
  computeActionId: (pluginType: string, slug: string) =>
    `${pluginType}.${slug}`,
  flattenConfigFields: (fields: unknown[]) => fields,
}));

vi.mock("@/lib/mcp/workflow-schema-constants", () => ({
  SYSTEM_ACTIONS: {
    "system.condition": {
      actionType: "system.condition",
      label: "Condition",
      description: "Branch on a condition",
      category: "system",
    },
  },
  TRIGGERS: {
    "manual-trigger": { label: "Manual", description: "Run on demand" },
  },
  TEMPLATE_SYNTAX: { description: "Templates use {{...}}" },
}));

vi.mock("@/lib/workflow/editor/builtin-variables", () => ({
  BUILTIN_NODE_ID: "builtin",
  BUILTIN_NODE_LABEL: "Built-in",
}));

vi.mock("@/lib/logging", () => ({
  logSystemError: vi.fn(),
  ErrorCategory: { DATABASE: "database" },
}));

// Chains query: thenable .leftJoin().where() resolving to the mock rows.
const mockChainRows: unknown[] = [];
vi.mock("@/lib/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        leftJoin: () => ({
          where: () => Promise.resolve(mockChainRows),
        }),
      }),
    }),
  },
}));

vi.mock("@/lib/db/schema", () => ({
  chains: { chainId: "chainId", isEnabled: "isEnabled" },
  explorerConfigs: { chainId: "chainId" },
}));

vi.mock("drizzle-orm", () => ({
  eq: () => ({}),
}));

// Auth: returns whatever the test seeds.
type AuthResult = {
  authenticated: boolean;
  organizationId?: string;
  apiKeyId?: string;
  error?: string;
  statusCode?: number;
};

let nextAuthResult: AuthResult = {
  authenticated: true,
  organizationId: "org_test",
  apiKeyId: "key_test",
};

vi.mock("@/lib/api-key-auth", () => ({
  authenticateApiKey: vi.fn(() => Promise.resolve(nextAuthResult)),
}));

import { GET as singleGet } from "@/app/api/action-schemas/[actionType]/route";
// Routes are imported after mocks so the bound module references resolve to mocks.
import { GET as collectionGet } from "@/app/api/action-schemas/route";

function authenticatedRequest(path: string): Request {
  return new Request(`http://localhost${path}`, {
    headers: { Authorization: "Bearer kh_test_key" },
  });
}

describe("GET /api/action-schemas", () => {
  it("rejects requests without an Authorization header", async () => {
    nextAuthResult = {
      authenticated: false,
      error: "Missing Authorization header",
      statusCode: 401,
    };
    const res = await collectionGet(
      new Request("http://localhost/api/action-schemas")
    );
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Missing Authorization header");
  });

  it("rejects non-kh_ bearer tokens", async () => {
    nextAuthResult = {
      authenticated: false,
      error: "Invalid API key format. Expected key starting with kh_",
      statusCode: 401,
    };
    const res = await collectionGet(
      new Request("http://localhost/api/action-schemas", {
        headers: { Authorization: "Bearer foo_xyz" },
      })
    );
    expect(res.status).toBe(401);
  });

  it("returns the full schemas payload for a valid bearer key", async () => {
    nextAuthResult = {
      authenticated: true,
      organizationId: "org_test",
      apiKeyId: "key_test",
    };
    const res = await collectionGet(
      authenticatedRequest("/api/action-schemas")
    );
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.version).toBe("1.0.0");
    expect(body.actions).toHaveProperty("web3.read-contract");
    expect(body.actions).toHaveProperty("discord.send-message");
    expect(body.actions).toHaveProperty("system.condition");
    expect(body.triggers).toHaveProperty("manual-trigger");
    expect(body.platform).toBeDefined();
    expect(Array.isArray(body.tips)).toBe(true);
    expect(body.templateSyntax).toBeDefined();
    expect(body.builtinVariables).toBeDefined();
  });

  it("narrows the actions map when ?type= is set", async () => {
    nextAuthResult = {
      authenticated: true,
      organizationId: "org_test",
      apiKeyId: "key_test",
    };
    const res = await collectionGet(
      authenticatedRequest("/api/action-schemas?type=web3.read-contract")
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Object.keys(body.actions)).toEqual(["web3.read-contract"]);
    // Other top-level keys are still present.
    expect(body.triggers).toHaveProperty("manual-trigger");
  });

  it("returns an empty actions map when ?type= does not match", async () => {
    nextAuthResult = {
      authenticated: true,
      organizationId: "org_test",
      apiKeyId: "key_test",
    };
    const res = await collectionGet(
      authenticatedRequest("/api/action-schemas?type=nope.not-a-thing")
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.actions).toEqual({});
  });

  it("filters by category", async () => {
    nextAuthResult = {
      authenticated: true,
      organizationId: "org_test",
      apiKeyId: "key_test",
    };
    const res = await collectionGet(
      authenticatedRequest("/api/action-schemas?category=web3")
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.actions).toHaveProperty("web3.read-contract");
    // discord plugin is filtered out, system actions are not in the "web3" bucket
    expect(body.actions).not.toHaveProperty("discord.send-message");
    expect(body.actions).not.toHaveProperty("system.condition");
  });

  it("skips chain lookup when ?includeChains=false", async () => {
    nextAuthResult = {
      authenticated: true,
      organizationId: "org_test",
      apiKeyId: "key_test",
    };
    const res = await collectionGet(
      authenticatedRequest("/api/action-schemas?includeChains=false")
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.chains).toEqual([]);
  });
});

describe("GET /api/action-schemas/{actionType}", () => {
  it("rejects requests without an Authorization header", async () => {
    nextAuthResult = {
      authenticated: false,
      error: "Missing Authorization header",
      statusCode: 401,
    };
    const res = await singleGet(
      new Request("http://localhost/api/action-schemas/web3.read-contract"),
      { params: Promise.resolve({ actionType: "web3.read-contract" }) }
    );
    expect(res.status).toBe(401);
  });

  it("returns the matching action schema", async () => {
    nextAuthResult = {
      authenticated: true,
      organizationId: "org_test",
      apiKeyId: "key_test",
    };
    const res = await singleGet(
      authenticatedRequest("/api/action-schemas/web3.read-contract"),
      { params: Promise.resolve({ actionType: "web3.read-contract" }) }
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.actionType).toBe("web3.read-contract");
    expect(body.integration).toBe("web3");
    expect(body.requiredFields).toHaveProperty("contractAddress");
    expect(body.requiredFields).toHaveProperty("abi");
    expect(body.outputFields).toHaveProperty("result");
  });

  it("404s on an unknown actionType", async () => {
    nextAuthResult = {
      authenticated: true,
      organizationId: "org_test",
      apiKeyId: "key_test",
    };
    const res = await singleGet(
      authenticatedRequest("/api/action-schemas/nope.not-a-thing"),
      { params: Promise.resolve({ actionType: "nope.not-a-thing" }) }
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toContain("nope.not-a-thing");
  });

  it("URL-decodes the actionType path segment", async () => {
    nextAuthResult = {
      authenticated: true,
      organizationId: "org_test",
      apiKeyId: "key_test",
    };
    // The path param value comes in URL-encoded; the route must decode it.
    const res = await singleGet(
      authenticatedRequest("/api/action-schemas/web3%2Eread-contract"),
      { params: Promise.resolve({ actionType: "web3%2Eread-contract" }) }
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.actionType).toBe("web3.read-contract");
  });
});
