import { withX402 } from "@x402/next";
import { Challenge, Credential, Expires } from "mppx";
import { type NextRequest, NextResponse } from "next/server";
import {
  extractMppPayerAddress,
  hashMppCredential,
} from "@/lib/payments/mpp/server";
import {
  type PaymentProtocol,
  railForProtocol,
  toAssetUnits,
} from "@/lib/payments/rails";
import {
  buildPaymentConfig,
  extractPayerAddress,
  findExistingPayment,
  hashPaymentSignature,
} from "@/lib/payments/x402/payment-gate";
import {
  isTimeoutError,
  pollForPaymentConfirmation,
} from "@/lib/payments/x402/reconcile";
import { server } from "@/lib/payments/x402/server";
import type { CallRouteWorkflow } from "@/lib/payments/x402/types";

const X402_RAIL = railForProtocol("x402");
const MPP_RAIL = railForProtocol("mpp");
const PAYMENT_MAX_TIMEOUT_SECONDS = 300;
const RE_PROTOCOL = /^https?:\/\//;
const RE_TRAILING_SLASH = /\/$/;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, PAYMENT-SIGNATURE",
  "Access-Control-Expose-Headers":
    "Payment-Receipt, PAYMENT-REQUIRED, X-PAYMENT-REQUIREMENTS, WWW-Authenticate",
} as const;

type Dual402Params = {
  price: string;
  creatorWalletAddress: string;
  workflowName: string;
  resourceUrl: string;
  inputSchema?: Record<string, unknown> | null;
  category?: string | null;
  tagName?: string | null;
  workflowType?: string | null;
};

type PaymentRequiredV2 = {
  x402Version: 2;
  error: string;
  resource: { url: string; description: string; mimeType: string };
  accepts: Array<{
    scheme: string;
    network: string;
    asset: string;
    amount: string;
    payTo: string;
    maxTimeoutSeconds: number;
    extra: Record<string, unknown>;
  }>;
  extensions?: Record<string, unknown>;
};

// Agentcash discovery's `extractSchemas2` drills the PaymentRequired body
// at `extensions.bazaar.schema.properties.input.properties.body` for the
// input JSON schema and at `.output.properties.example` for an output
// sample. Emitting both lets x402scan / mppscan surface full request and
// response metadata for the resource.
const WORKFLOW_OUTPUT_EXAMPLE = {
  executionId: "exec_abc123",
  status: "running",
} as const;

// A paid write listing returns unsigned calldata for the caller to submit --
// it starts no execution, so advertising the executionId shape above would
// tell Bazaar / x402scan / agentcash to expect a poll target that never comes.
const CALLDATA_OUTPUT_EXAMPLE = {
  type: "calldata",
  to: "0x0000000000000000000000000000000000000000",
  data: "0xa9059cbb",
  value: "0",
} as const;

/**
 * Builds the spec-compliant x402 v2 PaymentRequired payload (matches the
 * `PaymentRequired` type from `@x402/core/types`). Discovery scanners like
 * x402scan and the `@agentcash/discovery` prober parse this exact shape.
 */
function buildPaymentRequired(params: Dual402Params): PaymentRequiredV2 {
  const {
    price,
    creatorWalletAddress,
    workflowName,
    resourceUrl,
    inputSchema,
    category,
    tagName,
    workflowType,
  } = params;
  const amountSmallestUnit = String(toAssetUnits(X402_RAIL, price));
  const payload: PaymentRequiredV2 = {
    x402Version: 2,
    error: "Payment required",
    resource: {
      url: resourceUrl,
      description: `Pay to run workflow: ${workflowName}`,
      mimeType: "application/json",
    },
    accepts: [
      {
        scheme: "exact",
        network: X402_RAIL.network,
        asset: X402_RAIL.asset,
        amount: amountSmallestUnit,
        payTo: creatorWalletAddress,
        maxTimeoutSeconds: PAYMENT_MAX_TIMEOUT_SECONDS,
        // Same object the gate advertises and the signer signs over - they
        // cannot drift apart the way they did in KEEP-364.
        extra: { ...X402_RAIL.domain },
      },
    ],
  };

  // CDP Bazaar discovery: `discoverable: true` opts the resource into the
  // marketplace index. The schema subtree feeds agentcash / x402scan probers.
  const bazaar: Record<string, unknown> = { discoverable: true };
  if (category) {
    bazaar.category = category;
  }
  if (tagName) {
    bazaar.tags = [tagName];
  }
  // Always emit `bazaar.schema` for paid resources (every 402 is paid by
  // construction). Workflows whose owners haven't backfilled `inputSchema`
  // in the DB get an open-object placeholder rather than missing the
  // schema entirely -- @agentcash/discovery's getWarningsFor402Body emits
  // SCHEMA_INPUT_MISSING / SCHEMA_OUTPUT_MISSING at the
  // `extensions.bazaar.schema.properties.{input,output}` paths when this
  // subtree is absent. Open-object is permissive but lets the resource
  // index correctly; owners should still backfill real schemas for
  // ranking + agent UX.
  bazaar.schema = {
    properties: {
      input: {
        properties: {
          body: inputSchema ?? { type: "object" },
        },
      },
      output: {
        properties: {
          example:
            workflowType === "write"
              ? CALLDATA_OUTPUT_EXAMPLE
              : WORKFLOW_OUTPUT_EXAMPLE,
        },
      },
    },
  };
  payload.extensions = { bazaar };

  return payload;
}

export function buildDual402Response(params: Dual402Params): Response {
  const { price, creatorWalletAddress } = params;
  const paymentRequired = buildPaymentRequired(params);
  const encoded = Buffer.from(JSON.stringify(paymentRequired)).toString(
    "base64"
  );

  const headers = new Headers(CORS_HEADERS);
  // Canonical header name from `@x402/core/http` -- this is what
  // `@agentcash/discovery` and x402scan probe for.
  headers.set("PAYMENT-REQUIRED", encoded);
  // Legacy alias kept for in-flight clients that read the old name. Same
  // payload, safe to remove once nothing depends on it.
  headers.set("X-PAYMENT-REQUIREMENTS", encoded);
  headers.set("Cache-Control", "no-store");

  const mppSecretKey = process.env.MPP_SECRET_KEY;
  if (mppSecretKey) {
    const realm = (process.env.NEXT_PUBLIC_APP_URL ?? "app.keeperhub.com")
      .replace(RE_PROTOCOL, "")
      .replace(RE_TRAILING_SLASH, "");
    const amountSmallestUnit = String(toAssetUnits(MPP_RAIL, price));
    const challenge = Challenge.from({
      secretKey: mppSecretKey,
      realm,
      method: "tempo",
      intent: "charge",
      expires: Expires.minutes(5),
      request: {
        amount: amountSmallestUnit,
        currency: MPP_RAIL.asset,
        recipient: creatorWalletAddress,
        methodDetails: {
          chainId: MPP_RAIL.chainId,
        },
      },
    });
    headers.set("WWW-Authenticate", Challenge.serialize(challenge));
  }

  return new Response(JSON.stringify(paymentRequired), {
    status: 402,
    headers,
  });
}

export type PaymentMeta = {
  protocol: PaymentProtocol;
  chain: "base" | "tempo";
  payerAddress: string | null;
  // Hash of the payment credential, computed once here where the credential is
  // already in hand. Handlers must use this rather than re-deriving it from the
  // request: a re-derivation that falls back to some other value on a missing
  // header silently defeats the DB-level idempotency guarantee on
  // workflow_payments.payment_hash.
  paymentHash: string | null;
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

type HandlerFactory = (
  meta: PaymentMeta
) => (req: NextRequest) => Promise<NextResponse>;

async function checkIdempotency(
  paymentHash: string
): Promise<NextResponse | null> {
  const existing = await findExistingPayment(paymentHash);
  if (!existing) {
    return null;
  }
  if (existing.kind === "calldata") {
    if (existing.deliverable) {
      // Serve the exact artifact this credential already bought. Never
      // regenerate it from the replayed body: the payment hash covers the
      // credential alone and is not bound to the body, so regenerating would
      // let one signature buy calldata for any recipient or amount.
      return NextResponse.json(existing.deliverable, { headers: CORS_HEADERS });
    }
    return NextResponse.json(
      { error: "Payment already used", code: "PAYMENT_ALREADY_SETTLED" },
      { status: 409, headers: CORS_HEADERS }
    );
  }
  return NextResponse.json(
    { executionId: existing.executionId },
    { headers: CORS_HEADERS }
  );
}

async function handleX402(
  request: Request,
  workflow: CallRouteWorkflow,
  creatorWalletAddress: string,
  createHandler: HandlerFactory
): Promise<NextResponse> {
  const paymentSig = request.headers.get("PAYMENT-SIGNATURE");
  const paymentHash = paymentSig ? hashPaymentSignature(paymentSig) : null;
  if (paymentHash) {
    const idempotent = await checkIdempotency(paymentHash);
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
    paymentHash,
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
          if (paymentHash) {
            const idempotent = await checkIdempotency(paymentHash);
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
  const paymentHash = authHeader
    ? hashMppCredential(authHeader.slice("Payment ".length))
    : null;
  if (paymentHash) {
    const idempotent = await checkIdempotency(paymentHash);
    if (idempotent) {
      return idempotent;
    }
  }

  // Dynamic import to avoid loading mppx when not needed
  const { getMppServer } = await import("@/lib/payments/mpp/server");
  type ChargeResult =
    | { status: 402; challenge: Response; withReceipt?: never }
    | {
        status: 200;
        challenge?: never;
        withReceipt: (response: Response) => Response;
      };
  const mppServer = (await getMppServer()) as {
    charge: (opts: {
      amount: string;
      recipient: string;
    }) => (request: Request) => Promise<ChargeResult>;
  };

  const price = workflow.priceUsdcPerCall ?? "0";
  const chargeIntent = mppServer.charge({
    amount: price,
    recipient: creatorWalletAddress,
  });

  const result = await chargeIntent(request);

  if (result.status === 402) {
    const challenge = result.challenge as unknown as NextResponse;
    for (const [key, value] of Object.entries(CORS_HEADERS)) {
      challenge.headers.set(key, value);
    }
    return challenge;
  }

  let credentialSource: string | null = null;
  try {
    const credential = Credential.fromRequest(request);
    credentialSource = credential.source ?? null;
  } catch {
    // credential source is optional -- wallets may omit it
  }
  const payerAddress = extractMppPayerAddress(credentialSource);

  const innerHandler = createHandler({
    protocol: "mpp",
    chain: "tempo",
    payerAddress,
    paymentHash,
  });

  const response = await innerHandler(request as NextRequest);
  return result.withReceipt(response) as unknown as NextResponse;
}

export function gatePayment(
  request: Request,
  workflow: CallRouteWorkflow,
  creatorWalletAddress: string,
  createHandler: HandlerFactory
): Promise<NextResponse> {
  const protocol = detectProtocol(request);

  if (protocol === "error") {
    return Promise.resolve(
      NextResponse.json(
        {
          error:
            "Cannot send both PAYMENT-SIGNATURE and Authorization: Payment headers",
        },
        { status: 400, headers: CORS_HEADERS }
      )
    );
  }

  if (protocol === "x402") {
    return handleX402(request, workflow, creatorWalletAddress, createHandler);
  }

  if (protocol === "mpp") {
    return handleMpp(request, workflow, creatorWalletAddress, createHandler);
  }

  // No payment header -- return dual 402 challenge.
  // Resource URL must use the public hostname (not request.url, which can be
  // the internal pod bind `0.0.0.0:3000` inside K8s) or the CDP Bazaar
  // crawler and any other caller will fail to resolve the endpoint.
  const publicHost =
    process.env.NEXT_PUBLIC_APP_URL ?? "https://app.keeperhub.com";
  const resourceUrl = workflow.listedSlug
    ? `${publicHost}/api/mcp/workflows/${workflow.listedSlug}/call`
    : request.url;
  return Promise.resolve(
    buildDual402Response({
      price: workflow.priceUsdcPerCall ?? "0",
      creatorWalletAddress,
      workflowName: workflow.name,
      resourceUrl,
      inputSchema: workflow.inputSchema,
      category: workflow.category,
      tagName: workflow.tagName,
      workflowType: workflow.workflowType,
    }) as NextResponse
  );
}
