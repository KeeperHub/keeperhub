-- Rename Aave V3 protocol slug from "aave" to "aave-v3" so it coexists
-- cleanly with the new "aave-v4" slug. Data-only migration: no schema change.
--
-- Slug-bearing fields audited in the schema:
--   * workflows.featured_protocol               (text)
--   * workflows.nodes[].data.config.actionType  (jsonb, "aave/*")
--   * workflows.nodes[].data.config._protocolMeta.protocolSlug
--                                               (stringified JSON inside jsonb)
--   * workflows.nodes[].data._eventProtocolSlug (jsonb, on trigger nodes)
--   * integrations.type                         (text, stores IntegrationType)
--
-- Not touched: workflows.nodes[].data._eventProtocolIconPath. Both "aave"
-- and "aave-v3" resolve to the same icon file (protocols/aave-v3.ts still
-- declares icon: "/protocols/aave.png"), so the icon path is stable across
-- the rename. The 0025 safe-wallet precedent had to update its icon path
-- because the safe icon file itself was being renamed; that's not the case
-- here.
--
-- Historical tables (workflow_executions, workflow_execution_logs,
-- direct_executions) are intentionally NOT touched: they record past runs
-- with their slug-of-the-day, rewriting them would falsify history.
--
-- Strategy: text-level REPLACE on JSONB::text for actionType / protocolSlug
-- (the stringified _protocolMeta can't be reached by jsonb_set because its
-- value is itself a string, not nested jsonb). For _eventProtocolSlug, use
-- jsonb_set via jsonb_agg (the 0025 precedent): a native jsonb key on each
-- node's data object.
--
-- LIKE-escape note: LIKE treats backslash as its own escape character by
-- default. To match a literal backslash-quote sequence in the text form we
-- must double the backslashes in the LIKE pattern (so '\\"' after string
-- literal parsing becomes '\\"' which LIKE processes as \ + ") -- mirroring
-- the pattern used in 0048_rename_weth_to_wrapped.sql. REPLACE has no such
-- escape processing, so the REPLACE patterns keep single backslashes.

UPDATE workflows
SET featured_protocol = 'aave-v3'
WHERE featured_protocol = 'aave';
--> statement-breakpoint

UPDATE workflows
SET nodes = REPLACE(
  REPLACE(
    nodes::text,
    '"actionType": "aave/',
    '"actionType": "aave-v3/'
  ),
  '\"protocolSlug\":\"aave\"',
  '\"protocolSlug\":\"aave-v3\"'
)::jsonb
WHERE
  nodes::text LIKE '%"actionType": "aave/%'
  OR nodes::text LIKE '%\\"protocolSlug\\":\\"aave\\"%';
--> statement-breakpoint

-- Event triggers (node.data._eventProtocolSlug).
-- Structured jsonb_set via jsonb_agg, mirroring the 0025 precedent.
UPDATE workflows
SET nodes = (
  SELECT jsonb_agg(
    CASE
      WHEN node->'data'->>'_eventProtocolSlug' = 'aave'
      THEN jsonb_set(node, '{data,_eventProtocolSlug}', '"aave-v3"')
      ELSE node
    END
  )
  FROM jsonb_array_elements(nodes) AS node
)
WHERE
  nodes::text LIKE '%"_eventProtocolSlug":"aave"%'
  OR nodes::text LIKE '%"_eventProtocolSlug": "aave"%';
--> statement-breakpoint

-- Defensive: integrations.type is $type<IntegrationType> which no longer
-- admits "aave". Protocol plugins set requiresCredentials: false, so no
-- rows are expected, but renaming is idempotent and cheap.
UPDATE integrations
SET type = 'aave-v3'
WHERE type = 'aave';
