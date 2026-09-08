/**
 * Output oracle for protocol-coverage tests.
 *
 * The runner's base assertion is execution-level (`status === "success"`),
 * which proves liveness but not correctness: a read returning a degenerate
 * value still passes. When a protocol's testData declares `expectations`
 * for an action, the runner fetches that action node's recorded output from
 * `workflow_execution_logs` and checks each expectation against it.
 *
 * `checkOutputExpectation` is pure and exported for unit coverage in
 * tests/unit/protocol-oracle.test.ts.
 */

import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { getDatabaseUrl } from "@/lib/db/connection-utils";
import { workflowExecutionLogs } from "@/lib/db/schema";
import type { OutputExpectation } from "@/lib/test-data/types";

/** Fetch a node's recorded output for one execution. `output_raw` is the
 *  executor's unredacted source of truth; fall back to `output` for rows
 *  written before output_raw existed. Throws when no log row exists --
 *  a successful execution without a step log is itself a defect. */
export async function fetchNodeOutput(
  executionId: string,
  nodeId: string
): Promise<unknown> {
  const client = postgres(getDatabaseUrl(), { max: 1 });
  try {
    const db = drizzle(client);
    const [row] = await db
      .select({
        output: workflowExecutionLogs.output,
        outputRaw: workflowExecutionLogs.outputRaw,
      })
      .from(workflowExecutionLogs)
      .where(
        and(
          eq(workflowExecutionLogs.executionId, executionId),
          eq(workflowExecutionLogs.nodeId, nodeId)
        )
      )
      .limit(1);
    if (!row) {
      throw new Error(
        `no workflow_execution_logs row for execution ${executionId} node ${nodeId}`
      );
    }
    return row.outputRaw ?? row.output;
  } finally {
    await client.end();
  }
}

/** Walk a dot-path into a value. Returns undefined on any miss. */
function getPath(value: unknown, path: string): unknown {
  if (path === "") {
    return value;
  }
  let current = value;
  for (const key of path.split(".")) {
    if (current === null || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/** True when the value is a zero numeric: 0, 0n, "0", "0.0", "0x0". Decoded
 *  ABI values arrive as BigInt-serialized decimal strings. */
function isZeroNumeric(value: unknown): boolean {
  if (typeof value === "number") {
    return value === 0;
  }
  if (typeof value === "bigint") {
    return value === BigInt(0);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") {
      return false;
    }
    const asNumber = Number(trimmed);
    return Number.isNaN(asNumber) ? false : asNumber === 0;
  }
  return false;
}

function isEmpty(value: unknown): boolean {
  if (Array.isArray(value) || typeof value === "string") {
    return value.length === 0;
  }
  if (value !== null && typeof value === "object") {
    return Object.keys(value).length === 0;
  }
  return false;
}

/**
 * Check one expectation against a step output. The expectation's `field`
 * is resolved against the output's `result` (matching what workflow
 * templates see as the node's structured return). Returns null on pass,
 * or a human-readable failure message.
 */
export function checkOutputExpectation(
  output: unknown,
  expectation: OutputExpectation
): string | null {
  const field = expectation.field ?? "";
  const result = getPath(output, "result");
  const value = getPath(result, field);
  const label = field === "" ? "result" : `result.${field}`;

  if (value === undefined || value === null) {
    return `${label} is missing from step output (got ${JSON.stringify(result)})`;
  }
  if (expectation.nonZero && isZeroNumeric(value)) {
    return `${label} expected nonZero, got ${JSON.stringify(value)}`;
  }
  if (expectation.notEmpty && isEmpty(value)) {
    return `${label} expected notEmpty, got ${JSON.stringify(value)}`;
  }
  if (
    expectation.equals !== undefined &&
    String(value) !== expectation.equals
  ) {
    return `${label} expected "${expectation.equals}", got ${JSON.stringify(value)}`;
  }
  return null;
}
