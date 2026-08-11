# x402 + MPP Dual-Protocol Payment Support (KEEP-176)

## Overview

Add MPP (Machine Payment Protocol) alongside existing x402 for workflow call payments, and expose discovery endpoints so x402scan.com and mppscan.com can crawl our paid workflows. x402 settles on Base mainnet; MPP settles on Tempo mainnet.

## Decisions

- **Tempo for MPP, Base for x402**: KeeperHub has full Tempo support (chains, wallets, RPC, explorer).
- **HTTP only**: MCP transport payments deferred (KEEP-247).
- **`charge` intent only**: Session billing deferred (KEEP-246).
- **Platform fee deferred for MPP**: Creator receives 100%. Fee ledger tracked in DB for future collection.
- **`payTo` omitted from OpenAPI**: Clients learn recipient from the 402 challenge.

---

## 1. Discovery Endpoints

### GET /openapi.json

Next.js rewrite in `next.config.ts`: `/openapi.json` -> `/api/openapi`. Route handler at `app/api/openapi/route.ts`.

Queries all listed workflows (`isListed: true`). Selects only needed columns (slug, name, description, inputSchema, priceUsdcPerCall, workflowType, category, chain) following the `LISTED_WORKFLOW_COLUMNS` pattern from the catalog route.

Generates an OpenAPI 3.1.0 document:

```
info:
  title: KeeperHub
  version: "1.0.0"
  x-guidance: |
    KeeperHub exposes workflows as REST endpoints. Each workflow has a slug
    and accepts JSON input. Paid workflows require x402 or MPP payment.
    Free workflows can be called directly. Use GET /api/mcp/workflows to
    discover available workflows and their pricing.
x-service-info:
  categories: [web3, automation, blockchain]
  docs:
    homepage: https://docs.keeperhub.com
servers:
  - url: <derived from NEXT_PUBLIC_APP_URL or request host>
```

One path entry per listed workflow. Concrete slugs, not parametric paths:

**Read workflows (free)**: Request schema from `inputSchema`, 200 response with `{ executionId, status }`.

**Read workflows (paid, `priceUsdcPerCall > 0`)**:
```
x-payment-info:
  price:
    mode: fixed
    amount: "<priceUsdcPerCall>"
    currency: USDC
  protocols:
    - x402:
        network: "eip155:8453"
    - mpp:
        method: tempo
        intent: charge
        currency: USDC
responses:
  "200": ...
  "402":
    description: Payment Required
```

**Write workflows**: Included in the doc with `x-workflow-type: "write"`. Different response schema (`{ type, to, data, value }`). Never include `x-payment-info` or 402 response, even if `priceUsdcPerCall` is set -- the call route does not enforce payment for write workflows.

Caching: `Cache-Control: public, max-age=300, stale-while-revalidate=600`. Rate limited at 60/min per IP (matches catalog).

### GET /.well-known/x402

Route at `app/.well-known/x402/route.ts`. Fallback discovery for scanners that don't support OpenAPI.

Returns paid read workflows only (concrete slugs):
```json
{
  "version": 1,
  "resources": [
    "POST /api/mcp/workflows/gas-oracle/call",
    "POST /api/mcp/workflows/vault-analysis/call"
  ]
}
```

Same cache strategy. No `/.well-known/mpp` needed -- mppscan.com discovers via `/openapi.json` only.

---

## 2. Schema Changes

### workflow_payments table

Add two columns:

```sql
ALTER TABLE workflow_payments
  ADD COLUMN protocol varchar(10) NOT NULL DEFAULT 'x402',
  ADD COLUMN chain text NOT NULL DEFAULT 'base';
```

Drizzle schema additions in `lib/db/schema-payments.ts`:
```
protocol: varchar('protocol', { length: 10 }).notNull().default('x402')
chain: text('chain').notNull().default('base')
```

- `protocol`: `'x402'` | `'mpp'`
- `chain`: `'base'` | `'tempo'`
- Defaults ensure backward compatibility with existing rows and the x402 path.

### Idempotency key format

Both protocols use SHA-256 hashing of the raw payment header value:
- x402: `sha256(PAYMENT-SIGNATURE header)`
- MPP: `sha256(Authorization header value, after "Payment " prefix)`

No prefix needed -- the `protocol` column distinguishes records, and collisions between SHA-256 hashes of different header sources are astronomically unlikely. Existing x402 records are unaffected (hash format unchanged).

### Environment variables

New in `.env.example`:
```
MPP_SECRET_KEY=          # HMAC secret for MPP challenge verification (required for MPP)
```

---

## 3. Payment Router

New file: `lib/payments/router.ts`

### Protocol detection

```typescript
function detectProtocol(request: Request): 'x402' | 'mpp' | null {
  if (request.headers.get('authorization')?.startsWith('Payment ')) return 'mpp'
  if (request.headers.get('PAYMENT-SIGNATURE')) return 'x402'
  return null
}
```

If both headers are present, return 400 (invalid request, not silent precedence).

### Entry point

```typescript
type PaymentMeta = {
  protocol: 'x402' | 'mpp'
  chain: 'base' | 'tempo'
  payerAddress: string | null
}

async function gatePayment(
  request: Request,
  workflow: CallRouteWorkflow,
  creatorWalletAddress: string,
  createHandler: (meta: PaymentMeta) => (req: NextRequest) => Promise<NextResponse>,
): Promise<NextResponse>
```

The call route passes a handler factory instead of a pre-built handler. This lets the router detect the protocol first, then pass `PaymentMeta` into the factory so the handler can record the correct `protocol` and `chain` on the payment row. The factory is only called after payment verification succeeds.

### Protocol paths

**When `x402`**:
- Build x402 payment config via existing `buildPaymentConfig(workflow, creatorWalletAddress)`.
- Call `withX402(innerHandler, paymentConfig, server)` -- existing flow.
- Timeout reconciliation applies (polls Base USDC `authorizationState`).
- Idempotency check uses `x402:<hashPaymentSignature(PAYMENT-SIGNATURE)>`.

**When `mpp`**:
- Create MPP charge via `mppx.charge({ amount: workflow.priceUsdcPerCall, recipient: creatorWalletAddress })`.
- Call `intent(options)(request)` -- returns `{ status: 402, challenge }` or `{ withReceipt }`.
- If 402: return challenge response (shouldn't happen since we detected the `Authorization: Payment` header).
- If success: call `innerHandler`, then `result.withReceipt(response)` to attach `Payment-Receipt` header.
- No timeout reconciliation (local HMAC verification, no facilitator).
- Idempotency check uses `mpp:<sha256-of-Authorization-header-value>`.
- Payer address extracted from `credential.source` DID string (`did:pkh:eip155:chainId:0xAddress`). Optional -- null if not provided.

**When `null` (no payment header)**:
- Build dual 402 response manually:
  - x402 challenge: serialize `buildPaymentConfig()` output (base64 JSON into x402 headers).
  - MPP challenge: use `Challenge.from()` + `Challenge.serialize()` from `mppx` to build `WWW-Authenticate: Payment` header.
- Return single 402 Response with both challenge headers.

### CORS

Update `corsHeaders` in the call route to include `Payment-Receipt` in exposed headers:
```typescript
"Access-Control-Expose-Headers": "Payment-Receipt",
```

`Authorization` is already in `Access-Control-Allow-Headers`.

---

## 4. MPP Server Module

New file: `lib/mpp/server.ts`

```typescript
import { Mppx } from 'mppx/server'
import { tempo } from 'mppx/tempo'

export const mppServer = Mppx.create({
  methods: [tempo.charge({ currency: TEMPO_USDC_ADDRESS })],
  // secretKey reads MPP_SECRET_KEY env var automatically
})
```

`TEMPO_USDC_ADDRESS`: `0x20c000000000000000000000b9537d11c60e8b50` (USDC.e on Tempo mainnet, from `scripts/seed/seed-tokens.ts`).

Recipient is NOT set at create time -- it's passed per-request via `mppServer.charge({ amount, recipient })` since each workflow's org has a different wallet.

Helper functions:

```typescript
function extractMppPayerAddress(request: Request): string | null
```
Parses `Authorization: Payment` header, decodes credential, extracts `source` DID, returns the trailing address portion. Returns null if absent.

```typescript
function hashMppCredential(authHeader: string): string
```
SHA-256 hash of the raw `Authorization` header value, prefixed with `mpp:`.

---

## 5. Call Route Refactor

File: `app/api/mcp/workflows/[slug]/call/route.ts`

### Changes to handlePaidWorkflow

Before (current):
1. Resolve creator wallet
2. Check idempotency (PAYMENT-SIGNATURE hash)
3. Extract payer (from PAYMENT-SIGNATURE)
4. Build x402 config
5. Create innerHandler (prepareExecution -> recordPayment -> startExecution)
6. `withX402(innerHandler, config, server)`
7. Handle timeout reconciliation

After:
1. Resolve creator wallet (unchanged)
2. Call `gatePayment(request, workflow, creatorWalletAddress, createHandler)` where `createHandler` is a factory:
   ```typescript
   (meta: PaymentMeta) => async (req: NextRequest) => {
     const prepared = await prepareExecution(workflow, body)
     await recordPayment({ ..., protocol: meta.protocol, chain: meta.chain, payerAddress: meta.payerAddress })
     startExecutionInBackground(workflow, body, prepared.executionId)
     return NextResponse.json({ executionId, status: "running" })
   }
   ```
3. The router detects the protocol, verifies payment, then calls `createHandler(meta)` to get the inner handler and invokes it.

The router handles: protocol detection, idempotency check, payment verification, timeout reconciliation (x402 only), receipt headers (MPP only), payer address extraction.

### recordPayment changes

The `innerHandler` closure calls `recordPayment()` with two new fields:
- `protocol`: `'x402'` | `'mpp'` (from router)
- `chain`: `'base'` | `'tempo'` (derived from protocol)

### Error handling

If `recordPayment` fails for MPP: same behavior as x402 -- execution row is marked `status: "error"`, error propagates. MPP client should retry with the same credential; idempotency prevents double-charging. The payment was already verified locally (HMAC), so a retry with the same `Authorization: Payment` header will hit the idempotency check and return the existing executionId.

### Write workflows

Unchanged. `workflowType === "write"` continues to bypass payment entirely and return calldata. MPP does not change this.

---

## 6. File Changes Summary

| File | Change |
|------|--------|
| `next.config.ts` | Add `rewrites()` mapping `/openapi.json` -> `/api/openapi` |
| `app/api/openapi/route.ts` | New -- dynamic OpenAPI 3.1.0 generator |
| `app/.well-known/x402/route.ts` | New -- fallback discovery |
| `lib/payments/router.ts` | New -- protocol detection + dispatch |
| `lib/mpp/server.ts` | New -- MPP server instance + helpers |
| `lib/db/schema-payments.ts` | Add `protocol` and `chain` columns |
| `lib/x402/payment-gate.ts` | Update `recordPayment` to accept `protocol` and `chain`; prefix x402 idempotency keys with `x402:` |
| `app/api/mcp/workflows/[slug]/call/route.ts` | Refactor `handlePaidWorkflow` to use `gatePayment()` router |
| `.env.example` | Add `MPP_SECRET_KEY` |
| `package.json` | Add `mppx` dependency |

Migration file generated via `pnpm drizzle-kit generate`.

---

## 7. Post-Deploy

1. Register on x402scan: `x402scan.com/resources/register` -- enter `https://app.keeperhub.com`
2. Register on mppscan: `mppscan.com/register` -- enter `https://app.keeperhub.com`
3. Validate: `npx -y @agentcash/discovery@latest discover "https://app.keeperhub.com"`

AgentCash discovers automatically through those scanners.
