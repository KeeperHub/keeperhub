-- Rename the `weth` protocol slug to `wrapped`.
-- Data migration only: no schema changes.
--
-- Rewrites two surfaces inside workflows.nodes jsonb:
--   1. node.data.config.actionType     "weth/..." -> "wrapped/..."
--   2. _protocolMeta.protocolSlug      "weth"     -> "wrapped"
--      (_protocolMeta is stored as a stringified JSON value, so its inner
--      keys appear as backslash-escaped substrings in the ::text form.)
--
-- Note on formatting: PostgreSQL's jsonb::text output inserts a space after
-- every colon at the outer level, so actionType matches use "actionType": "
-- (with space). The inner _protocolMeta string is stored verbatim from the
-- client-side JSON.stringify, so its keys have no space after the colon.
--
-- contractKey stays "weth" because it refers to the contracts{} key in the
-- protocol definition, which still represents the WETH9 interface.

UPDATE workflows
SET nodes = REPLACE(
    REPLACE(
      nodes::text,
      '"actionType": "weth/',
      '"actionType": "wrapped/'
    ),
    '\"protocolSlug\":\"weth\"',
    '\"protocolSlug\":\"wrapped\"'
  )::jsonb
WHERE nodes::text LIKE '%"actionType": "weth/%'
   OR nodes::text LIKE '%\\"protocolSlug\\":\\"weth\\"%';
