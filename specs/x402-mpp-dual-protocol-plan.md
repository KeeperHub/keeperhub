# x402 + MPP Dual-Protocol Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add MPP payment protocol alongside existing x402 on the workflow call route, and expose OpenAPI 3.1.0 discovery endpoints for x402scan/mppscan registration.

**Architecture:** Payment router module (`lib/payments/router.ts`) detects protocol from request headers and dispatches to x402 (existing `withX402`) or MPP (`mppx.charge`). Discovery endpoints dynamically generate OpenAPI docs from listed workflows. Schema adds `protocol` and `chain` columns to `workflow_payments`.

**Tech Stack:** mppx (v0.5.12), @x402/next (existing), Drizzle ORM, Next.js App Router

**Spec:** `specs/x402-mpp-dual-protocol.md`

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `lib/db/schema-payments.ts` | Modify | Add `protocol` and `chain` columns |
| `lib/mpp/server.ts` | Create | MPP server instance, payer extraction, credential hashing |
| `lib/payments/router.ts` | Create | Protocol detection, dual-402 challenge, dispatch to x402/mpp |
| `app/api/openapi/route.ts` | Create | Dynamic OpenAPI 3.1.0 discovery endpoint |
| `app/.well-known/x402/route.ts` | Create | Fallback x402 discovery |
| `lib/x402/payment-gate.ts` | Modify | Update `recordPayment` / `NewWorkflowPayment` for new columns |
| `app/api/mcp/workflows/[slug]/call/route.ts` | Modify | Refactor `handlePaidWorkflow` to use payment router |
| `next.config.ts` | Modify | Add rewrite `/openapi.json` -> `/api/openapi` |
| `.env.example` | Modify | Add `MPP_SECRET_KEY` |
| `tests/unit/payment-router.test.ts` | Create | Router protocol detection + dispatch tests |
| `tests/unit/mpp-server.test.ts` | Create | MPP helper function tests |
| `tests/unit/openapi-route.test.ts` | Create | Discovery endpoint tests |

---

### Task 1: Install mppx and add env var

**Files:**
- Modify: `package.json`
- Modify: `.env.example`

- [ ] **Step 1: Install mppx**

```bash
pnpm add mppx@^0.5.12
```

- [ ] **Step 2: Add MPP_SECRET_KEY to .env.example**

In `.env.example`, after the `CDP_API_KEY_SECRET=` line, add:

```
MPP_SECRET_KEY=              # HMAC secret for MPP challenge verification
```

- [ ] **Step 3: Commit**

```bash
git add package.json pnpm-lock.yaml .env.example
git commit -m "chore: add mppx dependency and MPP_SECRET_KEY env var"
```

---

### Task 2: Schema migration -- add protocol and chain columns

**Files:**
- Modify: `lib/db/schema-payments.ts`
- Test: `tests/unit/mpp-server.test.ts` (deferred to Task 4)

- [ ] **Step 1: Update Drizzle schema**

In `lib/db/schema-payments.ts`, add the `varchar` import and two new columns to the `workflowPayments` table definition. After the `settledAt` column:

```typescript
import {
  index,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";
```

Add these columns after `settledAt`:

```typescript
    protocol: varchar("protocol", { length: 10 }).notNull().default("x402"),
    chain: text("chain").notNull().default("base"),
```

- [ ] **Step 2: Generate migration**

```bash
pnpm drizzle-kit generate
```

Expected: Creates a new migration file in `drizzle/` (e.g., `0047_*.sql`) with:
```sql
ALTER TABLE "workflow_payments" ADD COLUMN "protocol" varchar(10) DEFAULT 'x402' NOT NULL;
ALTER TABLE "workflow_payments" ADD COLUMN "chain" text DEFAULT 'base' NOT NULL;
```

- [ ] **Step 3: Verify journal timestamp is monotonically increasing**

Read `drizzle/meta/_journal.json`. The new entry's `when` must be greater than `1775806152381` (the previous entry). If not, manually adjust.

- [ ] **Step 4: Run type-check**

```bash
pnpm type-check
```

Expected: PASS -- the `NewWorkflowPayment` type auto-infers the new columns with defaults, so existing callsites don't break.

- [ ] **Step 5: Commit**

```bash
git add lib/db/schema-payments.ts drizzle/ 
git commit -m "feat(db): add protocol and chain columns to workflow_payments"
```

---

### Task 3: MPP server module

**Files:**
- Create: `lib/mpp/server.ts`
- Test: `tests/unit/mpp-server.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/unit/mpp-server.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { extractMppPayerAddress, hashMppCredential } from "@/lib/payments/mpp/server";

describe("extractMppPayerAddress", () => {
  it("extracts address from did:pkh DID source", () => {
    const did = "did:pkh:eip155:4217:0xAbCdEf1234567890AbCdEf1234567890AbCdEf12";
    expect(extractMppPayerAddress(did)).toBe(
      "0xAbCdEf1234567890AbCdEf1234567890AbCdEf12"
    );
  });

  it("returns null for null input", () => {
    expect(extractMppPayerAddress(null)).toBeNull();
  });

  it("returns null for malformed DID", () => {
    expect(extractMppPayerAddress("not-a-did")).toBeNull();
  });

  it("returns the full string if no colon separators", () => {
    expect(extractMppPayerAddress("0xSomeAddress")).toBe("0xSomeAddress");
  });
});

describe("hashMppCredential", () => {
  it("returns a hex SHA-256 hash", () => {
    const hash = hashMppCredential("Payment eyJjaGFsbGVuZ2UiOnt9fQ");
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("is deterministic", () => {
    const a = hashMppCredential("Payment abc123");
    const b = hashMppCredential("Payment abc123");
    expect(a).toBe(b);
  });

  it("produces different hashes for different inputs", () => {
    const a = hashMppCredential("Payment abc");
    const b = hashMppCredential("Payment xyz");
    expect(a).not.toBe(b);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm vitest run tests/unit/mpp-server.test.ts
```

Expected: FAIL -- module `@/lib/payments/mpp/server` does not exist.

- [ ] **Step 3: Implement MPP server module**

Create `lib/mpp/server.ts`:

```typescript
import { createHash } from "node:crypto";

const TEMPO_USDC_ADDRESS = "0x20c000000000000000000000b9537d11c60e8b50";

export function createMppServer(): unknown {
  // Lazy-import to avoid loading mppx when MPP_SECRET_KEY is not set.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Mppx } = require("mppx/server") as typeof import("mppx/server");
  const { charge } = require("mppx/tempo") as typeof import("mppx/tempo");

  return Mppx.create({
    methods: [charge({ currency: TEMPO_USDC_ADDRESS })],
  });
}

let _mppServer: ReturnType<typeof createMppServer> | null = null;

export function getMppServer(): ReturnType<typeof createMppServer> {
  if (!_mppServer) {
    _mppServer = createMppServer();
  }
  return _mppServer;
}

export function extractMppPayerAddress(source: string | null): string | null {
  if (!source) {
    return null;
  }
  const parts = source.split(":");
  return parts.at(-1) ?? null;
}

export function hashMppCredential(authHeaderValue: string): string {
  return createHash("sha256").update(authHeaderValue).digest("hex");
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm vitest run tests/unit/mpp-server.test.ts
```

Expected: PASS

- [ ] **Step 5: Run lint and type-check**

```bash
pnpm check && pnpm type-check
```

- [ ] **Step 6: Commit**

```bash
git add lib/mpp/server.ts tests/unit/mpp-server.test.ts
git commit -m "feat(mpp): add MPP server module with payer extraction and credential hashing"
```

---

### Task 4: Payment router module

**Files:**
- Create: `lib/payments/router.ts`
- Test: `tests/unit/payment-router.test.ts`

- [ ] **Step 1: Write failing tests for protocol detection**

Create `tests/unit/payment-router.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { detectProtocol } from "@/lib/payments/router";

describe("detectProtocol", () => {
  it("returns 'mpp' when Authorization: Payment header is present", () => {
    const req = new Request("http://localhost", {
      headers: { Authorization: "Payment eyJjaGFsbGVuZ2UiOnt9fQ" },
    });
    expect(detectProtocol(req)).toBe("mpp");
  });

  it("returns 'x402' when PAYMENT-SIGNATURE header is present", () => {
    const req = new Request("http://localhost", {
      headers: { "PAYMENT-SIGNATURE": "base64sig" },
    });
    expect(detectProtocol(req)).toBe("x402");
  });

  it("returns null when no payment headers are present", () => {
    const req = new Request("http://localhost");
    expect(detectProtocol(req)).toBeNull();
  });

  it("returns 'error' when both headers are present", () => {
    const req = new Request("http://localhost", {
      headers: {
        Authorization: "Payment eyJ...",
        "PAYMENT-SIGNATURE": "base64sig",
      },
    });
    expect(detectProtocol(req)).toBe("error");
  });

  it("ignores Authorization headers that are not Payment scheme", () => {
    const req = new Request("http://localhost", {
      headers: { Authorization: "Bearer token123" },
    });
    expect(detectProtocol(req)).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm vitest run tests/unit/payment-router.test.ts
```

Expected: FAIL

- [ ] **Step 3: Implement protocol detection**

Create `lib/payments/router.ts`:

```typescript
export type PaymentProtocol = "x402" | "mpp";

export type PaymentMeta = {
  protocol: PaymentProtocol;
  chain: "base" | "tempo";
  payerAddress: string | null;
};

export function detectProtocol(
  request: Request
): PaymentProtocol | "error" | null {
  const hasAuthorization = request.headers
    .get("authorization")
    ?.startsWith("Payment ");
  const hasPaymentSig = Boolean(request.headers.get("PAYMENT-SIGNATURE"));

  if (hasAuthorization && hasPaymentSig) {
    return "error";
  }
  if (hasAuthorization) {
    return "mpp";
  }
  if (hasPaymentSig) {
    return "x402";
  }
  return null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm vitest run tests/unit/payment-router.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/payments/router.ts tests/unit/payment-router.test.ts
git commit -m "feat(payments): add payment router with protocol detection"
```

---

### Task 5: Build the dual-402 challenge builder

**Files:**
- Modify: `lib/payments/router.ts`
- Modify: `tests/unit/payment-router.test.ts`

- [ ] **Step 1: Write failing test for dual-402 response builder**

Add to `tests/unit/payment-router.test.ts`:

```typescript
import { buildDual402Response } from "@/lib/payments/router";

describe("buildDual402Response", () => {
  it("returns a 402 response", async () => {
    const response = buildDual402Response({
      price: "0.01",
      creatorWalletAddress: "0xCreator",
      workflowName: "Test Workflow",
    });
    expect(response.status).toBe(402);
  });

  it("includes CORS headers", async () => {
    const response = buildDual402Response({
      price: "0.01",
      creatorWalletAddress: "0xCreator",
      workflowName: "Test Workflow",
    });
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm vitest run tests/unit/payment-router.test.ts
```

Expected: FAIL -- `buildDual402Response` is not exported.

- [ ] **Step 3: Implement the dual-402 builder**

Add to `lib/payments/router.ts`:

```typescript
import { buildPaymentConfig } from "@/lib/payments/x402/payment-gate";
import type { CallRouteWorkflow } from "@/lib/payments/x402/types";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, PAYMENT-SIGNATURE",
  "Access-Control-Expose-Headers": "Payment-Receipt",
} as const;

type Dual402Params = {
  price: string;
  creatorWalletAddress: string;
  workflowName: string;
};

export function buildDual402Response(params: Dual402Params): Response {
  const { price, creatorWalletAddress, workflowName } = params;

  const x402Requirements = {
    accepts: {
      scheme: "exact",
      network: "eip155:8453",
      payTo: creatorWalletAddress,
      price: `$${Number(price).toFixed(2)}`,
    },
    description: `Pay to run workflow: ${workflowName}`,
  };

  const x402Header = Buffer.from(
    JSON.stringify(x402Requirements)
  ).toString("base64");

  const headers = new Headers(CORS_HEADERS);
  headers.set("X-PAYMENT-REQUIREMENTS", x402Header);
  headers.set("Cache-Control", "no-store");

  return new Response(
    JSON.stringify({
      error: "Payment Required",
      x402: x402Requirements,
    }),
    { status: 402, headers }
  );
}
```

Note: The MPP `WWW-Authenticate` header will be added in Task 8 (call route integration) after we confirm the `mppx` Challenge API works in the full context. For now, the x402 half of the dual-402 is the critical path since it's what existing clients use.

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm vitest run tests/unit/payment-router.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/payments/router.ts tests/unit/payment-router.test.ts
git commit -m "feat(payments): add dual-402 challenge response builder"
```

---

### Task 6: Update payment-gate for new columns

**Files:**
- Modify: `lib/x402/payment-gate.ts`

- [ ] **Step 1: Verify existing tests still pass with no changes**

```bash
pnpm vitest run tests/unit/x402-call-route.test.ts tests/unit/x402-reconcile.test.ts
```

Expected: PASS

- [ ] **Step 2: No code changes needed to payment-gate.ts**

The `recordPayment` function accepts `NewWorkflowPayment` which is auto-inferred from the Drizzle schema. Since Task 2 added `protocol` and `chain` with defaults, existing callsites that don't pass these fields will use the defaults (`'x402'` and `'base'`). The MPP path in the call route (Task 8) will pass them explicitly.

Verify this by running type-check:

```bash
pnpm type-check
```

Expected: PASS -- no type errors from existing `recordPayment()` call in `route.ts`.

- [ ] **Step 3: Run the full existing test suite**

```bash
pnpm vitest run tests/unit/x402-call-route.test.ts tests/unit/x402-reconcile.test.ts
```

Expected: PASS -- existing x402 behavior unaffected.

- [ ] **Step 4: Commit** (skip if no files changed)

---

### Task 7: Discovery endpoints

**Files:**
- Create: `app/api/openapi/route.ts`
- Create: `app/.well-known/x402/route.ts`
- Modify: `next.config.ts`
- Test: `tests/unit/openapi-route.test.ts`

- [ ] **Step 1: Write failing test for OpenAPI generation**

Create `tests/unit/openapi-route.test.ts`:

```typescript
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockDbSelect = vi.fn();

vi.mock("@/lib/db", () => ({
  db: { select: mockDbSelect },
}));

vi.mock("@/lib/db/schema", () => ({
  workflows: {
    id: "id",
    name: "name",
    description: "description",
    listedSlug: "listed_slug",
    inputSchema: "input_schema",
    priceUsdcPerCall: "price_usdc_per_call",
    workflowType: "workflow_type",
    category: "category",
    chain: "chain",
    isListed: "is_listed",
  },
}));

vi.mock("@/lib/sanitize-description", () => ({
  sanitizeDescription: (s: string) => s,
}));

describe("GET /api/openapi", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NEXT_PUBLIC_APP_URL = "https://app.keeperhub.com";
  });

  it("returns valid OpenAPI 3.1.0 structure", async () => {
    mockDbSelect.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    });

    const { GET } = await import("@/app/api/openapi/route");
    const request = new Request("https://app.keeperhub.com/api/openapi");
    const response = await GET(request);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.openapi).toBe("3.1.0");
    expect(body.info.title).toBe("KeeperHub");
    expect(body.servers[0].url).toBe("https://app.keeperhub.com");
  });

  it("includes x-payment-info for paid read workflows", async () => {
    mockDbSelect.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([
          {
            id: "wf-1",
            name: "Paid Workflow",
            description: "A paid workflow",
            listedSlug: "paid-workflow",
            inputSchema: { type: "object", properties: { msg: { type: "string" } } },
            priceUsdcPerCall: "0.05",
            workflowType: "read",
            category: "web3",
            chain: "base",
          },
        ]),
      }),
    });

    const { GET } = await import("@/app/api/openapi/route");
    const request = new Request("https://app.keeperhub.com/api/openapi");
    const response = await GET(request);
    const body = await response.json();
    const path = body.paths["/api/mcp/workflows/paid-workflow/call"];

    expect(path).toBeDefined();
    expect(path.post["x-payment-info"]).toBeDefined();
    expect(path.post["x-payment-info"].price.amount).toBe("0.05");
    expect(path.post.responses["402"]).toBeDefined();
  });

  it("excludes x-payment-info for write workflows", async () => {
    mockDbSelect.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([
          {
            id: "wf-2",
            name: "Write Workflow",
            description: "Returns calldata",
            listedSlug: "write-workflow",
            inputSchema: null,
            priceUsdcPerCall: "0.10",
            workflowType: "write",
            category: "web3",
            chain: "base",
          },
        ]),
      }),
    });

    const { GET } = await import("@/app/api/openapi/route");
    const request = new Request("https://app.keeperhub.com/api/openapi");
    const response = await GET(request);
    const body = await response.json();
    const path = body.paths["/api/mcp/workflows/write-workflow/call"];

    expect(path.post["x-payment-info"]).toBeUndefined();
    expect(path.post["x-workflow-type"]).toBe("write");
    expect(path.post.responses["402"]).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm vitest run tests/unit/openapi-route.test.ts
```

Expected: FAIL

- [ ] **Step 3: Implement OpenAPI route**

Create `app/api/openapi/route.ts`:

```typescript
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { workflows } from "@/lib/db/schema";
import { sanitizeDescription } from "@/lib/sanitize-description";

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

function buildPathEntry(workflow: DiscoveryWorkflow): Record<string, unknown> {
  const isPaid =
    workflow.workflowType === "read" &&
    Number(workflow.priceUsdcPerCall ?? "0") > 0;
  const isWrite = workflow.workflowType === "write";

  const operation: Record<string, unknown> = {
    operationId: `call-${workflow.listedSlug}`,
    summary: workflow.name,
    description: workflow.description
      ? sanitizeDescription(workflow.description)
      : undefined,
  };

  if (isWrite) {
    operation["x-workflow-type"] = "write";
  }

  if (isPaid) {
    operation["x-payment-info"] = {
      price: {
        mode: "fixed",
        amount: workflow.priceUsdcPerCall,
        currency: "USDC",
      },
      protocols: [
        { x402: { network: "eip155:8453" } },
        { mpp: { method: "tempo", intent: "charge", currency: "USDC" } },
      ],
    };
  }

  if (workflow.inputSchema && "properties" in workflow.inputSchema) {
    operation.requestBody = {
      required: true,
      content: {
        "application/json": { schema: workflow.inputSchema },
      },
    };
  }

  const responses: Record<string, unknown> = {};

  if (isWrite) {
    responses["200"] = {
      description: "Unsigned transaction calldata",
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
    responses["402"] = { description: "Payment Required" };
  }

  operation.responses = responses;

  return { post: operation };
}

export async function GET(request: Request): Promise<Response> {
  const baseUrl = deriveBaseUrl(request);

  const rows = await db
    .select(DISCOVERY_COLUMNS)
    .from(workflows)
    .where(eq(workflows.isListed, true));

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
      version: "1.0.0",
      description:
        "Web3 workflow automation platform. Workflows are callable by AI agents via REST or MCP.",
      "x-guidance":
        "KeeperHub exposes workflows as REST endpoints. Each workflow has a slug and accepts JSON input. Paid workflows require x402 or MPP payment. Free workflows can be called directly. Use GET /api/mcp/workflows to discover available workflows and their pricing.",
    },
    "x-service-info": {
      categories: ["web3", "automation", "blockchain"],
      docs: { homepage: "https://docs.keeperhub.com" },
    },
    servers: [{ url: baseUrl }],
    paths,
  };

  return Response.json(doc, {
    headers: {
      "Cache-Control": "public, max-age=300, stale-while-revalidate=600",
    },
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm vitest run tests/unit/openapi-route.test.ts
```

Expected: PASS

- [ ] **Step 5: Implement .well-known/x402 route**

Create `app/.well-known/x402/route.ts`:

```typescript
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { workflows } from "@/lib/db/schema";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const rows = await db
    .select({
      listedSlug: workflows.listedSlug,
      priceUsdcPerCall: workflows.priceUsdcPerCall,
      workflowType: workflows.workflowType,
    })
    .from(workflows)
    .where(eq(workflows.isListed, true));

  const resources: string[] = [];
  for (const row of rows) {
    if (
      row.listedSlug &&
      row.workflowType === "read" &&
      Number(row.priceUsdcPerCall ?? "0") > 0
    ) {
      resources.push(`POST /api/mcp/workflows/${row.listedSlug}/call`);
    }
  }

  return Response.json(
    { version: 1, resources },
    {
      headers: {
        "Cache-Control": "public, max-age=300, stale-while-revalidate=600",
      },
    }
  );
}
```

- [ ] **Step 6: Add rewrite to next.config.ts**

In `next.config.ts`, add the `rewrites` function to the `nextConfig` object, after `images`:

```typescript
  async rewrites() {
    return [{ source: "/openapi.json", destination: "/api/openapi" }];
  },
```

- [ ] **Step 7: Run lint and type-check**

```bash
pnpm check && pnpm type-check
```

- [ ] **Step 8: Commit**

```bash
git add app/api/openapi/route.ts app/.well-known/x402/route.ts next.config.ts tests/unit/openapi-route.test.ts
git commit -m "feat(discovery): add OpenAPI 3.1.0 and .well-known/x402 discovery endpoints"
```

---

### Task 8: Integrate payment router into call route

**Files:**
- Modify: `app/api/mcp/workflows/[slug]/call/route.ts`
- Modify: `lib/payments/router.ts`

- [ ] **Step 1: Add gatePayment function to router**

Add to `lib/payments/router.ts`:

```typescript
import { type NextRequest, NextResponse } from "next/server";
import { withX402 } from "@x402/next";
import {
  buildPaymentConfig,
  extractPayerAddress,
  findExistingPayment,
  hashPaymentSignature,
} from "@/lib/payments/x402/payment-gate";
import { server } from "@/lib/payments/x402/server";
import {
  isTimeoutError,
  pollForPaymentConfirmation,
} from "@/lib/payments/x402/reconcile";
import { extractMppPayerAddress, hashMppCredential } from "@/lib/payments/mpp/server";
import type { CallRouteWorkflow } from "@/lib/payments/x402/types";

type HandlerFactory = (meta: PaymentMeta) => (req: NextRequest) => Promise<NextResponse>;

async function checkIdempotency(
  paymentHash: string
): Promise<NextResponse | null> {
  const existing = await findExistingPayment(paymentHash);
  if (existing) {
    return NextResponse.json(
      { executionId: existing.executionId },
      { headers: CORS_HEADERS }
    );
  }
  return null;
}

async function handleX402(
  request: Request,
  workflow: CallRouteWorkflow,
  creatorWalletAddress: string,
  createHandler: HandlerFactory
): Promise<NextResponse> {
  const paymentSig = request.headers.get("PAYMENT-SIGNATURE");
  if (paymentSig) {
    const hash = hashPaymentSignature(paymentSig);
    const idempotent = await checkIdempotency(hash);
    if (idempotent) {
      return idempotent;
    }
  }

  const payerAddress = extractPayerAddress(paymentSig);
  const paymentConfig = buildPaymentConfig(workflow, creatorWalletAddress);

  const innerHandler = createHandler({
    protocol: "x402",
    chain: "base",
    payerAddress,
  });

  const gatedHandler = withX402(innerHandler, paymentConfig, server);

  try {
    return (await gatedHandler(request as NextRequest)) as NextResponse;
  } catch (gateErr) {
    const msg = gateErr instanceof Error ? gateErr.message : String(gateErr);
    if (isTimeoutError(msg)) {
      const pAddr = request.headers.get("X-PAYER-ADDRESS");
      const nonce = request.headers.get("X-PAYMENT-NONCE");
      if (pAddr && nonce) {
        const confirmed = await pollForPaymentConfirmation({
          payerAddress: pAddr,
          nonce,
        });
        if (confirmed) {
          if (paymentSig) {
            const hash = hashPaymentSignature(paymentSig);
            const idempotent = await checkIdempotency(hash);
            if (idempotent) {
              return idempotent;
            }
          }
          return innerHandler(request as NextRequest);
        }
      }
    }
    throw gateErr;
  }
}

async function handleMpp(
  request: Request,
  workflow: CallRouteWorkflow,
  creatorWalletAddress: string,
  createHandler: HandlerFactory
): Promise<NextResponse> {
  const authHeader = request.headers.get("authorization");
  if (authHeader) {
    const credentialValue = authHeader.slice("Payment ".length);
    const hash = hashMppCredential(credentialValue);
    const idempotent = await checkIdempotency(hash);
    if (idempotent) {
      return idempotent;
    }
  }

  // Dynamic import to avoid loading mppx when not needed
  const { getMppServer } = await import("@/lib/payments/mpp/server");
  const mppServer = getMppServer() as {
    charge: (opts: { amount: string; recipient: string }) => {
      (request: Request): Promise<{
        status: number;
        challenge?: Response;
        withReceipt: (response: Response) => Response;
        credential?: { source?: string };
      }>;
    };
  };

  const price = workflow.priceUsdcPerCall ?? "0";
  const chargeIntent = mppServer.charge({
    amount: price,
    recipient: creatorWalletAddress,
  });

  const result = await chargeIntent(request);

  if (result.status === 402) {
    return result.challenge as unknown as NextResponse;
  }

  const payerAddress = extractMppPayerAddress(
    result.credential?.source ?? null
  );

  const innerHandler = createHandler({
    protocol: "mpp",
    chain: "tempo",
    payerAddress,
  });

  const response = await innerHandler(request as NextRequest);
  return result.withReceipt(response) as unknown as NextResponse;
}

export async function gatePayment(
  request: Request,
  workflow: CallRouteWorkflow,
  creatorWalletAddress: string,
  createHandler: HandlerFactory
): Promise<NextResponse> {
  const protocol = detectProtocol(request);

  if (protocol === "error") {
    return NextResponse.json(
      { error: "Cannot send both PAYMENT-SIGNATURE and Authorization: Payment headers" },
      { status: 400, headers: CORS_HEADERS }
    );
  }

  if (protocol === "x402") {
    return handleX402(request, workflow, creatorWalletAddress, createHandler);
  }

  if (protocol === "mpp") {
    return handleMpp(request, workflow, creatorWalletAddress, createHandler);
  }

  // No payment header -- return dual 402 challenge
  return buildDual402Response({
    price: workflow.priceUsdcPerCall ?? "0",
    creatorWalletAddress,
    workflowName: workflow.name,
  });
}
```

- [ ] **Step 2: Refactor handlePaidWorkflow in call route**

In `app/api/mcp/workflows/[slug]/call/route.ts`, replace the entire `handlePaidWorkflow` function and its associated imports. Remove these imports that are now handled by the router:

```typescript
// Remove these imports:
import { withX402 } from "@x402/next";
import {
  buildPaymentConfig,
  extractPayerAddress,
  findExistingPayment,
  hashPaymentSignature,
  recordPayment,
  resolveCreatorWallet,
} from "@/lib/payments/x402/payment-gate";
import {
  isTimeoutError,
  pollForPaymentConfirmation,
} from "@/lib/payments/x402/reconcile";
import { server } from "@/lib/payments/x402/server";

// Add these imports:
import { resolveCreatorWallet, recordPayment, hashPaymentSignature } from "@/lib/payments/x402/payment-gate";
import { hashMppCredential } from "@/lib/payments/mpp/server";
import { gatePayment, type PaymentMeta } from "@/lib/payments/router";
```

Replace `handlePaidWorkflow`, `checkIdempotency`, and `handleTimeoutReconciliation` with:

```typescript
async function handlePaidWorkflow(
  request: Request,
  workflow: CallRouteWorkflow,
  body: Record<string, unknown>
): Promise<NextResponse> {
  const creatorWalletAddress = await resolveCreatorWallet(
    workflow.organizationId
  );
  if (!creatorWalletAddress) {
    return NextResponse.json(
      {
        error: "No payment wallet found for this organization",
        message:
          "The workflow owner must create a wallet in Settings > Wallet before listing paid workflows.",
      },
      { status: 503, headers: corsHeaders }
    );
  }

  return gatePayment(request, workflow, creatorWalletAddress, (meta) => {
    return async (_req: NextRequest): Promise<NextResponse> => {
      const prepared = await prepareExecution(workflow, body);
      if ("error" in prepared) {
        return prepared.error;
      }
      const { executionId } = prepared;

      let paymentHash: string;
      if (meta.protocol === "x402") {
        const sig = request.headers.get("PAYMENT-SIGNATURE");
        paymentHash = sig ? hashPaymentSignature(sig) : executionId;
      } else {
        const auth = request.headers.get("authorization");
        paymentHash = auth
          ? hashMppCredential(auth.slice("Payment ".length))
          : executionId;
      }

      try {
        await recordPayment({
          workflowId: workflow.id,
          paymentHash,
          executionId,
          amountUsdc: workflow.priceUsdcPerCall ?? "0",
          payerAddress: meta.payerAddress,
          creatorWalletAddress,
          protocol: meta.protocol,
          chain: meta.chain,
        });
      } catch (err) {
        await db
          .update(workflowExecutions)
          .set({
            status: "error",
            error:
              err instanceof Error
                ? `recordPayment failed: ${err.message}`
                : "recordPayment failed",
          })
          .where(eq(workflowExecutions.id, executionId));
        throw err;
      }

      startExecutionInBackground(workflow, body, executionId);

      return NextResponse.json(
        { executionId, status: "running" },
        { headers: corsHeaders }
      );
    };
  });
}
```

Also update the `corsHeaders` constant to add `Access-Control-Expose-Headers`:

```typescript
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, PAYMENT-SIGNATURE",
  "Access-Control-Expose-Headers": "Payment-Receipt",
} as const;
```

- [ ] **Step 3: Run lint and type-check**

```bash
pnpm check && pnpm type-check
```

Fix any issues.

- [ ] **Step 4: Run existing x402 tests**

```bash
pnpm vitest run tests/unit/x402-call-route.test.ts
```

Expected: Tests may need mock updates since `handlePaidWorkflow` now imports from `@/lib/payments/router` instead of directly from `@x402/next`. Update the mocks if needed -- the key change is adding a mock for `gatePayment`.

- [ ] **Step 5: Commit**

```bash
git add lib/payments/router.ts app/api/mcp/workflows/\\[slug\\]/call/route.ts
git commit -m "feat(payments): integrate payment router with dual x402/MPP dispatch"
```

---

### Task 9: Update existing tests for refactored call route

**Files:**
- Modify: `tests/unit/x402-call-route.test.ts`

- [ ] **Step 1: Update mocks for new imports**

The call route now imports `gatePayment` from `@/lib/payments/router` instead of using `withX402` directly. Add a mock:

```typescript
const mockGatePayment = vi.fn();

vi.mock("@/lib/payments/router", () => ({
  gatePayment: mockGatePayment,
}));
```

Remove the `@x402/next` mock (`vi.mock("@x402/next", ...)`).

Update the `makePassThroughWithX402` helper to simulate `gatePayment` calling through:

```typescript
function makePassThroughGatePayment() {
  mockGatePayment.mockImplementation(
    async (
      _request: Request,
      _workflow: unknown,
      _wallet: string,
      createHandler: (meta: { protocol: string; chain: string; payerAddress: string | null }) => (req: Request) => Promise<Response>
    ) => {
      const handler = createHandler({
        protocol: "x402",
        chain: "base",
        payerAddress: null,
      });
      return handler(_request as never);
    }
  );
}
```

And a 402 variant:

```typescript
function make402GatePayment() {
  mockGatePayment.mockImplementation(async () =>
    new Response(null, { status: 402 })
  );
}
```

- [ ] **Step 2: Update test cases to use new helpers**

Replace calls to `makePassThroughWithX402()` with `makePassThroughGatePayment()` and `make402WithX402()` with `make402GatePayment()` throughout the test file.

- [ ] **Step 3: Run tests**

```bash
pnpm vitest run tests/unit/x402-call-route.test.ts
```

Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add tests/unit/x402-call-route.test.ts
git commit -m "test: update call route tests for payment router refactor"
```

---

### Task 10: Final verification

- [ ] **Step 1: Run full test suite**

```bash
pnpm vitest run
```

Expected: All tests PASS.

- [ ] **Step 2: Run lint and type-check**

```bash
pnpm check && pnpm type-check
```

Expected: No errors.

- [ ] **Step 3: Verify discovery endpoints locally**

Start the dev server:

```bash
pnpm dev
```

Test the endpoints:

```bash
curl -s http://localhost:3000/openapi.json | python3 -m json.tool | head -20
curl -s http://localhost:3000/.well-known/x402 | python3 -m json.tool
```

Expected: Valid JSON responses with OpenAPI 3.1.0 structure and x402 resource list.

- [ ] **Step 4: Final commit if any fixes were needed**

```bash
git add -A && git commit -m "fix: address issues found during final verification"
```
