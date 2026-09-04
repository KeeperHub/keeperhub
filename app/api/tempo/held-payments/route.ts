/**
 * GET /api/tempo/held-payments -- list the current org's held Tempo payments.
 * POST /api/tempo/held-payments -- sign and hold a Tempo transfer (Sign and Hold).
 * Owner-only (releasing held payments spends org funds). Server-paginated via
 * the shared Page interface; supports `?status=` and `?q=` (search over memo,
 * addresses, token, tx hash, id).
 *
 * Scheduled holds (`broadcastMode: "schedule"`) are designed for unattended
 * broadcast via the internal scheduler; immediate release via MCP still requires
 * an interactive session with step-up MFA on the broadcast route.
 */
import { NextResponse } from "next/server";
import { tempoHeldPaymentStatus } from "@/lib/db/schema";
import {
  beginIdempotentFromRequest,
  idempotencyEarlyResponse,
  recordIdempotentResponse,
} from "@/lib/idempotency";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { SCOPE_MCP_WRITE } from "@/lib/mcp/oauth-scopes";
import { resolveCreatorContext } from "@/lib/middleware/auth-helpers";
import { requireScope } from "@/lib/middleware/require-scope";
import { buildPage, parsePageRequest } from "@/lib/pagination";
import {
  buildActor,
  buildAuditMetadata,
  recordAuditEvent,
} from "@/lib/security/audit-log";
import { getOrgRole } from "@/lib/security/org-role";
import {
  countHeldPayments,
  type HeldPaymentListFilter,
  listHeldPayments,
  toHeldPaymentView,
} from "@/lib/tempo/held-payments";
import { executeHoldPayment } from "@/plugins/tempo/steps/hold-payment-core";

export const dynamic = "force-dynamic";

const VALID_STATUSES = new Set<string>(tempoHeldPaymentStatus.enumValues);

type CreateHeldPaymentBody = {
  network?: unknown;
  tokenConfig?: unknown;
  amount?: unknown;
  recipientAddress?: unknown;
  memo?: string;
  broadcastMode?: "manual" | "schedule";
  broadcastAt?: string;
  validBefore?: string;
};

type ParsedCreateHeldPaymentBody = {
  network: string;
  tokenConfig: string | Record<string, unknown>;
  amount: string;
  recipientAddress: string;
  memo?: string;
  broadcastMode?: "manual" | "schedule";
  broadcastAt?: string;
  validBefore?: string;
};

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function isValidTokenConfig(
  value: unknown
): value is string | Record<string, unknown> {
  if (isNonEmptyString(value)) {
    return true;
  }
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseCreateHeldPaymentBody(
  body: CreateHeldPaymentBody
): { ok: true; value: ParsedCreateHeldPaymentBody } | { ok: false } {
  if (
    !(
      isNonEmptyString(body.network) &&
      isValidTokenConfig(body.tokenConfig) &&
      isNonEmptyString(body.amount) &&
      isNonEmptyString(body.recipientAddress)
    )
  ) {
    return { ok: false };
  }

  return {
    ok: true,
    value: {
      network: body.network.trim(),
      tokenConfig: body.tokenConfig,
      amount: body.amount.trim(),
      recipientAddress: body.recipientAddress.trim(),
      memo: body.memo,
      broadcastMode: body.broadcastMode,
      broadcastAt: body.broadcastAt,
      validBefore: body.validBefore,
    },
  };
}

export async function GET(request: Request): Promise<NextResponse> {
  const resolved = await resolveCreatorContext(request);
  if ("error" in resolved) {
    return NextResponse.json(
      { error: resolved.error },
      { status: resolved.status }
    );
  }
  const role = await getOrgRole(resolved.userId, resolved.organizationId);
  if (role !== "owner") {
    return NextResponse.json(
      { error: "Only organization owners can view held payments." },
      { status: 403 }
    );
  }

  try {
    const url = new URL(request.url);
    const statusParam = url.searchParams.get("status");
    const status =
      statusParam && VALID_STATUSES.has(statusParam)
        ? (statusParam as (typeof tempoHeldPaymentStatus.enumValues)[number])
        : undefined;
    const search = url.searchParams.get("q") ?? undefined;
    const filter: HeldPaymentListFilter = { status, search };
    const req = parsePageRequest(url);

    const [rows, total] = await Promise.all([
      listHeldPayments(resolved.organizationId, {
        ...filter,
        limit: req.pageSize,
        offset: req.offset,
      }),
      countHeldPayments(resolved.organizationId, filter),
    ]);

    return NextResponse.json(
      buildPage(rows.map(toHeldPaymentView), total, req, url)
    );
  } catch (error) {
    logSystemError(
      ErrorCategory.DATABASE,
      "[Tempo Held] Failed to list held payments",
      error,
      { endpoint: "/api/tempo/held-payments", operation: "list" }
    );
    return NextResponse.json(
      { error: "Failed to list held payments" },
      { status: 500 }
    );
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  const resolved = await resolveCreatorContext(request);
  if ("error" in resolved) {
    return NextResponse.json(
      { error: resolved.error },
      { status: resolved.status }
    );
  }
  const scopeError = requireScope(resolved.scope, SCOPE_MCP_WRITE, {
    credentialType: resolved.authMethod,
  });
  if (scopeError) {
    return scopeError;
  }
  const role = await getOrgRole(resolved.userId, resolved.organizationId);
  if (role !== "owner") {
    return NextResponse.json(
      { error: "Only organization owners can create held payments." },
      { status: 403 }
    );
  }

  let body: CreateHeldPaymentBody;
  try {
    body = (await request.json()) as CreateHeldPaymentBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = parseCreateHeldPaymentBody(body);
  if (!parsed.ok) {
    return NextResponse.json(
      {
        error:
          "network, tokenConfig, amount, and recipientAddress are required",
      },
      { status: 400 }
    );
  }

  const idem = await beginIdempotentFromRequest({
    request,
    organizationId: resolved.organizationId,
    scope: "tempo-held-payment-create",
    requestBody: parsed.value,
  });
  if (idem) {
    const early = idempotencyEarlyResponse(idem);
    if (early) {
      return NextResponse.json(early.body, { status: early.status });
    }
  }

  const {
    network,
    tokenConfig,
    amount,
    recipientAddress,
    memo,
    broadcastMode,
    broadcastAt,
    validBefore,
  } = parsed.value;

  const result = await executeHoldPayment({
    organizationId: resolved.organizationId,
    userId: resolved.userId,
    network,
    tokenConfig,
    amount,
    recipientAddress,
    memo,
    broadcastMode,
    broadcastAt,
    validBefore,
  });

  if (!result.success) {
    if (result.failureKind === "infrastructure") {
      logSystemError(
        ErrorCategory.TRANSACTION,
        "[Tempo Held] Failed to create held payment",
        new Error(result.error),
        { endpoint: "/api/tempo/held-payments", operation: "create" }
      );
      return recordIdempotentResponse(
        idem,
        NextResponse.json(
          { error: "Failed to create held payment" },
          { status: 500 }
        ),
        "release"
      );
    }
    return recordIdempotentResponse(
      idem,
      NextResponse.json({ error: result.error }, { status: 400 }),
      "release"
    );
  }

  await recordAuditEvent({
    actor: buildActor({
      userId: resolved.userId,
      organizationId: resolved.organizationId,
      authMethod: resolved.authMethod,
      apiKeyId: resolved.apiKeyId,
    }),
    action: "tempo_held_payment.created",
    resourceType: "tempo_held_payment",
    resourceId: result.paymentId,
    metadata: buildAuditMetadata(request),
  });

  return recordIdempotentResponse(
    idem,
    NextResponse.json(result, { status: 201 })
  );
}
