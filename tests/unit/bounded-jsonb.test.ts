import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { workflowExecutionLogs, workflowExecutions } from "@/lib/db/schema";
import { boundedJsonb } from "@/lib/workflow/bounded-jsonb";
import {
  MAX_STORED_OUTPUT_BYTES,
  TRUNCATED_PREVIEW_CHARS,
} from "@/lib/workflow/output-limits";

const dialect = new PgDialect();

describe("boundedJsonb", () => {
  it("guards the column with a CASE on its text length", () => {
    const query = dialect.sqlToQuery(boundedJsonb(workflowExecutions.output));

    expect(query.sql).toBe(
      'CASE WHEN octet_length("workflow_executions"."output"::text) > $1 ' +
        "THEN jsonb_build_object('_truncated', true, 'originalSize', " +
        'octet_length("workflow_executions"."output"::text), ' +
        '\'preview\', left("workflow_executions"."output"::text, $2)) ' +
        'ELSE "workflow_executions"."output" END'
    );
    expect(query.params).toEqual([
      MAX_STORED_OUTPUT_BYTES,
      TRUNCATED_PREVIEW_CHARS,
    ]);
  });

  it("defaults to the stored-output limit and accepts a tighter one", () => {
    const tight = dialect.sqlToQuery(
      boundedJsonb(workflowExecutionLogs.outputRaw, 512)
    );
    expect(tight.params[0]).toBe(512);
    expect(tight.sql).toContain('"workflow_execution_logs"."output_raw"');
  });
});
