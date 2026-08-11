-- Versioned, encrypted-at-rest HMAC signing secrets for internal service-to-
-- service authentication. One row per (caller, key_version). Rotation inserts
-- a new row at version+1 and stamps the previous row's expires_at = now() + 24h
-- so consumers in the grace window keep verifying while they pick up the new
-- secret.
--
-- secret_ciphertext envelope shape is identical to agentic_wallet_hmac_secrets:
-- AES-256-GCM with a 12-byte IV, encoded as
--   `${base64(iv)}:${base64(authTag)}:${base64(ciphertext)}`
-- AAD = `${caller}:${keyVersion}`. See lib/agentic-wallet/hmac-secret-store.ts
-- for the encrypt/decrypt helpers reused by the internal-service store.
--
-- caller is plain text (not a pgEnum) so adding a new internal service does
-- not require a follow-up migration. The application enforces the valid set
-- via the InternalCaller union in lib/internal-service-auth.ts.

CREATE TABLE "internal_service_hmac_secrets" (
  "caller" text NOT NULL,
  "key_version" integer NOT NULL,
  "secret_ciphertext" text NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "expires_at" timestamp,
  CONSTRAINT "internal_service_hmac_secrets_pkey"
    PRIMARY KEY ("caller", "key_version")
);
