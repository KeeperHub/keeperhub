-- Rename safe-wallet protocol to safe in all workflow node configurations.
-- Updates actionType fields (e.g. "safe-wallet/get-owners" -> "safe/get-owners"),
-- _protocolMeta.protocolSlug, and event trigger _eventProtocolSlug / _eventProtocolIconPath.

-- 1. Update actionType in action nodes from "safe-wallet/*" to "safe/*"
UPDATE "workflow"
SET "nodes" = (
  SELECT jsonb_agg(
    CASE
      WHEN node->>'actionType' IS NOT NULL
           AND node->>'actionType' LIKE 'safe-wallet/%'
      THEN jsonb_set(
        node,
        '{actionType}',
        to_jsonb(replace(node->>'actionType', 'safe-wallet/', 'safe/'))
      )
      ELSE node
    END
  )
  FROM jsonb_array_elements("nodes") AS node
)
WHERE "nodes"::text LIKE '%safe-wallet/%';

-- 2. Update _protocolMeta.protocolSlug from "safe-wallet" to "safe" in action node data
UPDATE "workflow"
SET "nodes" = (
  SELECT jsonb_agg(
    CASE
      WHEN node->'data'->'_protocolMeta'->>'protocolSlug' = 'safe-wallet'
      THEN jsonb_set(
        node,
        '{data,_protocolMeta,protocolSlug}',
        '"safe"'
      )
      ELSE node
    END
  )
  FROM jsonb_array_elements("nodes") AS node
)
WHERE "nodes"::text LIKE '%"protocolSlug":"safe-wallet"%'
   OR "nodes"::text LIKE '%"protocolSlug": "safe-wallet"%';

-- 3. Update _eventProtocolSlug in trigger node data from "safe-wallet" to "safe"
UPDATE "workflow"
SET "nodes" = (
  SELECT jsonb_agg(
    CASE
      WHEN node->'data'->>'_eventProtocolSlug' = 'safe-wallet'
      THEN jsonb_set(
        jsonb_set(
          node,
          '{data,_eventProtocolSlug}',
          '"safe"'
        ),
        '{data,_eventProtocolIconPath}',
        '"/protocols/safe.png"'
      )
      ELSE node
    END
  )
  FROM jsonb_array_elements("nodes") AS node
)
WHERE "nodes"::text LIKE '%"_eventProtocolSlug":"safe-wallet"%'
   OR "nodes"::text LIKE '%"_eventProtocolSlug": "safe-wallet"%';

-- 4. Update featured_protocol column from "safe-wallet" to "safe"
UPDATE "workflow"
SET "featured_protocol" = 'safe'
WHERE "featured_protocol" = 'safe-wallet';
