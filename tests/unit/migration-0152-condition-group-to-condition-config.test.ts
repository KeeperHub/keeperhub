import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Drift catch for the Condition rule-group repair. The statement has one job
// it must always do, removing the top-level `group` that carries unrendered
// tokens into the leftover-literal scan, and one it must do only under a
// condition, promoting that group to `conditionConfig`. Promotion outranks the
// `condition` string at runtime, so a node that already has an expression must
// not get one. The assertions are strict on purpose: every guard here was
// added because the shape it excludes either crashes the editor or silently
// changes which expression a workflow evaluates.

const MIGRATION_PATH = join(
  import.meta.dirname,
  "../../drizzle/0152_keep_2305_condition_group_to_condition_config.sql"
);

const READ_SQL = (): string => readFileSync(MIGRATION_PATH, "utf8");

// Strip pg line-comments so the assertions read the statement, not the prose.
const READ_SQL_DDL_ONLY = (): string =>
  READ_SQL()
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n");

describe("migration 0152: Condition group moves to conditionConfig", () => {
  it("touches only Condition nodes", () => {
    const ddl = READ_SQL_DDL_ONLY();
    expect(ddl).toMatch(/node #>> '\{data,config,actionType\}' = 'Condition'/);
    expect(ddl).toMatch(/ELSE node\b/);
  });

  it("guards the group on type, not on key presence", () => {
    const ddl = READ_SQL_DDL_ONLY();
    // A `"group": null` promoted into conditionConfig makes the editor throw:
    // action-config.tsx calls visualConditionToExpression whenever
    // conditionConfig is truthy, and groupToExpression reads group.rules.
    const typed = ddl.match(
      /jsonb_typeof\(\s*(?:probe\.)?node #> '\{data,config,group\}'\s*\) = 'object'/g
    );
    expect(typed).toHaveLength(2);
    expect(ddl).not.toMatch(
      /jsonb_exists\([^)]*node #> '\{data,config\}'[^)]*,\s*'group'\s*\)/
    );
  });

  it("removes the stale key on every node it touches", () => {
    // This is the repair. Every arm of the inner CASE has to drop it, or the
    // rules array survives into the scan and the run still aborts.
    const ddl = READ_SQL_DDL_ONLY();
    const arms = ddl.match(/node #- '\{data,config,group\}'/g);
    expect(arms).toHaveLength(4);
  });

  it("does not promote over a node that already has an expression", () => {
    // resolveConditionExpression prefers conditionConfig.group and falls
    // through to config.condition only when it is absent, so promoting on a
    // node whose user switched to expression mode would silently evaluate the
    // seeded condition instead of theirs.
    const ddl = READ_SQL_DDL_ONLY();
    expect(ddl).toMatch(
      /jsonb_typeof\(node #> '\{data,config,condition\}'\) = 'string'\s*\n?\s*AND node #>> '\{data,config,condition\}' <> ''\s*\n?\s*THEN node #- '\{data,config,group\}'/
    );
  });

  it("replaces a conditionConfig that is not an object rather than merging", () => {
    // `||` concatenates when either side is not an object, so a JSON null or
    // an array would become [null, {"group": ...}], which the resolver reads
    // .group off as undefined and sanitize-nodes declines to repair.
    const ddl = READ_SQL_DDL_ONLY();
    expect(ddl).toMatch(
      /jsonb_typeof\(node #> '\{data,config,conditionConfig\}'\) = 'object'/
    );
    expect(ddl).toMatch(
      /ELSE jsonb_set\(\s*\n?\s*node #- '\{data,config,group\}',\s*\n?\s*'\{data,config,conditionConfig\}',\s*\n?\s*jsonb_build_object\('group', node #> '\{data,config,group\}'\)/
    );
  });

  it("lets an existing conditionConfig group win", () => {
    const ddl = READ_SQL_DDL_ONLY();
    expect(ddl).toMatch(
      /jsonb_exists\(node #> '\{data,config,conditionConfig\}', 'group'\)\s*\n?\s*THEN node #- '\{data,config,group\}'/
    );
  });

  it("keeps node order", () => {
    expect(READ_SQL_DDL_ONLY()).toMatch(/jsonb_agg\([\s\S]*ORDER BY ord/);
    expect(READ_SQL_DDL_ONLY()).toMatch(/WITH ORDINALITY AS elem\(node, ord\)/);
  });

  it("selects only rows that still carry a top-level group", () => {
    // What makes it idempotent: after a run no node matches, so a second run
    // reports UPDATE 0.
    const ddl = READ_SQL_DDL_ONLY();
    expect(ddl).toMatch(/AND EXISTS \(\s*\n?\s*SELECT 1/);
    expect(ddl).toMatch(/jsonb_typeof\(src\.nodes\) = 'array'/);
  });

  it("does not move updated_at", () => {
    const ddl = READ_SQL_DDL_ONLY();
    expect(ddl).toMatch(/SET nodes = fixed\.nodes/);
    expect(ddl).not.toMatch(/updated_at\s*=/);
  });

  it("has no DDL and no down migration", () => {
    const ddl = READ_SQL_DDL_ONLY();
    expect(ddl).not.toMatch(/\b(ALTER|CREATE|DROP)\s+(TABLE|INDEX|TYPE)\b/i);
    expect(ddl.match(/UPDATE workflows/g)).toHaveLength(1);
  });
});
