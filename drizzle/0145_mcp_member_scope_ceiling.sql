-- Per-person ceiling on what their MCP agents may do in an organization.
--
-- A cap tied to a connection is shed by reconnecting, because every `mcp add`
-- registers a new OAuth client. The membership is the durable unit: it survives
-- both re-consent and re-registration, so a narrowing set by an owner or admin
-- cannot be undone by the person it applies to.
--
-- NULL means only the organization ceiling applies, which is what every
-- existing membership gets, so nothing an agent already does stops working.
ALTER TABLE "member" ADD COLUMN IF NOT EXISTS "mcp_max_scope" text;
