-- Records which API key made a workflow edit, alongside the existing
-- auth_method. Without it an edit made through an org API key is attributed
-- to the key's creator, so every MCP edit reads as that one person.
--
-- No FK: the key can be revoked or deleted later and the attribution has to
-- survive that, matching security_audit_log.api_key_id.
ALTER TABLE "workflow_history" ADD COLUMN IF NOT EXISTS "api_key_id" text;
