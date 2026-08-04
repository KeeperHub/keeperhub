import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getChainIdFromNetwork } from "@/lib/rpc/network-utils";
import { SUPPORTED_CHAIN_IDS } from "@/lib/rpc/types";
import { withToolLogging } from "./logging";
import { getRequiredScopeForTool, isToolAllowed } from "./oauth-scopes";

type ScopeDeniedContent = {
  content: [{ type: "text"; text: string }];
  isError: true;
};

/**
 * KEEP-483: when a tool is denied for missing scope, the response must
 * include enough structured detail that the client can prompt the user
 * to reauthorize with the right scope. The Hydra report observed write
 * tools all returning a generic "Forbidden" so builders had no idea
 * `mcp:write` was the missing piece.
 *
 * MCP error responses live in `content[0].text` per the SDK pattern, with
 * `isError: true` so clients that check the `isError` flag short-circuit
 * correctly. The text payload is structured JSON so machine readers can
 * branch on `error`, `required_scope`, and `granted_scope`.
 */
function buildScopeDeniedResult(
  toolName: string,
  grantedScope: string
): ScopeDeniedContent {
  const requiredScope = getRequiredScopeForTool(toolName);
  // Encode the granted/required pair into the upgrade_url so the stub
  // page at /settings/mcp/reauthorize can render contextual messaging
  // ("you have mcp:read, this needs mcp:write") without the client
  // having to thread the original denial state through itself.
  const upgradeUrl = `/settings/mcp/reauthorize?required=${encodeURIComponent(requiredScope)}&granted=${encodeURIComponent(grantedScope)}`;
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({
          error: "insufficient_scope",
          message: `This tool requires the \`${requiredScope}\` OAuth scope. The current token only has \`${grantedScope || "(none)"}\`.`,
          required_scope: requiredScope,
          granted_scope: grantedScope,
          tool: toolName,
          upgrade_url: upgradeUrl,
          hint: `Reauthorize the MCP integration and request \`${requiredScope}\` on the consent screen.`,
        }),
      },
    ],
    isError: true,
  };
}

// biome-ignore lint/suspicious/noExplicitAny: SDK ToolCallback uses complex generic overloads that cannot be expressed without any
type AnyToolHandler = (...args: any[]) => unknown;

function withScopeCheck<H extends AnyToolHandler>(
  toolName: string,
  scope: string | undefined,
  handler: H
): H {
  if (scope === undefined) {
    return handler;
  }
  const wrapped = (
    ...args: Parameters<H>
  ): ReturnType<H> | ScopeDeniedContent => {
    if (!isToolAllowed(toolName, scope)) {
      return buildScopeDeniedResult(toolName, scope);
    }
    return handler(...args) as ReturnType<H>;
  };
  return wrapped as unknown as H;
}

type ApiResponse = Record<string, unknown>;

/**
 * Detect whether an error message produced by `callApi` represents an
 * HTTP 402 Payment Required response. callApi formats failures as
 * `API call failed: <status> <statusText> - <body>`, so a substring
 * match on the prefix is sufficient and avoids parsing the body twice.
 */
const API_CALL_FAILED_402_PREFIX = "API call failed: 402";

function is402Error(message: string): boolean {
  return message.includes(API_CALL_FAILED_402_PREFIX);
}

type X402Accept = {
  scheme?: unknown;
  network?: unknown;
  asset?: unknown;
  amount?: unknown;
  payTo?: unknown;
};

type X402ChallengeShape = {
  x402Version?: unknown;
  accepts?: unknown;
};

const MAX_ACCEPT_OPTIONS_TO_SHOW = 5;
// Per-field cap on accept-entry strings rendered into the error message.
// 128 chars comfortably fits real values (40-char EVM address, short
// network slugs, base-10 amounts) while bounding worst-case output if a
// misbehaving upstream endpoint returns inflated payloads.
const MAX_ACCEPT_FIELD_CHARS = 128;
// Strip control + invisible + reordering characters before rendering
// upstream-supplied strings. Covers: ASCII C0 (U+0000..U+001F), DEL +
// C1 (U+007F..U+009F), Unicode line/paragraph separators (U+2028/U+2029),
// zero-width chars (U+200B..U+200F: ZWSP/ZWNJ/ZWJ/LRM/RLM), and
// bidi-override controls (U+202A..U+202E: LRE/RLE/PDF/LRO/RLO).
//
// Threat surface:
//  - C0 newline/CR: would inject fabricated `Option N/M` lines into the
//    joined output, poisoning logs and any LLM agent that reads the
//    error message.
//  - U+2028/U+2029: not line-terminators in Node's Error.message or
//    console.error output, but render as inline whitespace which can
//    visually fragment fields. Stripping is cheap defence in depth.
//  - Zero-width + bidi-overrides: a human reading the rendered error
//    cannot see ZWSP and may read RLO-flipped text in a different
//    order than the bytes appear, hiding malicious content. Stripping
//    keeps what the human reads aligned with what the bytes contain.
const ACCEPT_CONTROL_CHARS_RE =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: deliberately matching control chars + Unicode separators + bidi-overrides to neutralise log-injection / hidden-text vectors before rendering upstream-supplied strings
  /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200b-\u200f\u202a-\u202e]/g;

function sanitiseAcceptField(value: unknown, fallback: string): string {
  if (typeof value !== "string") {
    return fallback;
  }
  const stripped = value.replace(ACCEPT_CONTROL_CHARS_RE, " ");
  if (stripped.length > MAX_ACCEPT_FIELD_CHARS) {
    return `${stripped.slice(0, MAX_ACCEPT_FIELD_CHARS - 3)}...`;
  }
  return stripped;
}

function formatAcceptOption(accept: X402Accept): string {
  // scheme defaults to "unknown" — never "exact" — so a missing or
  // future-spec scheme isn't silently mislabelled as classic x402.
  const scheme = sanitiseAcceptField(accept.scheme, "unknown");
  const network = sanitiseAcceptField(accept.network, "unknown");
  const asset = sanitiseAcceptField(accept.asset, "unknown asset");
  const amount = sanitiseAcceptField(accept.amount, "unknown amount");
  const payTo = sanitiseAcceptField(accept.payTo, "unknown");
  return `${scheme} | ${amount} (atomic units) of ${asset} on ${network}, payTo ${payTo}`;
}

/**
 * Pull the price/chain/asset from an x402 challenge embedded in a
 * `callApi` 402 error message and emit a hint that points the caller at
 * the three concrete auto-pay paths.
 *
 * Surfaces every entry in `accepts[]` rather than only the first. x402
 * challenges can offer multiple payment schemes (e.g. x402 on Base
 * alongside MPP on Tempo), and an agent shouldn't have to re-parse the
 * raw challenge body to discover the alternatives. Limited to a small
 * cap so a pathological challenge (or future spec extension) doesn't
 * blow the error message size.
 *
 * Best-effort throughout: if the body is unparseable, accepts is empty,
 * or individual fields are missing/wrong-typed, we degrade to a generic
 * line rather than throwing — the caller always gets actionable text.
 *
 * Defence-in-depth: each per-accept field is sanitised before rendering
 * (control chars stripped, length capped) so an adversarial upstream
 * endpoint can't inject fake option lines or bloat the error output.
 */

function buildPaymentRequiredHint(
  slug: string,
  originalMessage: string
): string {
  // Search for the body separator only after the known prefix, so a
  // body that itself contains " - " before its JSON cannot truncate
  // the parse. callApi's format is deterministic, but the
  // narrower-anchored search costs nothing and removes a footgun.
  const bodyStart = originalMessage.indexOf(
    " - ",
    API_CALL_FAILED_402_PREFIX.length
  );
  const body = bodyStart >= 0 ? originalMessage.slice(bodyStart + 3) : "";
  const priceLines: string[] = ["Price: see challenge body above"];
  try {
    const parsed = JSON.parse(body) as X402ChallengeShape;
    const accepts = Array.isArray(parsed.accepts)
      ? (parsed.accepts as X402Accept[])
      : [];
    if (accepts.length > 0) {
      // Replace the placeholder with one line per option (capped).
      priceLines.length = 0;
      const total = accepts.length;
      for (const [i, accept] of accepts.entries()) {
        if (i >= MAX_ACCEPT_OPTIONS_TO_SHOW) {
          break;
        }
        if (!accept) {
          continue;
        }
        const tag = total === 1 ? "Price" : `Option ${i + 1}/${total}`;
        priceLines.push(`${tag}: ${formatAcceptOption(accept)}`);
      }
      if (total > MAX_ACCEPT_OPTIONS_TO_SHOW) {
        priceLines.push(
          `... ${total - MAX_ACCEPT_OPTIONS_TO_SHOW} more options in the challenge body above`
        );
      }
    }
  } catch {
    // Body was not parseable JSON — fall back to the generic price line.
  }
  return [
    originalMessage,
    "",
    `Paid workflow "${slug}" — this MCP tool does not auto-pay.`,
    ...priceLines,
    "Retry with one of:",
    "  - @keeperhub/wallet: `paymentSigner.fetch(url, { method: 'POST', body, paymentHint: 'x402' })`",
    "  - agentcash: `mcp__agentcash__fetch` against the same endpoint",
    "  - Marketplace UI: open the listing's public page and run it interactively",
  ].join("\n");
}

// Optional idempotency key shared by the mutating tools. Forwarded to the REST
// layer as the `Idempotency-Key` header so a retry with the same key and
// arguments replays the original result instead of executing again.
const IDEMPOTENCY_KEY_ARG = z
  .string()
  .optional()
  .describe(
    "Optional Idempotency-Key (e.g. an agent-side transaction id). Retrying with the same key and arguments returns the original result instead of executing again, within a 24h window. Reusing a key with different arguments returns a 409 conflict."
  );

// The direct-execution REST routes support a dry-run path that estimates gas
// and catches reverts without signing or broadcasting. Expose the same safety
// control to MCP clients so agents do not have to leave the agent-native
// surface to preflight a write.
const SIMULATE_ARG = z
  .boolean()
  .optional()
  .describe(
    "Set to true to simulate an EVM operation without signing or broadcasting. Solana networks (chain IDs 101/103 and their aliases) are not yet supported. Use the same arguments with simulate omitted or false only after a successful simulation."
  );

const SOLANA_DIRECT_EXECUTION_CHAIN_IDS = new Set<number>([
  SUPPORTED_CHAIN_IDS.SOLANA_MAINNET,
  SUPPORTED_CHAIN_IDS.SOLANA_DEVNET,
]);

function assertSimulationSupported(chainId: string, simulate?: boolean): void {
  if (!simulate) {
    return;
  }

  let normalizedChainId: number;
  try {
    normalizedChainId = getChainIdFromNetwork(chainId);
  } catch {
    // Keep network validation in the REST layer for identifiers that this
    // compatibility helper does not know yet. The simulation route remains
    // fail-closed (it returns before any broadcast), while future chains can
    // be added there without requiring an MCP-only allowlist update first.
    return;
  }
  if (SOLANA_DIRECT_EXECUTION_CHAIN_IDS.has(normalizedChainId)) {
    throw new Error(
      `Direct-execution simulation is currently EVM-only; Solana chain ${normalizedChainId} cannot be simulated. Do not broadcast unless you can preflight the transaction through a Solana-aware client.`
    );
  }
}

/**
 * #1841: these fields take their values as decimal strings, which is right on
 * the wire - chain ids and wei-scale amounts outlive Number's exact integer
 * range - but it is not what a client emits on its first attempt. `preprocess`
 * takes the natural guess and normalises it before the handler; `union` would
 * emit `anyOf` and change what every existing client generates, so the
 * published type stays `string` deliberately.
 *
 * The guess is only taken when it round-trips losslessly. `String()` is not a
 * safe encoder across the double range: it drops the low digits of an integer
 * past 2^53 and emits exponential notation outside a narrow band, and nothing
 * downstream recovers either - `BigInt("1e+21")` throws, and a transfer amount
 * that arrives 200 wei short is the wrong amount, on-chain. Those values keep
 * the rejection they had before, because refusal is what pushes the client to
 * the string encoding that preserves them. The message now says so.
 */
const PRECISION_HINT =
  "pass this value as a string. A JSON number cannot carry it exactly: integers above 2^53 lose their low digits, and very large or very small values stringify in exponential notation.";

/** Deepest JSON nesting walked before an argument is refused outright. */
const MAX_JSON_DEPTH = 32;

const EXPONENTIAL_NOTATION = /[eE]/;

/** True when `String(value)` reproduces `value` exactly, as a plain decimal. */
function isExactAsDecimalString(value: number): boolean {
  if (!Number.isFinite(value)) {
    return false;
  }
  // Already rounded by the client's own JSON.parse - the digits are gone.
  if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
    return false;
  }
  return !EXPONENTIAL_NOTATION.test(String(value));
}

/** Leaves the input untouched when it cannot be encoded, so `z.string()` rejects it. */
function toDecimalString(value: unknown): unknown {
  return typeof value === "number" && isExactAsDecimalString(value)
    ? String(value)
    : value;
}

/**
 * ABI arguments nest - tuples, arrays of structs - so the walk is recursive
 * rather than shallow, and one unrepresentable number anywhere fails the whole
 * argument instead of encoding a wrong value into a call that moves funds.
 */
function hasInexactNumber(value: unknown, depth = 0): boolean {
  if (typeof value === "number") {
    return !isExactAsDecimalString(value);
  }
  if (value === null || typeof value !== "object") {
    return false;
  }
  if (depth >= MAX_JSON_DEPTH) {
    return true;
  }
  const children = Array.isArray(value) ? value : Object.values(value);
  return children.some((child) => hasInexactNumber(child, depth + 1));
}

function toJsonString(value: unknown): unknown {
  if (value === null || typeof value !== "object" || hasInexactNumber(value)) {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return value;
  }
}

function precisionError(input: unknown): string | undefined {
  if (typeof input !== "number") {
    return;
  }
  return Number.isFinite(input)
    ? PRECISION_HINT
    : "expected a decimal string; NaN and Infinity are not values.";
}

/**
 * `.nonoptional()` is load-bearing, not decoration: a bare `preprocess` accepts
 * `unknown` as its input, so JSON Schema generation treats the field as
 * omittable and drops it from the object's `required` list. Runtime validation
 * is unaffected - a missing value still fails - but the published schema would
 * stop advertising `chain_id` and `amount` as required, which is exactly the
 * client-visible change this coercion is supposed to avoid.
 */
function looseString(description: string) {
  return z
    .preprocess(
      toDecimalString,
      z.string({ error: (issue) => precisionError(issue.input) })
    )
    .nonoptional()
    .describe(description);
}

/**
 * Same idea for the fields that want a stringified JSON value: accept the array
 * or object itself and encode it. `[]` and `{...}` are what a model writes for
 * something described as "JSON array of function arguments"; the `"[]"` form is
 * rarely the first thing tried.
 */
function looseJsonString(description: string) {
  return z
    .preprocess(
      toJsonString,
      z.string({
        error: (issue) =>
          issue.input !== null && typeof issue.input === "object"
            ? `a value inside this JSON argument cannot be encoded - ${PRECISION_HINT}`
            : precisionError(issue.input),
      })
    )
    .nonoptional()
    .describe(description);
}

async function callApi(
  internalApiBaseUrl: string,
  authHeader: string,
  path: string,
  method: string,
  body?: unknown,
  idempotencyKey?: string
): Promise<ApiResponse> {
  const url = `${internalApiBaseUrl}${path}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: authHeader,
  };
  if (idempotencyKey) {
    headers["Idempotency-Key"] = idempotencyKey;
  }

  const response = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `API call failed: ${response.status} ${response.statusText} - ${errorText}`
    );
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return (await response.json()) as ApiResponse;
  }

  return { result: await response.text() };
}

export function registerTools(
  server: McpServer,
  internalApiBaseUrl: string,
  authHeader: string,
  scope?: string
): void {
  // =========================================================================
  // Workflow CRUD
  // =========================================================================

  server.tool(
    "list_workflows",
    "List all workflows for the authenticated organization. Optionally filter by projectId or tagId.",
    {
      projectId: z
        .string()
        .optional()
        .describe("Optional project ID to filter workflows"),
      tagId: z
        .string()
        .optional()
        .describe("Optional tag ID to filter workflows"),
    },
    { title: "List Workflows", readOnlyHint: true, destructiveHint: false },
    withScopeCheck("list_workflows", scope, async (args) =>
      withToolLogging("list_workflows", undefined, async () => {
        const params = new URLSearchParams();
        if (args.projectId) {
          params.set("projectId", args.projectId);
        }
        if (args.tagId) {
          params.set("tagId", args.tagId);
        }
        const query = params.toString();
        const path = `/api/workflows${query ? `?${query}` : ""}`;
        const data = await callApi(internalApiBaseUrl, authHeader, path, "GET");
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      })
    )
  );

  server.tool(
    "get_workflow",
    "Get a single workflow by ID, including its nodes, edges, and configuration.",
    {
      workflowId: z.string().describe("The workflow ID"),
    },
    { title: "Get Workflow", readOnlyHint: true, destructiveHint: false },
    withScopeCheck("get_workflow", scope, async (args) =>
      withToolLogging("get_workflow", undefined, async () => {
        const data = await callApi(
          internalApiBaseUrl,
          authHeader,
          `/api/workflows/${args.workflowId}`,
          "GET"
        );
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      })
    )
  );

  server.tool(
    "create_workflow",
    "Create a new workflow with nodes and edges. Nodes define the trigger and actions; edges define the execution flow. Workflows are created disabled by default; pass enabled=true to make schedule/event/block/webhook triggers fire immediately.",
    {
      name: z.string().describe("Workflow name"),
      description: z
        .string()
        .optional()
        .describe("Optional workflow description"),
      nodes: z
        .array(z.record(z.string(), z.unknown()))
        .describe("Workflow nodes (trigger + action nodes)"),
      edges: z
        .array(z.record(z.string(), z.unknown()))
        .describe("Workflow edges connecting nodes"),
      enabled: z
        .boolean()
        .optional()
        .describe(
          "Whether the workflow is active on creation. Defaults to false; non-manual triggers stay dormant until enabled."
        ),
      projectId: z
        .string()
        .optional()
        .describe("Optional project ID to assign the workflow to"),
      tagId: z
        .string()
        .optional()
        .describe("Optional tag ID to label the workflow"),
      idempotency_key: IDEMPOTENCY_KEY_ARG,
    },
    { title: "Create Workflow", readOnlyHint: false, destructiveHint: false },
    withScopeCheck("create_workflow", scope, async (args) =>
      withToolLogging("create_workflow", undefined, async () => {
        const data = await callApi(
          internalApiBaseUrl,
          authHeader,
          "/api/workflows/create",
          "POST",
          {
            name: args.name,
            description: args.description,
            nodes: args.nodes,
            edges: args.edges,
            enabled: args.enabled,
            projectId: args.projectId,
            tagId: args.tagId,
          },
          args.idempotency_key
        );
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      })
    )
  );

  server.tool(
    "update_workflow",
    "Update an existing workflow's name, description, nodes, edges, project/tag assignment, or enabled state. Set enabled=false to stop scheduled/event/block/webhook triggers from firing without deleting the workflow.",
    {
      workflowId: z.string().describe("The workflow ID to update"),
      name: z.string().optional().describe("New workflow name"),
      description: z.string().optional().describe("New workflow description"),
      nodes: z
        .array(z.record(z.string(), z.unknown()))
        .optional()
        .describe("Updated workflow nodes"),
      edges: z
        .array(z.record(z.string(), z.unknown()))
        .optional()
        .describe("Updated workflow edges"),
      enabled: z
        .boolean()
        .optional()
        .describe(
          "Whether the workflow is active. Disabled workflows are skipped by schedule/event/block triggers and webhook calls return 410 Gone."
        ),
      projectId: z
        .string()
        .nullable()
        .optional()
        .describe("Project ID to assign (null to unassign)"),
      tagId: z
        .string()
        .nullable()
        .optional()
        .describe("Tag ID to assign (null to unassign)"),
    },
    { title: "Update Workflow", readOnlyHint: false, destructiveHint: false },
    withScopeCheck("update_workflow", scope, async (args) =>
      withToolLogging("update_workflow", undefined, async () => {
        const { workflowId, ...body } = args;
        const data = await callApi(
          internalApiBaseUrl,
          authHeader,
          `/api/workflows/${workflowId}`,
          "PATCH",
          body
        );
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      })
    )
  );

  server.tool(
    "delete_workflow",
    "Delete a workflow by ID. This action is irreversible.",
    {
      workflowId: z.string().describe("The workflow ID to delete"),
    },
    { title: "Delete Workflow", readOnlyHint: false, destructiveHint: true },
    withScopeCheck("delete_workflow", scope, async (args) =>
      withToolLogging("delete_workflow", undefined, async () => {
        const data = await callApi(
          internalApiBaseUrl,
          authHeader,
          `/api/workflows/${args.workflowId}`,
          "DELETE"
        );
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      })
    )
  );

  // =========================================================================
  // Projects & Tags (workflow organization)
  // =========================================================================

  server.tool(
    "list_projects",
    "List all projects for the authenticated organization, each with its workflow count. Use a project's id as projectId when creating, updating, or filtering workflows.",
    {},
    { title: "List Projects", readOnlyHint: true, destructiveHint: false },
    withScopeCheck("list_projects", scope, (_args) =>
      withToolLogging("list_projects", undefined, async () => {
        const data = await callApi(
          internalApiBaseUrl,
          authHeader,
          "/api/projects",
          "GET"
        );
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      })
    )
  );

  server.tool(
    "create_project",
    "Create a project to group workflows. Returns the new project including its id, which you can pass as projectId to create_workflow or update_workflow to assign workflows to it.",
    {
      name: z.string().describe("Project name"),
      description: z
        .string()
        .optional()
        .describe("Optional project description"),
      color: z
        .string()
        .optional()
        .describe(
          "Optional hex color (e.g. #4A90D9). Auto-assigned from the palette when omitted."
        ),
    },
    { title: "Create Project", readOnlyHint: false, destructiveHint: false },
    withScopeCheck("create_project", scope, (args) =>
      withToolLogging("create_project", undefined, async () => {
        const data = await callApi(
          internalApiBaseUrl,
          authHeader,
          "/api/projects",
          "POST",
          {
            name: args.name,
            description: args.description,
            color: args.color,
          }
        );
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      })
    )
  );

  server.tool(
    "list_tags",
    "List all tags for the authenticated organization, each with its workflow count. Use a tag's id as tagId when creating, updating, or filtering workflows.",
    {},
    { title: "List Tags", readOnlyHint: true, destructiveHint: false },
    withScopeCheck("list_tags", scope, (_args) =>
      withToolLogging("list_tags", undefined, async () => {
        const data = await callApi(
          internalApiBaseUrl,
          authHeader,
          "/api/tags",
          "GET"
        );
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      })
    )
  );

  server.tool(
    "create_tag",
    "Create a tag to label workflows. Returns the new tag including its id, which you can pass as tagId to create_workflow or update_workflow to label workflows.",
    {
      name: z.string().describe("Tag name"),
      color: z
        .string()
        .optional()
        .describe(
          "Optional hex color (e.g. #4A90D9). Auto-assigned from the palette when omitted."
        ),
    },
    { title: "Create Tag", readOnlyHint: false, destructiveHint: false },
    withScopeCheck("create_tag", scope, (args) =>
      withToolLogging("create_tag", undefined, async () => {
        const data = await callApi(
          internalApiBaseUrl,
          authHeader,
          "/api/tags",
          "POST",
          {
            name: args.name,
            color: args.color,
          }
        );
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      })
    )
  );

  // =========================================================================
  // Execution
  // =========================================================================

  server.tool(
    "execute_workflow",
    'Trigger a manual execution of a workflow. This ONLY confirms the trigger was accepted -- the workflow runs in the background and has NOT completed when this call returns. Returns { executionId, status: "running" }. A successful (non-error) tool call here is evidence of triggering, never of completion or of any on-chain effect. Call get_execution with the returned executionId afterward to learn the actual outcome -- only get_execution\'s status and per-transaction receipts are on-chain verified.',
    {
      workflowId: z.string().describe("The workflow ID to execute"),
      input: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("Optional input data to pass to the workflow trigger"),
      idempotency_key: IDEMPOTENCY_KEY_ARG,
    },
    { title: "Execute Workflow", readOnlyHint: false, destructiveHint: false },
    withScopeCheck("execute_workflow", scope, async (args) =>
      withToolLogging("execute_workflow", undefined, async () => {
        const data = await callApi(
          internalApiBaseUrl,
          authHeader,
          `/api/workflow/${args.workflowId}/execute`,
          "POST",
          { input: args.input ?? {} },
          args.idempotency_key
        );
        // KEEP-966: `data` already carries status: "running", not "completed"
        // -- restate that explicitly at the MCP content layer so a calling
        // agent can't read a non-error tool call as evidence of success and
        // skip the get_execution follow-up.
        const enriched = {
          ...(data as Record<string, unknown>),
          hint: "This confirms the workflow was triggered, not that it completed. Call get_execution with this executionId -- only its status and per-transaction receipts are on-chain verified.",
        };
        return {
          content: [{ type: "text", text: JSON.stringify(enriched, null, 2) }],
        };
      })
    )
  );

  server.tool(
    "get_execution",
    "Get combined status and step-by-step logs for a workflow execution. Replaces the v1.11 get_execution_status + get_execution_logs pair. Returns { status, logs } in a single response. `status` and each log's `transactionHashes[].verified`/`receiptStatus` are independently reconciled against on-chain receipts before the execution is allowed to finalize as success -- this, not execute_workflow's trigger acknowledgement, is the authoritative signal for whether a workflow (and any money movement within it) actually completed. By default returns full node input/output data (backward compatible with v1.11 get_execution_logs no-param callers). Pass `includeData: false` to omit input/output/outputRaw blobs, `nodeIds: string[]` to restrict full data to specific nodes (status and error always returned for every node), or `truncateData: number` (bytes) to cap individual input/output/outputRaw payloads. The `error` field is never truncated.",
    {
      executionId: z
        .string()
        .describe("The execution ID returned by execute_workflow"),
      includeData: z
        .boolean()
        .optional()
        .describe(
          "Include input/output/outputRaw blobs on each log entry. Defaults to true for backward compatibility with v1.11 get_execution_logs callers. Pass false to receive a compact status-only response."
        ),
      nodeIds: z
        .array(z.string())
        .optional()
        .describe(
          "Restrict full input/output/outputRaw data to only the listed nodeIds (exact, case-sensitive match against the nodeId column). All other entries still return status, error, nodeName, nodeType, startedAt, completedAt, duration, timestamp, iterationIndex, and forEachNodeId. Empty array is treated as omitted. Has no effect when includeData is false."
        ),
      truncateData: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          "Per-field byte cap. Any input/output/outputRaw JSON-stringified payload exceeding this size is replaced with { _truncated: true, originalSize: <bytes>, preview: <first N bytes of stringified value> }. The error field is NEVER truncated regardless of this cap."
        ),
    },
    { title: "Get Execution", readOnlyHint: true, destructiveHint: false },
    withScopeCheck("get_execution", scope, async (args) =>
      withToolLogging("get_execution", undefined, async () => {
        const params = new URLSearchParams();
        if (args.includeData !== undefined) {
          params.set("includeData", String(args.includeData));
        }
        if (args.nodeIds !== undefined && args.nodeIds.length > 0) {
          for (const nodeId of args.nodeIds) {
            params.append("nodeIds", nodeId);
          }
        }
        if (args.truncateData !== undefined) {
          params.set("truncateData", String(args.truncateData));
        }
        const query = params.toString();
        const logsPath = query
          ? `/api/workflows/executions/${args.executionId}/logs?${query}`
          : `/api/workflows/executions/${args.executionId}/logs`;
        const statusPath = `/api/workflows/executions/${args.executionId}/status`;
        const [statusData, logsData] = await Promise.all([
          callApi(internalApiBaseUrl, authHeader, statusPath, "GET"),
          callApi(internalApiBaseUrl, authHeader, logsPath, "GET"),
        ]);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { status: statusData, logs: logsData },
                null,
                2
              ),
            },
          ],
        };
      })
    )
  );

  // =========================================================================
  // AI Workflow Generation
  // =========================================================================

  server.tool(
    "ai_generate_workflow",
    "Generate a complete workflow from a natural language description using AI. Returns a workflow definition ready to be created.",
    {
      prompt: z
        .string()
        .describe(
          "Natural language description of the workflow to generate, e.g. 'Monitor USDC transfers over $10k and send a Discord alert'"
        ),
      context: z
        .string()
        .optional()
        .describe("Additional context or constraints for the AI generator"),
    },
    {
      title: "AI Generate Workflow",
      readOnlyHint: true,
      destructiveHint: false,
    },
    withScopeCheck("ai_generate_workflow", scope, async (args) =>
      withToolLogging("ai_generate_workflow", undefined, async () => {
        const data = await callApi(
          internalApiBaseUrl,
          authHeader,
          "/api/ai/generate",
          "POST",
          { prompt: args.prompt, context: args.context }
        );
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      })
    )
  );

  // =========================================================================
  // Discovery
  // =========================================================================

  server.tool(
    "list_action_schemas",
    "List all available action schemas, triggers, and supported chains. Use this to discover what actions and integrations are available for workflow creation. Each chain includes a 'status' field (stable, experimental, or deprecated) - prefer stable chains for production writes and avoid experimental/deprecated ones unless the user explicitly opts in.",
    {
      category: z
        .string()
        .optional()
        .describe(
          "Filter by category (e.g., 'web3', 'discord', 'system', 'triggers')"
        ),
      includeChains: z
        .boolean()
        .optional()
        .describe(
          "Whether to include supported blockchain networks (default: true)"
        ),
    },
    {
      title: "List Action Schemas",
      readOnlyHint: true,
      destructiveHint: false,
    },
    withScopeCheck("list_action_schemas", scope, async (args) =>
      withToolLogging("list_action_schemas", undefined, async () => {
        const params = new URLSearchParams();
        if (args.category) {
          params.set("category", args.category);
        }
        if (args.includeChains === false) {
          params.set("includeChains", "false");
        }
        const query = params.toString();
        const path = `/api/mcp/schemas${query ? `?${query}` : ""}`;
        const data = await callApi(internalApiBaseUrl, authHeader, path, "GET");
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      })
    )
  );

  server.tool(
    "search_plugins",
    "[DEPRECATED — will be removed in v1.13. Use list_action_schemas instead.] List available action schemas filtered by category (e.g., 'web3', 'discord', 'system').",
    {
      category: z
        .string()
        .describe(
          "Category to filter by (e.g., 'web3', 'discord', 'sendgrid', 'system', 'triggers')"
        ),
    },
    { title: "Search Plugins", readOnlyHint: true, destructiveHint: false },
    withScopeCheck("search_plugins", scope, async (args) =>
      withToolLogging("search_plugins", undefined, async () => {
        const params = new URLSearchParams({ category: args.category });
        const data = await callApi(
          internalApiBaseUrl,
          authHeader,
          `/api/mcp/schemas?${params.toString()}`,
          "GET"
        );
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      })
    )
  );

  server.tool(
    "get_plugin",
    "Get schema details for a specific plugin or integration type.",
    {
      pluginType: z
        .string()
        .describe(
          "Plugin type identifier (e.g., 'web3', 'discord', 'sendgrid')"
        ),
    },
    { title: "Get Plugin", readOnlyHint: true, destructiveHint: false },
    withScopeCheck("get_plugin", scope, async (args) =>
      withToolLogging("get_plugin", undefined, async () => {
        const params = new URLSearchParams({ category: args.pluginType });
        const data = await callApi(
          internalApiBaseUrl,
          authHeader,
          `/api/mcp/schemas?${params.toString()}`,
          "GET"
        );
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      })
    )
  );

  server.tool(
    "list_integrations",
    "List all configured integrations (credentials) for the organization. These are required for actions like Discord notifications or Sendgrid emails.",
    {},
    { title: "List Integrations", readOnlyHint: true, destructiveHint: false },
    withScopeCheck("list_integrations", scope, async (_args) =>
      withToolLogging("list_integrations", undefined, async () => {
        const data = await callApi(
          internalApiBaseUrl,
          authHeader,
          "/api/integrations",
          "GET"
        );
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      })
    )
  );

  server.tool(
    "get_wallet_integration",
    "Get details for a specific wallet integration. Required for web3 write actions like fund transfers and contract writes.",
    {
      integrationId: z.string().describe("The integration (wallet) ID"),
    },
    {
      title: "Get Wallet Integration",
      readOnlyHint: true,
      destructiveHint: false,
    },
    withScopeCheck("get_wallet_integration", scope, async (args) =>
      withToolLogging("get_wallet_integration", undefined, async () => {
        const data = await callApi(
          internalApiBaseUrl,
          authHeader,
          `/api/integrations/${args.integrationId}`,
          "GET"
        );
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      })
    )
  );

  // =========================================================================
  // Templates
  // =========================================================================

  server.tool(
    "search_templates",
    "Search for pre-built workflow templates that can be deployed and customized.",
    {
      query: z
        .string()
        .optional()
        .describe("Search query to find relevant templates"),
      category: z.string().optional().describe("Filter templates by category"),
    },
    { title: "Search Templates", readOnlyHint: true, destructiveHint: false },
    withScopeCheck("search_templates", scope, async (args) =>
      withToolLogging("search_templates", undefined, async () => {
        const params = new URLSearchParams();
        if (args.query) {
          params.set("q", args.query);
        }
        if (args.category) {
          params.set("category", args.category);
        }
        const query = params.toString();
        const path = `/api/workflows/public${query ? `?${query}` : ""}`;
        const data = await callApi(internalApiBaseUrl, authHeader, path, "GET");
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      })
    )
  );

  server.tool(
    "get_template",
    "[DEPRECATED — will be removed in v1.13. Use get_workflow instead.] Get details of a specific workflow template by ID.",
    {
      templateId: z.string().describe("The template workflow ID"),
    },
    { title: "Get Template", readOnlyHint: true, destructiveHint: false },
    withScopeCheck("get_template", scope, async (args) =>
      withToolLogging("get_template", undefined, async () => {
        const data = await callApi(
          internalApiBaseUrl,
          authHeader,
          `/api/workflows/${args.templateId}`,
          "GET"
        );
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      })
    )
  );

  server.tool(
    "deploy_template",
    "Clone a public template workflow into the organization as a new workflow.",
    {
      templateId: z.string().describe("The template workflow ID to clone"),
      name: z
        .string()
        .optional()
        .describe("Optional name for the cloned workflow"),
    },
    { title: "Deploy Template", readOnlyHint: false, destructiveHint: false },
    withScopeCheck("deploy_template", scope, async (args) =>
      withToolLogging("deploy_template", undefined, async () => {
        const data = await callApi(
          internalApiBaseUrl,
          authHeader,
          `/api/workflows/${args.templateId}/duplicate`,
          "POST",
          { name: args.name }
        );
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      })
    )
  );

  // =========================================================================
  // Meta
  // =========================================================================

  server.tool(
    "tools_documentation",
    "Get documentation on how to use the KeeperHub MCP tools, including workflow creation and safe direct execution.",
    {},
    {
      title: "Tools Documentation",
      readOnlyHint: true,
      destructiveHint: false,
    },
    withScopeCheck("tools_documentation", scope, (_args) =>
      withToolLogging("tools_documentation", undefined, () => {
        const text = [
          "KeeperHub MCP Tools Documentation",
          "",
          "WORKFLOW CREATION",
          "1. Call list_action_schemas to discover available actions and triggers",
          "2. Call ai_generate_workflow with a natural language prompt to generate a workflow",
          "3. Call create_workflow with the generated definition to persist it",
          "4. Call execute_workflow to run it manually",
          "5. Call get_execution to poll for completion (returns combined status + logs)",
          "",
          "WORKFLOW MANAGEMENT",
          "- list_workflows: List all org workflows (filter by projectId or tagId)",
          "- get_workflow: Fetch a single workflow by ID",
          "- update_workflow: Modify name, nodes, edges, project, or tag",
          "- delete_workflow: Permanently delete a workflow",
          "",
          "PROJECTS & TAGS",
          "Projects group workflows; tags label them. Both are org-scoped.",
          "- list_projects / list_tags: Discover existing IDs to link to",
          "- create_project / create_tag: Create one, then use the returned id",
          "- Link: pass projectId/tagId to create_workflow or update_workflow",
          "- Unlink: call update_workflow with projectId=null or tagId=null",
          "",
          "INTEGRATIONS",
          "- list_integrations: See all configured credentials (Discord, Sendgrid, wallets)",
          "- get_wallet_integration: Get a specific wallet credential (needed for web3 writes)",
          "",
          "TEMPLATES",
          "- search_templates: Browse public workflow templates",
          "- get_template: Inspect a template's structure",
          "- deploy_template: Clone a template into your org",
          "",
          "DIRECT EXECUTION (EVM WRITES)",
          "1. Call execute_transfer, execute_contract_call, or execute_check_and_execute with simulate=true",
          "2. Continue only after success=true and wouldRevert=false; any tool error is a hard stop",
          "3. Repeat the same arguments with simulate omitted and a unique idempotency_key",
          "4. Poll get_direct_execution_status with bounded backoff until completed or failed",
          "5. Save the terminal transactionLink as the onchain proof",
          "- simulate must be a JSON boolean, not a string",
          "- simulation is EVM-only; Solana chain IDs 101/103 and their aliases are rejected before the API call",
          "- view/pure calls and unmet conditions return their normal read/no-action result",
          "",
          "TEMPLATE SYNTAX",
          "Reference outputs from previous nodes using: {{@nodeId:Label.field}}",
          "Example: {{@check-balance:Check Balance.balance}}",
          "",
          "CHAIN IDs",
          "- Ethereum Mainnet: 1",
          "- Base: 8453",
          "- Base Sepolia Testnet: 84532",
          "- Sepolia Testnet: 11155111",
          "- Use list_action_schemas (with includeChains: true) for the full list",
        ].join("\n");

        return {
          content: [{ type: "text", text }],
        };
      })
    )
  );

  // ===========================================================================
  // Direct Web3 Execution
  // ===========================================================================

  server.tool(
    "execute_transfer",
    "Transfer native tokens (ETH, MATIC) or ERC20 tokens from your wallet to a recipient address. Requires a wallet integration.",
    {
      chain_id: looseString(
        "Chain ID (e.g., '1' for Ethereum, '8453' for Base, or '103' for Solana Devnet). Solana transfers can broadcast, but simulate is currently EVM-only."
      ),
      to_address: z
        .string()
        .describe("Recipient wallet address (EVM 0x or Solana base58)"),
      amount: looseString(
        "Amount to transfer in human-readable units (e.g., '0.1')"
      ),
      token_address: z
        .string()
        .optional()
        .describe(
          "ERC20 token contract address. Omit for native token transfers."
        ),
      simulate: SIMULATE_ARG,
      idempotency_key: IDEMPOTENCY_KEY_ARG,
    },
    { title: "Transfer Funds", readOnlyHint: false, destructiveHint: true },
    withScopeCheck("execute_transfer", scope, async (args) =>
      withToolLogging("execute_transfer", undefined, async () => {
        assertSimulationSupported(args.chain_id, args.simulate);
        const data = await callApi(
          internalApiBaseUrl,
          authHeader,
          "/api/execute/transfer",
          "POST",
          {
            chainId: args.chain_id,
            recipientAddress: args.to_address,
            amount: args.amount,
            tokenAddress: args.token_address,
            simulate: args.simulate,
          },
          args.idempotency_key
        );
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      })
    )
  );

  server.tool(
    "execute_contract_call",
    'Call a smart contract function. For view/pure functions, returns the result directly. For state-changing functions, submits a transaction and returns the execution ID. Requires a wallet integration for write calls. Full example: {"contract_address": "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238", "chain_id": "11155111", "function_name": "transfer", "function_args": "[\\"0xRecipient...\\", \\"1000\\"]"} - note that function_args is a JSON array encoded as a string.',
    {
      contract_address: z.string().describe("Contract address (0x...)"),
      chain_id: looseString("Chain ID (e.g., '1' for Ethereum)"),
      function_name: z
        .string()
        .describe("Solidity function name (e.g., 'balanceOf', 'transfer')"),
      function_args: looseJsonString(
        'JSON array of function arguments (e.g., \'["0x...", "1000"]\')'
      ).optional(),
      abi: looseJsonString(
        "Contract ABI as JSON string. Auto-fetched for verified contracts if omitted."
      ).optional(),
      value: looseString(
        "Native value to send with the call, as a decimal string in ether units (e.g. '0.1'). For payable functions."
      ).optional(),
      gas_limit_multiplier: looseString(
        "Gas limit multiplier (e.g., '1.5' for 50% buffer)"
      ).optional(),
      priority_fee_gwei: looseString(
        "Explicit maxPriorityFeePerGas in gwei (e.g., '2'). Bypasses the chain's default min/max priority-fee clamp. Use when the network's mempool requires a tip above the configured floor."
      ).optional(),
      simulate: SIMULATE_ARG,
      idempotency_key: IDEMPOTENCY_KEY_ARG,
    },
    { title: "Contract Call", readOnlyHint: false, destructiveHint: true },
    withScopeCheck("execute_contract_call", scope, async (args) =>
      withToolLogging("execute_contract_call", undefined, async () => {
        assertSimulationSupported(args.chain_id, args.simulate);
        const data = await callApi(
          internalApiBaseUrl,
          authHeader,
          "/api/execute/contract-call",
          "POST",
          {
            contractAddress: args.contract_address,
            chainId: args.chain_id,
            functionName: args.function_name,
            functionArgs: args.function_args,
            abi: args.abi,
            value: args.value,
            gasLimitMultiplier: args.gas_limit_multiplier,
            priorityFeeGwei: args.priority_fee_gwei,
            simulate: args.simulate,
          },
          args.idempotency_key
        );
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      })
    )
  );

  server.tool(
    "execute_check_and_execute",
    'Read a contract value, evaluate a condition, and execute an action if the condition is met. Useful for conditional on-chain operations (e.g., \'if balance > 1000, then transfer\'). Requires a wallet integration. Full example: {"contract_address": "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238", "chain_id": "11155111", "function_name": "balanceOf", "function_args": "[\\"0xHolder...\\"]", "condition": {"operator": "gt", "value": "1000"}, "action": {"contract_address": "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238", "function_name": "transfer", "function_args": "[\\"0xRecipient...\\", \\"1000\\"]"}} - note that function_args is a JSON array encoded as a string, on both the check and the action.',
    {
      contract_address: z
        .string()
        .describe("Contract address to read the check value from (0x...)"),
      chain_id: looseString("Chain ID (e.g., '1' for Ethereum)"),
      function_name: z
        .string()
        .describe("Function to call for the check (e.g., 'balanceOf')"),
      function_args: looseJsonString(
        "JSON array of function arguments for the check"
      ).optional(),
      abi: looseJsonString(
        "ABI for the check contract (auto-fetched if omitted)"
      ).optional(),
      condition: z.object({
        operator: z
          .enum(["eq", "neq", "gt", "lt", "gte", "lte"])
          .describe("Comparison operator"),
        value: looseString("Target value to compare against"),
      }),
      action: z.object({
        contract_address: z
          .string()
          .describe("Contract to call if condition met (0x...)"),
        function_name: z
          .string()
          .describe("Function to execute if condition met"),
        function_args: looseJsonString(
          "JSON array of function arguments for the action"
        ).optional(),
        abi: looseJsonString("ABI for the action contract").optional(),
        gas_limit_multiplier: looseString(
          "Gas limit multiplier for the action"
        ).optional(),
      }),
      simulate: SIMULATE_ARG,
      idempotency_key: IDEMPOTENCY_KEY_ARG,
    },
    { title: "Check and Execute", readOnlyHint: false, destructiveHint: true },
    withScopeCheck("execute_check_and_execute", scope, async (args) =>
      withToolLogging("execute_check_and_execute", undefined, async () => {
        assertSimulationSupported(args.chain_id, args.simulate);
        const data = await callApi(
          internalApiBaseUrl,
          authHeader,
          "/api/execute/check-and-execute",
          "POST",
          {
            contractAddress: args.contract_address,
            chainId: args.chain_id,
            functionName: args.function_name,
            functionArgs: args.function_args,
            abi: args.abi,
            condition: args.condition,
            action: {
              contractAddress: args.action.contract_address,
              functionName: args.action.function_name,
              functionArgs: args.action.function_args,
              abi: args.action.abi,
              gasLimitMultiplier: args.action.gas_limit_multiplier,
            },
            simulate: args.simulate,
          },
          args.idempotency_key
        );
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      })
    )
  );

  server.tool(
    "get_direct_execution_status",
    "Get the status of a direct execution (transfer or contract call). Returns transaction hash, status, and result when complete.",
    {
      execution_id: z
        .string()
        .describe(
          "The execution ID returned by execute_transfer, execute_contract_call, or execute_check_and_execute"
        ),
    },
    {
      title: "Get Direct Execution Status",
      readOnlyHint: true,
      destructiveHint: false,
    },
    withScopeCheck("get_direct_execution_status", scope, async (args) =>
      withToolLogging("get_direct_execution_status", undefined, async () => {
        const data = await callApi(
          internalApiBaseUrl,
          authHeader,
          `/api/execute/${args.execution_id}/status`,
          "GET"
        );
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      })
    )
  );
}

// =============================================================================
// Protocol meta-tools (replaces individual per-action tool registration)
// =============================================================================

export function registerMetaTools(
  server: McpServer,
  internalApiBaseUrl: string,
  authHeader: string,
  scope?: string
): void {
  // Meta-tool 1: Search and discover available protocol actions
  server.tool(
    "search_protocol_actions",
    "Search for available protocol actions across all supported DeFi protocols (Aave, Morpho, Chronicle, Chainlink, Uniswap, Compound, Lido, etc.). Call this first to discover what actions are available and what parameters they require, then use execute_protocol_action to run them.",
    {
      query: z
        .string()
        .optional()
        .describe(
          "Keyword search across action names and descriptions (e.g., 'ETH balance', 'borrow', 'swap')"
        ),
      protocol: z
        .string()
        .optional()
        .describe(
          "Filter by protocol name (e.g., 'chronicle', 'aave-v3', 'morpho', 'uniswap', 'compound', 'lido', 'chainlink')"
        ),
    },
    {
      title: "Search Protocol Actions",
      readOnlyHint: true,
      destructiveHint: false,
    },
    withScopeCheck("search_protocol_actions", scope, async (args) =>
      withToolLogging("search_protocol_actions", undefined, async () => {
        const params = new URLSearchParams();
        if (args.protocol) {
          params.set("category", args.protocol);
        }
        params.set("includeChains", "false");
        const path = `/api/mcp/schemas${params.toString() ? `?${params.toString()}` : ""}`;
        const data = (await callApi(
          internalApiBaseUrl,
          authHeader,
          path,
          "GET"
        )) as Record<string, unknown>;

        const actions = (data.actions ?? {}) as Record<
          string,
          {
            actionType?: string;
            label?: string;
            description?: string;
            requiredFields?: Record<string, string>;
            optionalFields?: Record<string, string>;
            requiresCredentials?: boolean;
          }
        >;

        let results = Object.values(actions);

        // Client-side keyword filtering
        if (args.query) {
          const q = args.query.toLowerCase();
          results = results.filter(
            (a) =>
              a.label?.toLowerCase().includes(q) ||
              a.description?.toLowerCase().includes(q) ||
              a.actionType?.toLowerCase().includes(q)
          );
        }

        // Return compact results
        const compact = results.map((a) => ({
          actionType: a.actionType,
          label: a.label,
          description: a.description,
          requiredFields: a.requiredFields,
          optionalFields: a.optionalFields,
          requiresCredentials: a.requiresCredentials,
        }));

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { count: compact.length, actions: compact },
                null,
                2
              ),
            },
          ],
        };
      })
    )
  );

  // Meta-tool 2: Execute any protocol action by actionType
  server.tool(
    "execute_protocol_action",
    "Execute a DeFi protocol action directly. Use search_protocol_actions first to discover available actions and their required parameters. The actionType follows the format 'protocol/action-slug' (e.g., 'chronicle/eth-usd-read', 'aave-v3/supply', 'morpho/get-position'). Pass all required parameters in the params object.",
    {
      actionType: z
        .string()
        .describe(
          "The action identifier in 'protocol/action-slug' format (e.g., 'chronicle/eth-usd-read', 'aave-v3/get-user-account-data')"
        ),
      params: z
        .record(z.string(), z.unknown())
        .describe(
          "Action parameters as key-value pairs (e.g., {network: '1', address: '0x...'}). Use search_protocol_actions to discover required params."
        ),
    },
    {
      title: "Execute Protocol Action",
      readOnlyHint: false,
      destructiveHint: false,
    },
    withScopeCheck("execute_protocol_action", scope, async (args) =>
      withToolLogging("execute_protocol_action", undefined, async () => {
        const parts = args.actionType.split("/");
        if (parts.length < 2) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  error: "Invalid actionType format",
                  message:
                    "actionType must be in 'protocol/action-slug' format (e.g., 'chronicle/eth-usd-read')",
                }),
              },
            ],
            isError: true,
          };
        }

        const integration = parts[0];
        const slug = parts.slice(1).join("/");

        const data = await callApi(
          internalApiBaseUrl,
          authHeader,
          `/api/execute/${integration}/${slug}`,
          "POST",
          args.params as Record<string, unknown>
        );

        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      })
    )
  );

  // Meta-tool 3: Search listed workflows callable by external agents
  server.tool(
    "search_workflows",
    "Search KeeperHub listed workflows callable by external agents. Returns slug, description, inputSchema, and price for each match. Use sort='popular' to rank by usage, sort='recent' to see new listings first; omit sort for the default ordering. Use call_workflow to invoke a result.",
    {
      query: z.string().optional().describe("Natural-language search query"),
      category: z
        .string()
        .optional()
        .describe("Category filter (e.g., 'defi', 'monitoring')"),
      chain: z
        .string()
        .optional()
        .describe("Chain ID filter (e.g., '8453' for Base, '1' for Ethereum)"),
      sort: z
        .enum(["popular", "recent"])
        .optional()
        .describe(
          "Sort order: 'popular' (most-called workflows first) or 'recent' (most-recently listed first). Omit for the default catalog ordering."
        ),
      workflowType: z
        .enum(["read", "write"])
        .optional()
        .describe(
          "Filter by workflow type. 'read' executes and returns the result; 'write' returns unsigned calldata for the caller to submit."
        ),
    },
    { title: "Search Workflows", readOnlyHint: true, destructiveHint: false },
    withScopeCheck("search_workflows", scope, async (args) =>
      withToolLogging("search_workflows", undefined, async () => {
        const params = new URLSearchParams();
        if (args.query) {
          params.set("q", args.query);
        }
        if (args.category) {
          params.set("category", args.category);
        }
        if (args.chain) {
          params.set("chain", args.chain);
        }
        if (args.sort) {
          params.set("sort", args.sort);
        }
        if (args.workflowType) {
          params.set("workflowType", args.workflowType);
        }
        const query = params.toString();
        const path = `/api/mcp/workflows${query ? `?${query}` : ""}`;
        const data = await callApi(internalApiBaseUrl, authHeader, path, "GET");
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      })
    )
  );

  // Meta-tool 4: Invoke a listed workflow by its globally unique slug
  server.tool(
    "call_workflow",
    "Invoke a listed KeeperHub workflow. For read workflows, executes and returns the result. For write workflows, returns unsigned calldata {to, data, value} for the caller to submit. Use search_workflows first to discover available workflows. PAID WORKFLOWS: this tool DOES NOT auto-pay. A paid listing returns HTTP 402 with an x402 challenge — pay it with @keeperhub/wallet's paymentSigner.fetch(), agentcash's mcp__agentcash__fetch, or the marketplace UI, then retry. The 402 error message includes the price and concrete next-step paths.",
    {
      slug: z
        .string()
        .describe(
          "The workflow's listed slug (listedSlug from search results)"
        ),
      inputs: z
        .record(z.string(), z.unknown())
        .describe("Input fields as declared in the workflow's inputSchema"),
    },
    { title: "Call Workflow", readOnlyHint: false, destructiveHint: false },
    withScopeCheck("call_workflow", scope, async (args) =>
      withToolLogging("call_workflow", undefined, async () => {
        try {
          const data = await callApi(
            internalApiBaseUrl,
            authHeader,
            `/api/mcp/workflows/${encodeURIComponent(args.slug)}/call`,
            "POST",
            args.inputs
          );
          return {
            content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
          };
        } catch (err) {
          // 402 is an expected outcome for paid listings. Augment the
          // generic API error with the price and concrete payment paths so
          // the caller knows how to retry — the previous behaviour was to
          // surface a raw `API call failed: 402 Payment Required - {...}`
          // error, which left agents guessing.
          if (err instanceof Error && is402Error(err.message)) {
            throw new Error(buildPaymentRequiredHint(args.slug, err.message));
          }
          throw err;
        }
      })
    )
  );

  // Curator tool 1: Publish a workflow to the marketplace catalog
  server.tool(
    "list_workflow",
    "Publish a workflow to the KeeperHub marketplace catalog. Sets isListed=true, assigns or preserves listedSlug, refreshes listedAt. Other agents discover the listing via search_workflows and invoke it via call_workflow. Use this after creating a workflow with create_workflow. Idempotent: re-publishing preserves the original slug.",
    {
      workflowId: z
        .string()
        .describe("The internal ID of the workflow to publish"),
      slug: z
        .string()
        .optional()
        .describe(
          "Public URL slug for the listing (e.g. 'my-defi-alert'). Required on first publish; preserved on re-publish."
        ),
      category: z
        .string()
        .optional()
        .describe("Workflow category (e.g. 'defi', 'monitoring')"),
      chain: z
        .string()
        .optional()
        .describe("Chain ID this workflow targets (e.g. '8453' for Base)"),
      inputSchema: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("JSON Schema for the workflow's input parameters"),
      outputMapping: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("Mapping of workflow output fields to return values"),
      workflowType: z
        .enum(["read", "write"])
        .optional()
        .describe(
          "Workflow type: 'read' for read-only, 'write' for state-changing"
        ),
    },
    { title: "List Workflow", readOnlyHint: false, destructiveHint: false },
    withScopeCheck("list_workflow", scope, async (args) =>
      withToolLogging("list_workflow", undefined, async () => {
        const { workflowId, ...metadata } = args;
        const data = await callApi(
          internalApiBaseUrl,
          authHeader,
          `/api/mcp/workflows/${encodeURIComponent(workflowId)}/listing`,
          "POST",
          metadata
        );
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      })
    )
  );

  // Curator tool 2: Remove a workflow from the marketplace catalog
  server.tool(
    "unlist_workflow",
    "Remove a workflow from the marketplace catalog. Slug is preserved for re-listing. Use when the workflow is deprecated or temporarily unavailable. Does not delete the workflow itself; use delete_workflow for permanent removal.",
    {
      workflowId: z
        .string()
        .describe("The internal ID of the workflow to unlist"),
    },
    { title: "Unlist Workflow", readOnlyHint: false, destructiveHint: true },
    withScopeCheck("unlist_workflow", scope, async (args) =>
      withToolLogging("unlist_workflow", undefined, async () => {
        const data = await callApi(
          internalApiBaseUrl,
          authHeader,
          `/api/mcp/workflows/${encodeURIComponent(args.workflowId)}/listing`,
          "DELETE"
        );
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      })
    )
  );

  // Curator tool 3: Edit listing metadata for a workflow
  server.tool(
    "update_workflow_listing",
    "Edit listing metadata for a workflow (description, tags, category, chain, schemas). Cannot change pricing while listed — unlist first, update price, then re-list.",
    {
      workflowId: z
        .string()
        .describe("The internal ID of the workflow to update"),
      category: z
        .string()
        .optional()
        .describe("Updated category (e.g. 'defi', 'monitoring')"),
      chain: z
        .string()
        .optional()
        .describe("Updated chain ID (e.g. '8453' for Base)"),
      inputSchema: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("Updated JSON Schema for input parameters (full replace)"),
      outputMapping: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("Updated output field mapping (full replace)"),
      workflowType: z
        .enum(["read", "write"])
        .optional()
        .describe("Updated workflow type"),
      priceUsdcPerCall: z
        .string()
        .optional()
        .describe("Updated price in USDC (only allowed while unlisted)"),
    },
    {
      title: "Update Workflow Listing",
      readOnlyHint: false,
      destructiveHint: false,
    },
    withScopeCheck("update_workflow_listing", scope, async (args) =>
      withToolLogging("update_workflow_listing", undefined, async () => {
        const { workflowId, ...patch } = args;
        const data = await callApi(
          internalApiBaseUrl,
          authHeader,
          `/api/mcp/workflows/${encodeURIComponent(workflowId)}/listing`,
          "PATCH",
          patch
        );
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      })
    )
  );

  // validate_workflow: structural + listing-eligibility + Web3 validation pilot
  server.tool(
    "validate_workflow",
    [
      "Validate a workflow's structural and Web3-specific correctness before calling create_workflow or executing it.",
      "Fast tier (default): structural checks (empty nodes, edge references, trigger config, bare-@ literals), listing-eligibility checks (inputSchema present for listed workflows, outputMapping references real nodes), write-action consistency, plus Web3 cheap checks (chain ID in chains table, contract address format via ethers.isAddress). Zero network calls; <300ms p95.",
      "Deep tier (deepCheck=true): in addition, runs best-effort ABI bytecode match via resolveAbi against every contract reference. Mismatches on abi-with-auto-fetch fields are emitted as WARNINGS, never errors, so proxy contracts (Aave V3, Uniswap V3, WETH) never produce false positives. Capped at 3s aggregate + 2s per-call + 5 concurrent RPC calls.",
      "Return shape: { ok: true, result: { valid: boolean, nodeCount: number, errors?: Array<{ code, message, parameterPath }>, warnings?: Array<{ code, message, parameterPath }> } }. The errors and warnings keys are OMITTED when empty (not present as []). Error codes are kebab-case stable identifiers; parameterPath is a dot-path like 'nodes[2].config.contractAddress'.",
    ].join(" "),
    {
      workflowId: z
        .string()
        .describe(
          "The workflow ID to validate. Must belong to the caller's org."
        ),
      deepCheck: z
        .boolean()
        .optional()
        .describe(
          "When true, also runs best-effort ABI bytecode matching via resolveAbi. Adds up to 3 seconds of latency. Mismatches emit warnings only (never errors). Default false."
        ),
    },
    { title: "Validate Workflow", readOnlyHint: true, destructiveHint: false },
    withScopeCheck("validate_workflow", scope, async (args) =>
      withToolLogging("validate_workflow", undefined, async () => {
        const path = args.deepCheck
          ? `/api/workflows/${encodeURIComponent(args.workflowId)}/validate?deepCheck=true`
          : `/api/workflows/${encodeURIComponent(args.workflowId)}/validate`;
        const data = await callApi(internalApiBaseUrl, authHeader, path, "GET");
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      })
    )
  );

  // prepare_test_pin_data: per-node pin schemas for the future test_workflow tool
  // Phase 49 / TESTWF-05. Introspection only — never executes any step.
  server.tool(
    "prepare_test_pin_data",
    [
      "Return the JSON Schema each node in a workflow expects as pin data, so an agent can construct valid test inputs.",
      "Read-only introspection: does NOT execute any plugin step, does NOT write to the database, makes zero network calls beyond the workflow row fetch.",
      "Return shape: { ok: true, result: { nodes: Array<{ nodeId, nodeName, type, pinSchema: JSONSchema, required: boolean }> } }.",
      "Each node's pinSchema is a JSON Schema with type:object describing the fields its plugin action expects.",
      "`required` on each node is true when the action declares one or more required configFields.",
      "Use this to learn what pin data to supply before invoking the future test_workflow execution tool (on the roadmap — see specs/mcp-test-workflow.md).",
    ].join(" "),
    {
      workflowId: z
        .string()
        .describe(
          "The workflow ID to introspect. Must belong to the caller's org."
        ),
    },
    {
      title: "Prepare Test Pin Data",
      readOnlyHint: true,
      destructiveHint: false,
    },
    withScopeCheck("prepare_test_pin_data", scope, async (args) =>
      withToolLogging("prepare_test_pin_data", undefined, async () => {
        const data = await callApi(
          internalApiBaseUrl,
          authHeader,
          `/api/workflows/${encodeURIComponent(args.workflowId)}/test-pins/prepare`,
          "GET"
        );
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      })
    )
  );

  // Curator tool 4: Read listing metadata for a workflow by slug
  server.tool(
    "get_workflow_listing",
    "Read full listing metadata for a workflow by its public slug. Public access; no auth required.",
    {
      slug: z
        .string()
        .describe("The workflow's public listing slug (e.g. 'my-defi-alert')"),
    },
    {
      title: "Get Workflow Listing",
      readOnlyHint: true,
      destructiveHint: false,
    },
    withScopeCheck("get_workflow_listing", scope, async (args) =>
      withToolLogging("get_workflow_listing", undefined, async () => {
        const data = await callApi(
          internalApiBaseUrl,
          authHeader,
          `/api/mcp/workflows/${encodeURIComponent(args.slug)}/listing`,
          "GET"
        );
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      })
    )
  );
}
