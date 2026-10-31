/**
 * Every write of direct_executions.status must go through
 * setDirectExecutionStatus: it is what keeps a final status final and records
 * the outbound webhook event. This scans app/ and lib/ for writes to the table
 * and fails on any that could set a status another way, so a new writer cannot
 * be added silently.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..");
const SCANNED_DIRS = ["app", "lib"];
const WRITER = "lib/outbound-webhooks/direct-execution-events.ts";

// UPDATEs of the table outside the writer. Each one must leave status alone;
// a new one fails this test until it either goes through the writer or is
// listed here with the reason it does not touch status.
const NON_STATUS_UPDATES: Record<string, number> = {
  // setRetryCount: the retry counter only.
  "app/api/execute/_lib/execution-service.ts": 1,
  // The reconciler refreshing receipts on a row it leaves unconfirmed.
  "lib/execute/reconcile-executions.ts": 1,
};

const DRIZZLE_UPDATE = /\.update\(\s*directExecutions\s*\)/g;
const DRIZZLE_INSERT = /\.insert\(\s*directExecutions\s*\)/g;
const SQL_UPDATE = /\bupdate\s+"?direct_executions\b/i;

function sourceFiles(): { path: string; text: string }[] {
  const files: { path: string; text: string }[] = [];
  for (const dir of SCANNED_DIRS) {
    const entries = readdirSync(join(ROOT, dir), { recursive: true });
    for (const entry of entries) {
      const relativePath = `${dir}/${String(entry)}`;
      if (/\.tsx?$/.test(relativePath) && !relativePath.endsWith(".d.ts")) {
        files.push({
          path: relativePath,
          text: readFileSync(join(ROOT, relativePath), "utf8"),
        });
      }
    }
  }
  return files;
}

// The argument list of the first call to `method` after `from`, parentheses
// balanced, so a multi-line object literal is captured whole.
function callArguments(text: string, from: number, method: string): string {
  const start = text.indexOf(`${method}(`, from) + method.length;
  let depth = 0;
  for (let index = start; index < text.length; index++) {
    if (text[index] === "(") {
      depth += 1;
    } else if (text[index] === ")") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start + 1, index);
      }
    }
  }
  throw new Error(`Unbalanced ${method}( call`);
}

const files = sourceFiles();

describe("direct_executions status writers", () => {
  it("finds the writer, so the scan is looking in the right place", () => {
    const writer = files.find((file) => file.path === WRITER);
    expect(writer?.text.match(DRIZZLE_UPDATE)).toHaveLength(1);
  });

  it("updates the table only through the writer, outside the listed non-status updates", () => {
    const updates: Record<string, number> = {};
    for (const file of files) {
      const count = file.text.match(DRIZZLE_UPDATE)?.length ?? 0;
      if (count > 0 && file.path !== WRITER) {
        updates[file.path] = count;
      }
    }

    expect(updates).toEqual(NON_STATUS_UPDATES);
  });

  it("leaves status alone in every update outside the writer", () => {
    for (const path of Object.keys(NON_STATUS_UPDATES)) {
      const text = files.find((file) => file.path === path)?.text ?? "";
      for (const match of text.matchAll(DRIZZLE_UPDATE)) {
        const patch = callArguments(text, match.index, ".set");
        expect(patch, `${path}: ${patch}`).not.toMatch(/\bstatus\b|\.\.\./);
      }
    }
  });

  it("only ever inserts a row as pending", () => {
    for (const file of files) {
      for (const match of file.text.matchAll(DRIZZLE_INSERT)) {
        const values = callArguments(file.text, match.index, ".values");
        expect(values, file.path).toMatch(
          /\bstatus:\s*DirectExecutionStatus\.PENDING\b/
        );
      }
    }
  });

  it("has no raw SQL that updates the table", () => {
    const offenders = files
      .filter((file) => SQL_UPDATE.test(file.text))
      .map((file) => file.path);

    expect(offenders).toEqual([]);
  });
});
