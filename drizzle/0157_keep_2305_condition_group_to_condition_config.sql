-- Issue #2305: remove a Condition node's rule group from the unread top-level `group`
-- key, which is what aborts the run, and promote it to `conditionConfig` only where
-- doing so cannot change which expression the node evaluates.
--
-- lib/workflow/node-builders.ts emitted `data.config.group`. processActionConfig lifts
-- only `condition` and `conditionConfig` out of the config before rendering templates,
-- so `group.rules` kept its unrendered `{{...}}` tokens, and the leftover-literal scan
-- that runs next found them and aborted the run before the Condition node executed.
--
-- The rows cannot be repaired from the editor: opening a seeded Condition node parses
-- the `condition` string into a group and persists it as `conditionConfig`, but never
-- deletes the stale top-level `group`, so the workflow still aborts. Nor can any seeder
-- reach them. lib/auth.ts:871-886 inserts the three fixtures for a new organization
-- without an id and without `seededAt`, so scripts/seed/seed-onboarding-workflows.ts,
-- which selects by the fixture's fixed id and refreshes only a row whose `updatedAt` is
-- within USER_EDIT_EPSILON_MS of its `seededAt`, matches neither by id nor by age. Every
-- organization provisioned so far therefore holds rows only a migration can repair.
--
-- Removing the stale key is the whole repair. resolveConditionExpression has never read
-- the top-level `group`, so deleting it cannot change what runs, and the editor rebuilds
-- `conditionConfig` from the `condition` string the next time the node is opened. What
-- the editor could not do is delete the key, which is the one thing this does.
--
-- Promotion is the part that can change what runs, so it is narrow. resolveConditionExpression
-- (lib/workflow/nodes/condition/resolver.ts:24-31) prefers `conditionConfig.group` and falls
-- through to `config.condition` only when it is absent, and handleModeSwitch("expression")
-- (components/workflow/config/action-config.tsx:350-353) clears `conditionConfig` precisely
-- so the raw string wins. Nothing clears the top-level `group`: sanitize-nodes.ts:168 spreads
-- `...config`, so on a seeded workflow it survives every save. A seeded Condition a user
-- switched to expression mode and edited therefore reaches this statement as
-- `{group: <seeded>, condition: <the user's>}`, and promoting the group would silently
-- start evaluating the seeded condition instead of theirs.
--
-- Shape alone cannot tell that row from an untouched seeded one, which arrives as
-- `{group: <seeded>, condition: <generated from that group>}`. The two differ only in
-- whether `condition` equals visualConditionToExpression(group), which SQL cannot compute
-- without a second copy of the generator. So the group is promoted only where there is no
-- expression to outrank, and dropped everywhere else. Dropping still repairs the abort,
-- which skipping the row would not.
--
-- Both group guards test `jsonb_typeof(... 'group') = 'object'` rather than key presence, so
-- a node carrying `"group": null` or a non-object `group` is left exactly as it is. Writing
-- `{"group": null}` into `conditionConfig` would be worse than the state being repaired:
-- action-config.tsx calls visualConditionToExpression whenever conditionConfig is truthy
-- and groupToExpression dereferences `group.rules`, so the editor would throw on open.
--
-- The expression test is `jsonb_typeof(...) = 'string' AND #>> ... <> ''`. `#>` returns SQL
-- NULL for an absent key, and jsonb_typeof of that is NULL, so an absent `condition` fails
-- the test and the group is promoted rather than dropped.
--
-- Idempotent. A row whose Condition nodes no longer carry a top-level `group` is not
-- matched, so a second run reports UPDATE 0. Covered by
-- tests/unit/migration-0157-condition-group-to-condition-config.test.ts.
--
-- `updated_at` is deliberately left alone: this is a repair, not a user edit, and
-- moving it would reorder every affected workflow in the user's list.
--
-- Under READ COMMITTED the subquery computes `fixed.nodes` from the pre-statement snapshot,
-- so a workflow saved inside the statement's window is re-checked for the join qualifier and
-- then overwritten with the already-computed value, discarding that save. The window is the
-- statement's own runtime, about a second at 50k rows. Whether that matters is the row
-- count, which I cannot read from a fork:
--   SELECT count(*) FROM workflows
--   WHERE nodes @> '[{"data":{"config":{"actionType":"Condition"}}}]';
-- Nothing here enforces that anyone runs it, and --@requires-db-prep does not apply
-- (db-prep-check.yml scopes it to CREATE INDEX CONCURRENTLY), so the number decides:
-- say it and I will batch this by id range, or say it is small and this note can go.

UPDATE workflows AS w
SET nodes = fixed.nodes
FROM (
  SELECT
    src.id AS id,
    jsonb_agg(
      CASE
        WHEN node #>> '{data,config,actionType}' = 'Condition'
             AND jsonb_typeof(node #> '{data,config,group}') = 'object'
        THEN
          CASE
            -- An expression is already what this node evaluates, so the stale group is
            -- not a repair candidate. Removing it is the repair.
            --
            -- btrim, because resolveConditionExpression (condition/resolver.ts)
            -- tests condition.trim(): for a condition of spaces Postgres would
            -- otherwise say an expression is present and take this arm, while
            -- the resolver treats it as absent. The node would lose its rule
            -- group with nothing promoted, and workflows.nodes is the only
            -- copy - the rules would survive solely in workflow_history.
            WHEN jsonb_typeof(node #> '{data,config,condition}') = 'string'
                 AND btrim(node #>> '{data,config,condition}') <> ''
            THEN node #- '{data,config,group}'
            -- No expression to outrank, so the group becomes the condition. An object
            -- conditionConfig is merged into rather than replaced, and one that already
            -- carries a group wins outright.
            WHEN jsonb_typeof(node #> '{data,config,conditionConfig}') = 'object'
            THEN CASE
                   WHEN jsonb_exists(node #> '{data,config,conditionConfig}', 'group')
                   THEN node #- '{data,config,group}'
                   ELSE jsonb_set(
                          node #- '{data,config,group}',
                          '{data,config,conditionConfig}',
                          node #> '{data,config,conditionConfig}'
                          || jsonb_build_object('group', node #> '{data,config,group}'),
                          true
                        )
                 END
            -- Anything that is not an object, including an absent key, a JSON null and
            -- an array, is replaced. `||` would concatenate those rather than merge.
            ELSE jsonb_set(
                   node #- '{data,config,group}',
                   '{data,config,conditionConfig}',
                   jsonb_build_object('group', node #> '{data,config,group}'),
                   true
                 )
          END
        ELSE node
      END
      ORDER BY ord
    ) AS nodes
  FROM workflows AS src,
       LATERAL jsonb_array_elements(src.nodes) WITH ORDINALITY AS elem(node, ord)
  WHERE jsonb_typeof(src.nodes) = 'array'
    AND EXISTS (
      SELECT 1
      FROM jsonb_array_elements(src.nodes) AS probe(node)
      WHERE probe.node #>> '{data,config,actionType}' = 'Condition'
        AND jsonb_typeof(probe.node #> '{data,config,group}') = 'object'
    )
  GROUP BY src.id
) AS fixed
WHERE w.id = fixed.id;
