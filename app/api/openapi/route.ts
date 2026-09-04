import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { workflows } from "@/lib/db/schema";
import { sanitizeDescription } from "@/lib/sanitize-description";
import { docsUrl } from "@/lib/site/identity";
import { workflowNotDeleted } from "@/lib/workflow/soft-delete";

export const dynamic = "force-dynamic";

const TRAILING_SLASH = /\/$/;

function deriveBaseUrl(request: Request): string {
  const envUrl = process.env.NEXT_PUBLIC_APP_URL ?? process.env.BETTER_AUTH_URL;
  if (envUrl) {
    return envUrl.replace(TRAILING_SLASH, "");
  }
  const url = new URL(request.url);
  return `${url.protocol}//${url.host}`;
}

const DISCOVERY_COLUMNS = {
  id: workflows.id,
  name: workflows.name,
  description: workflows.description,
  listedSlug: workflows.listedSlug,
  inputSchema: workflows.inputSchema,
  priceUsdcPerCall: workflows.priceUsdcPerCall,
  workflowType: workflows.workflowType,
  category: workflows.category,
  chain: workflows.chain,
} as const;

type DiscoveryWorkflow = {
  id: string;
  name: string;
  description: string | null;
  listedSlug: string | null;
  inputSchema: Record<string, unknown> | null;
  priceUsdcPerCall: string | null;
  workflowType: "read" | "write";
  category: string | null;
  chain: string | null;
};

// ---------------------------------------------------------------------------
// Versioning, errors, and rate limits
//
// These three blocks are what turns the document from "here are some URLs" into
// something an agent can integrate against unattended: it can pin a version,
// parse a failure without regex-matching prose, and self-throttle before it is
// refused. All three describe behaviour that already ships - the envelope is
// lib/errors/api-envelope.ts, the headers are lib/rate-limit-headers.ts - they
// were simply never written down where a machine could read them.
// ---------------------------------------------------------------------------

/** Current major version of the REST surface. */
const API_VERSION = "1";

/**
 * Minimum notice, in days, between an endpoint gaining a `Deprecation` header
 * and the `Sunset` date it carries. Published so a caller can plan against the
 * guarantee rather than discovering it when something stops answering.
 */
const DEPRECATION_NOTICE_DAYS = 180;

const VERSION_PARAMETER = {
  name: "KeeperHub-Version",
  in: "header",
  required: false,
  description:
    "Pins the request to a major version of the REST surface. Omit to use the current version. A breaking change ships as a new version rather than in place, so a pinned caller keeps its behaviour.",
  schema: { type: "string", enum: [API_VERSION], default: API_VERSION },
} as const;

/**
 * The error envelope every REST endpoint returns, defined in
 * lib/errors/api-envelope.ts. `error` is the stable machine-readable code -
 * clients branch on it; `detail` is prose and may be reworded at any time.
 */
const ERROR_SCHEMA = {
  type: "object",
  required: ["error", "detail"],
  properties: {
    error: {
      type: "string",
      description:
        "Stable snake_case error code. Branch on this value; it does not change across releases.",
      examples: ["rate_limited"],
    },
    detail: {
      type: "string",
      description:
        "Human-readable explanation. Wording is not stable - never parse it.",
    },
    hint: {
      type: "string",
      description: "Suggested next step for the caller, when one exists.",
    },
    docs: {
      type: "string",
      format: "uri",
      description: "Deep link to the relevant documentation, when one exists.",
    },
    request_id: {
      type: "string",
      description:
        "Correlation id, echoed on the x-request-id response header. Quote it in support requests.",
    },
  },
} as const;

/** The canonical codes. Route-specific codes exist; these are the shared set. */
const ERROR_CODES: readonly string[] = [
  "unauthorized",
  "insufficient_scope",
  "not_found",
  "invalid_input",
  "conflict",
  "rate_limited",
  "internal_error",
];

const RATE_LIMIT_HEADERS = {
  "RateLimit-Limit": {
    description: "Requests permitted in the current window.",
    schema: { type: "integer" },
  },
  "RateLimit-Remaining": {
    description: "Requests left in the current window.",
    schema: { type: "integer" },
  },
  "RateLimit-Reset": {
    description: "Seconds until the current window resets.",
    schema: { type: "integer" },
  },
  "X-RateLimit-Limit": {
    description: "Legacy spelling of RateLimit-Limit.",
    schema: { type: "integer" },
  },
  "X-RateLimit-Remaining": {
    description: "Legacy spelling of RateLimit-Remaining.",
    schema: { type: "integer" },
  },
  "X-RateLimit-Reset": {
    description:
      "Legacy spelling. Unix epoch seconds at which the window resets - an absolute time, not a delta.",
    schema: { type: "integer" },
  },
} as const;

const RETRY_AFTER_HEADER = {
  description: "Seconds to wait before retrying.",
  schema: { type: "integer" },
} as const;

function errorResponse(
  description: string,
  extraHeaders?: Record<string, unknown>
): Record<string, unknown> {
  return {
    description,
    headers: {
      "x-request-id": {
        description: "Correlation id, matching request_id in the body.",
        schema: { type: "string" },
      },
      ...extraHeaders,
    },
    content: {
      "application/json": { schema: { $ref: "#/components/schemas/Error" } },
    },
  };
}

/** Error responses attached to every operation in the document. */
const COMMON_ERROR_RESPONSES: Record<string, unknown> = {
  400: { $ref: "#/components/responses/InvalidInput" },
  401: { $ref: "#/components/responses/Unauthorized" },
  403: { $ref: "#/components/responses/InsufficientScope" },
  404: { $ref: "#/components/responses/NotFound" },
  429: { $ref: "#/components/responses/RateLimited" },
  500: { $ref: "#/components/responses/InternalError" },
};

function buildPathEntry(workflow: DiscoveryWorkflow): Record<string, unknown> {
  const isPaid = Number(workflow.priceUsdcPerCall ?? "0") > 0;
  const isWrite = workflow.workflowType === "write";

  const operation: Record<string, unknown> = {
    operationId: `call-${workflow.listedSlug}`,
    summary: workflow.name,
    description: workflow.description
      ? sanitizeDescription(workflow.description)
      : undefined,
  };

  // Canonical OpenAPI 3.x auth declaration. Paid routes leave `security`
  // unset (their auth comes via x-payment-info → 402); non-paid routes
  // declare `security: []` which OpenAPI defines as "no authentication
  // required". Discovery scanners (agentcash, x402scan, CDP Bazaar) read
  // the standard fields, not custom x-auth-mode extensions.
  // Both read and write listings can be paid: a priced write listing charges
  // for the unsigned calldata it returns, so it must not advertise
  // `security: []` on an endpoint that answers 402.
  if (!isPaid) {
    operation.security = [];
  }

  if (isWrite) {
    operation["x-workflow-type"] = "write";
  }

  if (isPaid) {
    operation["x-payment-info"] = {
      price: {
        mode: "fixed",
        amount: workflow.priceUsdcPerCall,
        currency: "USD",
      },
      protocols: [
        { x402: { network: "eip155:8453" } },
        { mpp: { method: "tempo", intent: "charge", currency: "USDC" } },
      ],
    };
  }

  // Always declare a request body for paid routes so scanners get a clean
  // input schema (validator complains: L3_INPUT_SCHEMA_MISSING). For
  // workflows whose owners haven't backfilled inputSchema in the DB, fall
  // back to an open object — better than nothing.
  if (workflow.inputSchema && "properties" in workflow.inputSchema) {
    operation.requestBody = {
      required: true,
      content: {
        "application/json": { schema: workflow.inputSchema },
      },
    };
  } else if (isPaid || isWrite) {
    // Fallback so paid+write routes always declare a body schema. Validators
    // (e.g. @agentcash/discovery) flag L3_INPUT_SCHEMA_MISSING when paid
    // routes have no requestBody at all. `type: object` already permits any
    // properties; no `additionalProperties: true` needed.
    operation.requestBody = {
      required: false,
      content: {
        "application/json": { schema: { type: "object" } },
      },
    };
  }

  const responses: Record<string, unknown> = {};

  if (isWrite) {
    responses["200"] = {
      description: "Unsigned transaction calldata",
      headers: RATE_LIMIT_HEADERS,
      content: {
        "application/json": {
          schema: {
            type: "object",
            properties: {
              type: { type: "string", const: "calldata" },
              to: { type: "string" },
              data: { type: "string" },
              value: { type: "string" },
            },
          },
        },
      },
    };
  } else {
    responses["200"] = {
      description: "Workflow execution started",
      headers: RATE_LIMIT_HEADERS,
      content: {
        "application/json": {
          schema: {
            type: "object",
            properties: {
              executionId: { type: "string" },
              status: { type: "string", const: "running" },
            },
          },
        },
      },
    };
  }

  if (isPaid) {
    responses["402"] = {
      description:
        "Payment Required. The body carries the payment challenge described in x-payment-info; settle it and replay the request.",
      content: {
        "application/json": { schema: { $ref: "#/components/schemas/Error" } },
      },
    };
  }

  operation.responses = { ...responses, ...COMMON_ERROR_RESPONSES };
  operation.parameters = [VERSION_PARAMETER];

  return { post: operation };
}

/**
 * The endpoints an integrator reaches for before any workflow call: is the
 * service up, which chains does it support, what can I call, and does my
 * credential work. Documented here so the OpenAPI document describes a
 * verifiable API surface on its own, rather than only the marketplace listings
 * that happen to exist in the database at the moment it is generated.
 */
function discoveryPaths(): Record<string, Record<string, unknown>> {
  const listResponse = {
    description: "Listed workflows with their pricing and input schemas.",
    headers: RATE_LIMIT_HEADERS,
    content: { "application/json": { schema: { type: "object" } } },
  };
  return {
    "/api/health": {
      get: {
        operationId: "get-health",
        summary: "Service health",
        description:
          "Liveness probe. Answers without authentication and without touching the database.",
        security: [],
        parameters: [VERSION_PARAMETER],
        responses: {
          200: {
            description: "The service is up.",
            content: { "application/json": { schema: { type: "object" } } },
          },
          ...COMMON_ERROR_RESPONSES,
        },
      },
    },
    "/api/chains": {
      get: {
        operationId: "list-chains",
        summary: "Supported chains",
        description:
          "The live source of truth for supported chains, including each chain's support status. Public: answers whether or not a credential is supplied, so it tests reachability rather than a credential.",
        security: [],
        parameters: [VERSION_PARAMETER],
        responses: {
          200: {
            description: "Supported chains and their status.",
            content: { "application/json": { schema: { type: "object" } } },
          },
          ...COMMON_ERROR_RESPONSES,
        },
      },
    },
    "/api/mcp/workflows": {
      get: {
        operationId: "list-listed-workflows",
        summary: "Discover callable workflows",
        description:
          "Every listed marketplace workflow with its slug, price, and input schema. Enumerate slugs from here rather than guessing call paths.",
        security: [],
        parameters: [VERSION_PARAMETER],
        responses: { 200: listResponse, ...COMMON_ERROR_RESPONSES },
      },
    },
    "/api/keys": {
      get: {
        operationId: "verify-credential",
        summary: "Verify an organization API key",
        description:
          "The auth probe. 200 means the credential is valid and scoped to an organization; 401 means it is not. Point first-run scripts and health checks here.",
        security: [{ bearerAuth: [] }],
        parameters: [VERSION_PARAMETER],
        responses: {
          200: {
            description: "The credential is valid.",
            content: { "application/json": { schema: { type: "object" } } },
          },
          ...COMMON_ERROR_RESPONSES,
        },
      },
    },
  };
}

export async function GET(request: Request): Promise<Response> {
  const baseUrl = deriveBaseUrl(request);

  const rows = await db
    .select(DISCOVERY_COLUMNS)
    .from(workflows)
    .where(and(eq(workflows.isListed, true), workflowNotDeleted()));

  const paths: Record<string, Record<string, unknown>> = {};

  for (const row of rows as DiscoveryWorkflow[]) {
    if (!row.listedSlug) {
      continue;
    }
    paths[`/api/mcp/workflows/${row.listedSlug}/call`] = buildPathEntry(row);
  }

  const doc = {
    openapi: "3.1.0",
    info: {
      title: "KeeperHub",
      version: `${API_VERSION}.0.0`,
      description:
        "Web3 workflow automation platform. Workflows are callable by AI agents via REST or MCP.",
      "x-guidance": [
        "KeeperHub exposes workflows as REST endpoints under /api/mcp/workflows/{slug}/call.",
        "Each workflow has a slug, accepts a JSON body, and returns a JSON response with `executionId`, `status`, and `output`.",
        "Auth: paid workflows return HTTP 402 with x402/MPP payment info on the first call; pay (e.g. via agentcash, openclaw, or any x402 client) and replay. Free workflows can be called directly.",
        "Categories of workflows include: DeFi yield/risk reads (e.g. usdc-yield-rates-aave-vs-compound, aave-v3-health-check, defi-risk-snapshot), tipping primitives (microtip), and write-type workflows that return unsigned calldata for the caller to sign and broadcast.",
        "",
        "## Worked examples",
        "",
        "### Example 1: Compare USDC yield (paid, $0.01)",
        "POST /api/mcp/workflows/usdc-yield-rates-aave-vs-compound/call",
        "Body: {}",
        'Response (after payment): { executionId, status: "success", output: { result: { rates: [...], bestRate, bestProtocol } } }',
        "",
        "### Example 2: Aave v3 health check (paid, $0.01)",
        "POST /api/mcp/workflows/aave-v3-health-check/call",
        'Body: { "address": "0x..." }',
        'Response (after payment): { executionId, status: "success", output: { result: { healthFactor, totalCollateralUSD, totalDebtUSD, riskLevel } } }',
        "",
        "### Example 3: Discover available workflows (free)",
        "GET /api/mcp/workflows  (returns the list of all listed workflows + pricing)",
        "GET /openapi.json       (this document; full schema for every workflow)",
        "",
        "When in doubt, fetch /openapi.json and read the per-workflow `x-payment-info`, `security`, and `requestBody` fields.",
        "",
        "## Errors, versioning, and rate limits",
        "",
        "Every failure returns the same envelope: `{ error, detail, hint?, docs?, request_id }`. Branch on `error` (a stable snake_case code) and never on `detail`. See `components.schemas.Error` and `x-error-model`.",
        `Pin a call to a version with the \`KeeperHub-Version: ${API_VERSION}\` request header; omit it to track the current version. Breaking changes ship as a new version, announced with \`Deprecation\` and \`Sunset\` headers at least ${DEPRECATION_NOTICE_DAYS} days apart. See \`x-api-versioning\`.`,
        "Limited endpoints return `RateLimit-Limit`, `RateLimit-Remaining`, and `RateLimit-Reset` (delta seconds), plus the legacy `X-RateLimit-*` spellings, and `Retry-After` on a 429. Self-throttle from those rather than backing off blindly.",
      ].join("\n"),
    },
    // Machine-readable restatement of the three contracts above, so a scanner
    // does not have to read info.description prose to find them.
    "x-api-versioning": {
      current: API_VERSION,
      strategy: "header",
      header: VERSION_PARAMETER.name,
      supported: [API_VERSION],
      policy:
        "Additive changes (new endpoints, new optional fields, new enum members) ship inside the current version. Breaking changes ship as a new version and never in place.",
      deprecation: {
        headers: ["Deprecation", "Sunset", "Link"],
        deprecationHeader:
          "RFC 9745. Present once an endpoint or version is deprecated; carries the date the deprecation took effect.",
        sunsetHeader:
          "RFC 8594. The earliest date the endpoint may stop answering.",
        linkHeader:
          'Link: <url>; rel="deprecation" points at the migration note.',
        minimumNoticeDays: DEPRECATION_NOTICE_DAYS,
      },
    },
    "x-error-model": {
      mediaType: "application/json",
      schema: "#/components/schemas/Error",
      codeField: "error",
      messageField: "detail",
      correlationField: "request_id",
      correlationHeader: "x-request-id",
      codes: [...ERROR_CODES],
    },
    "x-rate-limits": {
      headers: Object.keys(RATE_LIMIT_HEADERS),
      retryAfterHeader: "Retry-After",
      pollIntervalHeader: "X-Poll-Interval-Hint",
      documented: `${docsUrl()}/api/errors`,
    },
    "x-service-info": {
      categories: ["web3", "automation", "blockchain"],
      docs: { homepage: docsUrl() },
      developerPortal: `${docsUrl()}/platform-reference`,
      errors: `${docsUrl()}/api/errors`,
      mcp: {
        card: `${baseUrl}/.well-known/mcp.json`,
        endpoint: `${baseUrl}/mcp`,
        publicEndpoint: `${baseUrl}/mcp/public`,
        transport: "streamable-http",
      },
      cli: {
        name: "kh",
        install: "brew install keeperhub/tap/kh",
        docs: `${docsUrl()}/cli/quickstart`,
      },
      sandbox: {
        // No separate sandbox host: the supported testnets plus preflight
        // simulation are the test environment.
        testnets: [
          { name: "Ethereum Sepolia", chainId: 11_155_111 },
          { name: "Base Sepolia", chainId: 84_532 },
        ],
        simulation:
          "Direct-execution tools accept simulate: true, which reports whether a transaction would revert without broadcasting it. EVM chains only.",
        docs: `${docsUrl()}/platform-reference`,
      },
    },
    servers: [{ url: baseUrl }],
    components: {
      schemas: { Error: ERROR_SCHEMA },
      headers: { ...RATE_LIMIT_HEADERS, "Retry-After": RETRY_AFTER_HEADER },
      parameters: { KeeperHubVersion: VERSION_PARAMETER },
      responses: {
        InvalidInput: errorResponse(
          "The request body or query failed validation. `error` is `invalid_input`."
        ),
        Unauthorized: errorResponse(
          "The credential is missing, malformed, or revoked. `error` is `unauthorized`."
        ),
        InsufficientScope: errorResponse(
          "The credential is valid but not permitted for this operation. `error` is `insufficient_scope`."
        ),
        NotFound: errorResponse(
          "The route or the resource does not exist. `error` is `not_found`."
        ),
        Conflict: errorResponse(
          "The request contradicts current state, for example a reused idempotency key with a different body. `error` is `conflict`."
        ),
        RateLimited: errorResponse(
          "A published rate limit was exceeded. `error` is `rate_limited`. Wait for `Retry-After` seconds before retrying.",
          { ...RATE_LIMIT_HEADERS, "Retry-After": RETRY_AFTER_HEADER }
        ),
        InternalError: errorResponse(
          "An unexpected server fault. `error` is `internal_error`. Retry with backoff and quote `request_id` if it persists."
        ),
      },
      // Declared for discovery only. Paid operations deliberately leave
      // `security` unset — the HTTP 402 challenge-response conveys auth (see
      // x-payment-info). These schemes document the supported payment/identity
      // mechanisms for scanners; they are not referenced per-operation.
      securitySchemes: {
        x402: {
          type: "http",
          scheme: "Payment",
          description:
            "x402 challenge-response payment. The first unpaid call returns HTTP 402 with payment requirements; the client signs that payment and replays the request.",
        },
        siwx: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "CAIP-122",
          description:
            "Sign-In with X identity proof (CAIP-122) for compatible agent clients. KeeperHub workflow calls primarily use x402 payment discovery today.",
        },
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          description:
            "An organization API key (prefix `kh_`) or an OAuth access token, sent as `Authorization: Bearer <token>`. Create an organization key from the API Keys screen; verify it with GET /api/keys.",
        },
      },
    },
    paths: { ...discoveryPaths(), ...paths },
  };

  return Response.json(doc, {
    headers: {
      "Cache-Control": "public, max-age=300, stale-while-revalidate=600",
    },
  });
}
