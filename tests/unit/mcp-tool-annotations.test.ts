import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mockRegisterTool = vi.fn();

vi.mock("@modelcontextprotocol/sdk/server/mcp.js", () => {
  const MockMcpServer = vi.fn(function (this: {
    registerTool: typeof mockRegisterTool;
  }) {
    this.registerTool = mockRegisterTool;
  });
  return { McpServer: MockMcpServer };
});

import {
  getRequiredScopeForTool,
  SCOPE_MCP_ADMIN,
  SCOPE_MCP_READ,
} from "@/lib/mcp/oauth-scopes";
import { registerMetaTools, registerTools } from "@/lib/mcp/tools";
import {
  createWorkflowMcpServer,
  type WorkflowListing,
} from "@/lib/mcp/workflow-server";
import { ONBOARDING_WORKFLOW_FIXTURES } from "@/scripts/seed/fixtures/onboarding-workflows";

type ToolAnnotations = {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
};

/**
 * Every tool registered on the authenticated /mcp surface, keyed by name.
 * Both registrars are invoked because they share the same surface and a
 * caller cannot tell which function declared a given tool.
 */
function collectAnnotations(): Map<string, ToolAnnotations> {
  const collected = new Map<string, ToolAnnotations>();
  const server = {
    tool: (
      toolName: string,
      _description: string,
      _schema: Record<string, unknown>,
      annotations: ToolAnnotations
    ): void => {
      collected.set(toolName, annotations);
    },
  } as unknown as McpServer;

  registerTools(server, "http://internal", "Bearer test", SCOPE_MCP_ADMIN);
  registerMetaTools(server, "http://internal", "Bearer test", SCOPE_MCP_ADMIN);
  return collected;
}

/**
 * Writes whose new record starts inert and which overwrite, delete, publish,
 * broadcast or emit nothing. This is the complete allowlist: any other
 * non-read tool must keep the MCP default of destructiveHint true, so adding
 * a tool with destructiveHint false fails the exhaustiveness assertion below
 * rather than silently reaching clients as auto-approvable.
 */
const ADDITIVE_WRITE_TOOLS = [
  "create_project",
  "create_tag",
  "deploy_template",
];

/**
 * Tools that are genuinely read-only in effect but still require a write
 * grant. readOnlyHint describes whether the tool modifies its environment;
 * the scope describes who may call it. They are separate axes and this is
 * where they legitimately diverge, so the check below allows exactly these
 * rather than assuming a read-only tool implies a read scope.
 *
 * ai_generate_workflow persists nothing and changes no state, but
 * /api/ai/generate requires mcp:write because it spends a rate-limited model
 * call. withScopeCheck enforces that regardless of any annotation.
 */
const READ_ONLY_TOOLS_REQUIRING_WRITE = ["ai_generate_workflow"];

/**
 * Tools that move value, broadcast a transaction, or dispatch an execution
 * whose effects cannot be bounded from the arguments. Listed explicitly
 * rather than derived so a future edit flipping one back to non-destructive
 * has to delete a named case.
 */
const VALUE_MOVING_TOOLS = [
  "call_workflow",
  "execute_check_and_execute",
  "execute_contract_call",
  "execute_protocol_action",
  "execute_transfer",
  "execute_workflow",
  "tempo_cancel_hold",
  "tempo_release_hold",
  "tempo_sign_and_hold",
];

describe("MCP tool annotations", () => {
  const annotations = collectAnnotations();

  it("annotates every registered tool", () => {
    expect(annotations.size).toBeGreaterThan(0);
    for (const [name, annotation] of annotations) {
      expect(annotation.readOnlyHint, name).toBeTypeOf("boolean");
    }
  });

  it.each(VALUE_MOVING_TOOLS)("marks %s as destructive", (name) => {
    const annotation = annotations.get(name);
    expect(annotation, name).toBeDefined();
    expect(annotation?.readOnlyHint).toBe(false);
    expect(annotation?.destructiveHint).toBe(true);
  });

  it.each([
    "update_workflow",
    "delete_workflow",
    "list_workflow",
    "unlist_workflow",
    "update_workflow_listing",
  ])("marks %s as destructive because it overwrites state", (name) => {
    expect(annotations.get(name)?.destructiveHint).toBe(true);
  });

  // create_workflow takes `enabled` alongside an unconstrained `nodes` array,
  // so one call can arm a scheduled run of a transfer action. test_notification
  // sends to a caller-named target and cannot recall the message. Neither
  // persists over existing state, so they would read as additive without an
  // explicit case.
  it.each(["create_workflow", "test_notification"])(
    "marks %s as destructive because it arms or emits an unbounded effect",
    (name) => {
      const annotation = annotations.get(name);
      expect(annotation, name).toBeDefined();
      expect(annotation?.readOnlyHint).toBe(false);
      expect(annotation?.destructiveHint).toBe(true);
    }
  );

  it("downgrades destructiveHint only for the additive write allowlist", () => {
    const downgraded = [...annotations.entries()]
      .filter(
        ([, annotation]) =>
          annotation.readOnlyHint === false &&
          annotation.destructiveHint === false
      )
      .map(([name]) => name)
      .sort();

    expect(downgraded).toEqual([...ADDITIVE_WRITE_TOOLS].sort());
  });

  it("never claims a write tool is read-only", () => {
    for (const [name, annotation] of annotations) {
      if (
        annotation.readOnlyHint === true &&
        !READ_ONLY_TOOLS_REQUIRING_WRITE.includes(name)
      ) {
        expect(getRequiredScopeForTool(name), name).toBe(SCOPE_MCP_READ);
      }
    }
  });

  // Guards the exception list itself: an entry that stops needing a write
  // grant should leave the list rather than sit there masking a real
  // read-only tool that was mis-scoped.
  it("keeps the read-only-but-write-scoped list minimal", () => {
    for (const name of READ_ONLY_TOOLS_REQUIRING_WRITE) {
      expect(annotations.get(name)?.readOnlyHint, name).toBe(true);
      expect(getRequiredScopeForTool(name), name).not.toBe(SCOPE_MCP_READ);
    }
  });
});

const baseListing: WorkflowListing = {
  id: "wf-001",
  name: "Aave Position Monitor",
  description: "Monitors Aave positions.",
  listedSlug: "aave-position-monitor",
  inputSchema: null,
  outputMapping: null,
  priceUsdcPerCall: null,
  workflowType: "read",
  listingVersion: 1,
  nodes: [],
};

/** Node shape per lib/mcp/calldata.ts findFirstWriteActionNode. */
function actionNode(id: string, actionType: string): unknown {
  return {
    id,
    type: "action",
    data: { type: "action", config: { actionType } },
  };
}

/** A protocol action node as the seeder writes it: action type plus the
 *  cached _protocolMeta blob computeProtocolMeta serialises. */
function protocolActionNode(
  id: string,
  actionType: string,
  protocolMeta?: string
): unknown {
  return {
    id,
    type: "action",
    data: {
      type: "action",
      config: {
        actionType,
        ...(protocolMeta === undefined ? {} : { _protocolMeta: protocolMeta }),
      },
    },
  };
}

function listingAnnotations(
  overrides: Partial<WorkflowListing>
): ToolAnnotations {
  createWorkflowMcpServer({
    slug: "aave-position-monitor",
    listing: { ...baseListing, ...overrides },
    internalApiBaseUrl: "http://localhost:3000",
    authHeader: "Bearer kh_test",
  });
  const config = mockRegisterTool.mock.calls[0][1] as {
    annotations: ToolAnnotations;
  };
  return config.annotations;
}

describe("per-listing workflow MCP server annotations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // The call route sends workflowType "read" to handleReadWorkflow, which runs
  // the whole body server-side on the owner's wallet, while "write" only
  // returns unsigned calldata. deriveWorkflowType additionally types a
  // transfer-only workflow as "read", so hasMutatingNode is what actually
  // separates the two here.
  it.each([
    {
      label: "a read listing whose nodes transfer funds",
      overrides: {
        workflowType: "read" as const,
        nodes: [actionNode("n1", "web3/transfer-funds")],
      },
    },
    {
      label: "a read listing whose nodes approve a token",
      overrides: {
        workflowType: "read" as const,
        nodes: [actionNode("n1", "web3/approve-token")],
      },
    },
    {
      label: "a read listing carrying a batch write",
      overrides: {
        workflowType: "read" as const,
        nodes: [actionNode("n1", "web3/batch-write-contract")],
      },
    },
    {
      label: "a write listing",
      overrides: { workflowType: "write" as const, nodes: [] },
    },
  ])("advertises $label as destructive", ({ overrides }) => {
    const annotation = listingAnnotations(overrides);
    expect(annotation.readOnlyHint).toBe(false);
    expect(annotation.destructiveHint).toBe(true);
  });

  // The inverse: destructiveHint must track readOnlyHint rather than sitting
  // pinned at false. These are the cases hasMutatingNode clears, and they are
  // the only ones allowed to advertise a non-destructive call.
  it.each([
    {
      label: "a read listing whose only node reads",
      overrides: {
        workflowType: "read" as const,
        nodes: [actionNode("n1", "web3/read-contract")],
      },
    },
    {
      label: "a read listing with no nodes at all",
      overrides: { workflowType: "read" as const, nodes: [] },
    },
  ])("advertises $label as read-only and non-destructive", ({ overrides }) => {
    const annotation = listingAnnotations(overrides);
    expect(annotation.readOnlyHint).toBe(true);
    expect(annotation.destructiveHint).toBe(false);
  });

  // Tempo carries no native gas token, so none of its writes register on the
  // daily native value cap and this annotation is the only thing standing
  // between an MCP client and an auto-approved stablecoin transfer.
  it.each([
    "tempo/transfer-with-memo",
    "tempo/batch-payout",
    "tempo/dex-swap",
    "tempo/hold-payment",
  ])(
    "treats a read-typed listing containing %s as destructive",
    (actionType) => {
      const annotation = listingAnnotations({
        workflowType: "read" as const,
        nodes: [actionNode("n1", actionType)],
      });
      expect(annotation.readOnlyHint).toBe(false);
      expect(annotation.destructiveHint).toBe(true);
    }
  );

  // tools.ts annotates test_notification destructive because it "sends to a
  // caller-named target and cannot recall the message". A listing whose nodes
  // do the same send has to land the same way, or the two MCP surfaces
  // disagree about identical behaviour.
  it.each([
    "discord/send-message",
    "slack/send-message",
    "telegram/send-message",
    "sendgrid/send-email",
    "resend/send-email",
  ])(
    "treats a read-typed listing containing %s as destructive",
    (actionType) => {
      const annotation = listingAnnotations({
        workflowType: "read" as const,
        nodes: [actionNode("n1", actionType)],
      });
      expect(annotation.readOnlyHint).toBe(false);
      expect(annotation.destructiveHint).toBe(true);
    }
  );

  // Protocol action types are `<protocol>/<action-slug>`, so they match
  // neither hasIrreversibleEffect's literal allowlist nor isWriteActionType's
  // write-contract/protocol-write substrings. sky-staking is the listing this
  // was found on: a live onboarding fixture that approves USDS and deposits it
  // into the stUSDS vault from the org wallet, advertised read-only.
  it("advertises the sky-staking onboarding listing as destructive", () => {
    const skyStaking = ONBOARDING_WORKFLOW_FIXTURES.find(
      (fixture) => fixture.listedSlug === "sky-staking"
    );
    expect(skyStaking, "sky-staking onboarding fixture").toBeDefined();
    const annotation = listingAnnotations({
      workflowType: "read" as const,
      nodes: skyStaking?.nodes ?? [],
    });
    expect(annotation.readOnlyHint).toBe(false);
    expect(annotation.destructiveHint).toBe(true);
  });

  // Pins the `import "@/protocols"` in workflow-server.ts. These nodes carry
  // no cached _protocolMeta, so the registry lookup is the only thing that can
  // classify them; dropping that import empties the registry and turns every
  // one of these read-only again, silently.
  it.each(["sky/approve-usds", "sky/st-usds-vault-deposit"])(
    "treats a read-typed listing containing %s as destructive without cached metadata",
    (actionType) => {
      const annotation = listingAnnotations({
        workflowType: "read" as const,
        nodes: [protocolActionNode("n1", actionType)],
      });
      expect(annotation.readOnlyHint).toBe(false);
      expect(annotation.destructiveHint).toBe(true);
    }
  );

  // The other half of the acceptance criteria: widening the check must not
  // swallow the protocol reads, which are the bulk of the listed catalogue.
  it("still advertises a protocol read action as read-only", () => {
    const annotation = listingAnnotations({
      workflowType: "read" as const,
      nodes: [protocolActionNode("n1", "sky/get-usds-balance")],
    });
    expect(annotation.readOnlyHint).toBe(true);
    expect(annotation.destructiveHint).toBe(false);
  });

  // resolveProtocolMeta falls back to the node's cached blob when the registry
  // has no such protocol. That fallback is what keeps a listing authored
  // against a protocol this process does not know from reading as read-only.
  it("falls back to cached _protocolMeta for an unregistered protocol", () => {
    const annotation = listingAnnotations({
      workflowType: "read" as const,
      nodes: [
        protocolActionNode(
          "n1",
          "somefutureprotocol/vault-deposit",
          JSON.stringify({
            protocolSlug: "somefutureprotocol",
            contractKey: "vault",
            functionName: "deposit",
            actionType: "write",
          })
        ),
      ],
    });
    expect(annotation.readOnlyHint).toBe(false);
    expect(annotation.destructiveHint).toBe(true);
  });

  // The predicate is an allowlist of known effects, so an unrecognised action
  // type still reads as side-effect-free. Stated as a test so the residual is
  // visible rather than assumed away: a new broadcasting plugin must be added
  // to lib/mcp/action-type.ts, and deriving the classification from a declared
  // field on PluginAction is what would close it for good.
  it("still reads an unknown action type as side-effect-free", () => {
    const annotation = listingAnnotations({
      workflowType: "read" as const,
      nodes: [actionNode("n1", "somefutureplugin/send-value")],
    });
    expect(annotation.readOnlyHint).toBe(true);
    expect(annotation.destructiveHint).toBe(false);
  });
});
