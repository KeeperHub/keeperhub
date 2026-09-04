-- Issue #2305: move a Condition node's rule group from the unread top-level `group`
-- key to `conditionConfig`, which is the shape the runtime reads.
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
-- Both guards test `jsonb_typeof(... 'group') = 'object'` rather than key presence, so a
-- node carrying `"group": null` or a non-object `group` is left exactly as it is. Writing
-- `{"group": null}` into `conditionConfig` would be worse than the state being repaired:
-- action-config.tsx calls visualConditionToExpression whenever conditionConfig is truthy
-- and groupToExpression dereferences `group.rules`, so the editor would throw on open.
--
-- `conditionConfig` is merged only when it is itself an object. `||` concatenates rather
-- than merges when either side is not an object, so a JSON `null` or an array would have
-- produced `[null, {"group": ...}]`, which resolveConditionExpression reads `.group` off
-- as undefined and sanitize-nodes.ts declines to repair. Anything that is not an object
-- is replaced outright, which is the shape the runtime reads.
--
-- The type test is IS DISTINCT FROM rather than <> because an absent `conditionConfig`
-- makes `#>` return SQL NULL, not JSON null. `<>` would be NULL there, the CASE would
-- fall through to the merge, `NULL || anything` is NULL, and jsonb_set would return NULL
-- for the whole node - replacing the node with JSON null in the array. That is the common
-- case, so it is covered by the first two fixtures in the test.
--
-- Idempotent. A row whose Condition nodes already carry only `conditionConfig` is not
-- matched. Where both keys exist the existing `conditionConfig` wins and only the stale
-- `group` is dropped, so re-running changes nothing.
--
-- `updated_at` is deliberately left alone: this is a repair, not a user edit, and
-- moving it would reorder every affected workflow in the user's list.

UPDATE workflows AS w
SET nodes = fixed.nodes
FROM (
  SELECT
    src.id AS id,
    jsonb_agg(
      CASE
        WHEN node #>> '{data,config,actionType}' = 'Condition'
             AND jsonb_typeof(node #> '{data,config,group}') = 'object'
        THEN jsonb_set(
               node #- '{data,config,group}',
               '{data,config,conditionConfig}',
               CASE
                 WHEN jsonb_typeof(node #> '{data,config,conditionConfig}')
                      IS DISTINCT FROM 'object'
                 THEN jsonb_build_object('group', node #> '{data,config,group}')
                 WHEN jsonb_exists(node #> '{data,config,conditionConfig}', 'group')
                 THEN node #> '{data,config,conditionConfig}'
                 ELSE node #> '{data,config,conditionConfig}'
                      || jsonb_build_object('group', node #> '{data,config,group}')
               END,
               true
             )
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
