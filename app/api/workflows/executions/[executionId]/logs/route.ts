import { and, desc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { workflowExecutionLogs } from "@/lib/db/schema";
import { redactAllUrls, redactSecretUrls } from "@/lib/rpc/scrub-rpc-urls";
import { redactSensitiveData } from "@/lib/utils/redact";
import { resolveAuthorizedExecution } from "@/lib/workflow/execution-access";
import { executionLogNotDeleted } from "@/lib/workflow/soft-delete";

type TruncatedMarker = {
  _truncated: true;
  originalSize: number;
  preview: string;
};

function truncateField(value: unknown, maxBytes: number): unknown | TruncatedMarker {
  if (value === null || value === undefined) {
    return value;
  }
  const stringified = JSON.stringify(value);
  if (stringified === undefined) {
    return value;
  }
  const originalSize = Buffer.byteLength(stringified, "utf8");
  if (originalSize <= maxBytes) {
    return value;
  }
  return {
    _truncated: true as const,
    originalSize,
    preview: stringified.slice(0, maxBytes),
  };
}

export async function GET(
  request: Request,
  context: { params: Promise<{ executionId: string }> }
) {
  try {
    const { executionId } = await context.params;

    const { searchParams } = new URL(request.url);
    const includeDataRaw = searchParams.get("includeData");
    const includeData =
      includeDataRaw === null ? undefined : includeDataRaw !== "false";
    const nodeIdsParam = searchParams.getAll("nodeIds").filter((id) => id !== "");
    const nodeIds = nodeIdsParam.length > 0 ? nodeIdsParam : undefined;
    const truncateDataRaw = searchParams.get("truncateData");
    const truncateDataParsed =
      truncateDataRaw === null ? Number.NaN : Number.parseInt(truncateDataRaw, 10);
    const truncateData =
      Number.isFinite(truncateDataParsed) && truncateDataParsed > 0
        ? truncateDataParsed
        : undefined;
    const hasAnyPartialParam =
      includeData !== undefined ||
      nodeIds !== undefined ||
      truncateData !== undefined;

    const resolved = await resolveAuthorizedExecution(request, executionId);
    if (!resolved.ok) {
      return NextResponse.json(
        { error: resolved.error },
        { status: resolved.status }
      );
    }
    const { execution } = resolved;
    // Redact on read so rows persisted before URL redaction existed do not
    // re-display provider RPC URLs. web3 step errors only ever contain
    // provider URLs, so drop every URL there; other steps may legitimately
    // reference user-owned URLs.
    const scrubbedExecution = {
      ...execution,
      error:
        execution.error === null ? null : redactSecretUrls(execution.error),
    };

    const logs = await db.query.workflowExecutionLogs.findMany({
      where: and(
        eq(workflowExecutionLogs.executionId, executionId),
        executionLogNotDeleted()
      ),
      orderBy: [desc(workflowExecutionLogs.timestamp)],
    });

    const redactedLogs = logs.map((log) => ({
      ...log,
      input: redactSensitiveData(log.input),
      output: redactSensitiveData(log.output),
      error:
        log.error === null
          ? null
          : log.nodeType.startsWith("web3/")
            ? redactAllUrls(log.error)
            : redactSecretUrls(log.error),
    }));

    if (!hasAnyPartialParam) {
      return NextResponse.json({
        execution: scrubbedExecution,
        logs: redactedLogs,
      });
    }

    const nodeIdSet = nodeIds ? new Set(nodeIds) : null;
    const transformedLogs = redactedLogs.map((log) => {
      const stripData = includeData === false;
      const stripForNodeFilter =
        !stripData && nodeIdSet !== null && !nodeIdSet.has(log.nodeId);
      if (stripData || stripForNodeFilter) {
        // biome-ignore lint/correctness/noUnusedVariables: destructure-to-omit pattern
        const { input: _input, output: _output, outputRaw: _outputRaw, ...rest } = log;
        return rest;
      }
      if (truncateData !== undefined) {
        return {
          ...log,
          input: truncateField(log.input, truncateData),
          output: truncateField(log.output, truncateData),
          outputRaw: truncateField(log.outputRaw, truncateData),
        };
      }
      return log;
    });

    return NextResponse.json({
      execution: scrubbedExecution,
      logs: transformedLogs,
    });
  } catch (error) {
    logSystemError(ErrorCategory.DATABASE, "Failed to get execution logs", error, {
      endpoint: "/api/workflows/executions/logs",
      operation: "get",
    });
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to get execution logs",
      },
      { status: 500 }
    );
  }
}
