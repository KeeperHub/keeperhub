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
-- deletes the stale top-level `group`, so the workflow still aborts. That is why the
-- builder fix alone does not reach organizations provisioned so far, including the
-- public hub rows, which insert with a fixed id and onConflictDoNothing() and are
-- therefore never refreshed from the fixture.
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
             AND jsonb_exists(node #> '{data,config}', 'group')
        THEN jsonb_set(
               node #- '{data,config,group}',
               '{data,config,conditionConfig}',
               CASE
                 WHEN jsonb_exists(
                        COALESCE(node #> '{data,config,conditionConfig}', '{}'::jsonb),
                        'group'
                      )
                 THEN node #> '{data,config,conditionConfig}'
                 ELSE COALESCE(node #> '{data,config,conditionConfig}', '{}'::jsonb)
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
        AND jsonb_exists(probe.node #> '{data,config}', 'group')
    )
  GROUP BY src.id
) AS fixed
WHERE w.id = fixed.id;
