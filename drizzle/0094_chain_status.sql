-- Per-chain support maturity signal.
--
-- chains.status: "stable" | "experimental" | "deprecated". Surfaced to agents
-- through list_action_schemas (/api/mcp/schemas) so they can tell at request
-- time whether a chain is production-ready. Orthogonal to is_enabled: a chain
-- can be enabled (selectable) yet experimental (broadcast may be unreliable).
-- 0G mainnet (16661) and 0G Galileo testnet (16602) ship as experimental
-- because broadcasts can hang despite the request being accepted.

ALTER TABLE chains
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'stable';

UPDATE chains
  SET status = 'experimental'
  WHERE chain_id IN (16661, 16602);
