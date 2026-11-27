import { NextResponse } from "next/server";
import { z } from "zod";
import { authenticateInternalService } from "@/lib/internal-service-auth";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import type { RpcUsageBucket } from "@/lib/rpc/engine/telemetry/usage";
import { RpcOrigin, RpcTransport } from "@/lib/rpc/engine/types";
import {
  bucketsForKnownOrganizations,
  storeUsageReport,
} from "@/lib/rpc/engine/usage-store";

const MAX_BUCKETS = 1000;
const HOUR_MS = 3_600_000;
/** The largest value the usage table's integer counters hold. */
const INT4_MAX = 2_147_483_647;

const count = z.number().int().nonnegative().max(INT4_MAX).optional();
const latencySum = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER)
  .optional();

const bucketSchema = z.object({
  organizationId: z.string().min(1),
  configId: z.string().min(1).nullable(),
  origin: z.enum(Object.values(RpcOrigin)),
  chainId: z.number().int().positive(),
  transport: z.enum(Object.values(RpcTransport)),
  hour: z.iso
    .datetime()
    .refine((value) => new Date(value).getTime() % HOUR_MS === 0, {
      message: "hour must be the start of an hour",
    }),
  counters: z.object({
    requests: count,
    errors: count,
    timeouts: count,
    rateLimited: count,
    failovers: count,
    latencyMsSum: latencySum,
    latencyMsMax: count,
    wsConnects: count,
    wsReconnects: count,
    eventsReceived: count,
  }),
});

const bodySchema = z.object({
  /** Set by services that resend a report unchanged until it is answered. */
  reportId: z.string().min(1).max(128).optional(),
  buckets: z.array(bucketSchema).max(MAX_BUCKETS),
});

function toBucket(raw: z.infer<typeof bucketSchema>): RpcUsageBucket {
  const { counters } = raw;
  return {
    organizationId: raw.organizationId,
    configId: raw.configId,
    origin: raw.origin,
    chainId: raw.chainId,
    transport: raw.transport,
    hour: new Date(raw.hour),
    counters: {
      requests: counters.requests ?? 0,
      errors: counters.errors ?? 0,
      timeouts: counters.timeouts ?? 0,
      rateLimited: counters.rateLimited ?? 0,
      failovers: counters.failovers ?? 0,
      latencyMsSum: counters.latencyMsSum ?? 0,
      latencyMsMax: counters.latencyMsMax ?? 0,
      wsConnects: counters.wsConnects ?? 0,
      wsReconnects: counters.wsReconnects ?? 0,
      eventsReceived: counters.eventsReceived ?? 0,
    },
  };
}

/**
 * Organization RPC usage counted by the trigger services, which hold the
 * sockets for organization routes but cannot write to the database.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const rawBody = await request.text();
  const auth = await authenticateInternalService(request, rawBody);
  if (!auth.authenticated) {
    return NextResponse.json(
      { error: auth.error ?? "Unauthorized" },
      { status: auth.status }
    );
  }

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid usage report" },
      { status: 400 }
    );
  }

  try {
    const buckets = await bucketsForKnownOrganizations(
      parsed.data.buckets.map(toBucket)
    );
    // Written here rather than through this process's own accumulator, so a
    // failed write leaves nothing behind to be counted again when the service
    // resends the report.
    const stored = await storeUsageReport(parsed.data.reportId, buckets);
    return NextResponse.json({ accepted: stored ? buckets.length : 0 });
  } catch (error) {
    logSystemError(
      ErrorCategory.DATABASE,
      "[RPC Usage] Failed to accept a usage report",
      error,
      { endpoint: "/api/internal/rpc-usage" }
    );
    return NextResponse.json(
      { error: "Failed to store usage" },
      { status: 500 }
    );
  }
}
