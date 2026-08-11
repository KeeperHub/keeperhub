-- KEEP-239: replace plaintext sessions.token with sha256 hash.
-- Cookies / bearer headers held by clients still contain the raw token; this
-- migration hashes the column so that a DB exfiltration no longer yields live
-- bearers. The wrapWithSessionTokenHash adapter (lib/auth-session-token-hash.ts)
-- transparently hashes inbound tokens at lookup time, so existing sessions
-- keep working without forcing users to re-authenticate.
--
-- Idempotency: a second run would double-hash. Guarded by a length check --
-- generateId(32) produces 32-char tokens; sha256 hex is 64 chars. Skip rows
-- that already look hashed.

UPDATE sessions
SET token = encode(sha256(token::bytea), 'hex')
WHERE length(token) <> 64
   OR token !~ '^[0-9a-f]{64}$';
