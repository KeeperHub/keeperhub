import "server-only";

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { toChecksumAddress } from "@/lib/address-utils";
import { filterUnauthorizedIntegrationIds } from "@/lib/integrations/authorization";
import { mergeSecretConfig } from "@/lib/integrations/secret-fields";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import {
  getOrganizationWallet,
  organizationHasWallet,
} from "@/lib/web3/wallet-helpers";
import {
  findActionById,
  getIntegration as getPluginDefinition,
} from "@/plugins/registry";
import type { IntegrationConfig, IntegrationType } from "../types/integration";
import { db } from "./index";
import { integrations, type NewIntegration } from "./schema";
import { organizationWallets } from "./schema-extensions";

// Encryption configuration
const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16;
const ENCRYPTION_KEY_ENV = "INTEGRATION_ENCRYPTION_KEY";

/**
 * Get or generate encryption key from environment
 * Key should be a 32-byte hex string (64 characters)
 */
function getEncryptionKey(): Buffer {
  const keyHex = process.env[ENCRYPTION_KEY_ENV];

  if (!keyHex) {
    throw new Error(
      `${ENCRYPTION_KEY_ENV} environment variable is required for encrypting integration credentials`
    );
  }

  if (keyHex.length !== 64) {
    throw new Error(
      `${ENCRYPTION_KEY_ENV} must be a 64-character hex string (32 bytes)`
    );
  }

  return Buffer.from(keyHex, "hex");
}

/**
 * Encrypt sensitive data
 * Returns a string in format: iv:authTag:encryptedData (all hex-encoded)
 */
export function encrypt(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(plaintext, "utf8", "hex");
  encrypted += cipher.final("hex");

  const authTag = cipher.getAuthTag();

  // Return format: iv:authTag:ciphertext (all hex)
  return `${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted}`;
}

/**
 * Decrypt encrypted data
 */
export function decrypt(ciphertext: string): string {
  const key = getEncryptionKey();
  const parts = ciphertext.split(":");

  if (parts.length !== 3) {
    throw new Error("Invalid encrypted data format");
  }

  const iv = Buffer.from(parts[0], "hex");
  const authTag = Buffer.from(parts[1], "hex");
  const encrypted = parts[2];

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(encrypted, "hex", "utf8");
  decrypted += decipher.final("utf8");

  return decrypted;
}

/**
 * Encrypt integration config object
 */
function encryptConfig(config: Record<string, unknown>): string {
  return encrypt(JSON.stringify(config));
}

/**
 * Decrypt integration config object
 */
function decryptConfig(encryptedConfig: string): Record<string, unknown> {
  try {
    const decrypted = decrypt(encryptedConfig);
    return JSON.parse(decrypted);
  } catch (error) {
    logSystemError(
      ErrorCategory.INFRASTRUCTURE,
      "[Integrations] Failed to decrypt integration config",
      error
    );
    return {};
  }
}

export type DecryptedIntegration = {
  id: string;
  createdBy: string;
  name: string;
  type: IntegrationType;
  config: IntegrationConfig;
  isManaged: boolean | null;
  createdAt: Date;
  updatedAt: Date;
  /**
   * Canonical wallet address for web3 integrations (EIP-55 checksummed).
   * Always null for non-web3 integration types. Derived from
   * `organization_wallets.wallet_address` (active wallet) via LEFT JOIN.
   *
   * KEEP-484: `name` was historically a UI-truncated display string for
   * web3 rows (`0x5623...960C`), which callers passed verbatim as
   * `onBehalfOf` to contract calls and reverted. Surfacing the canonical
   * address as its own field removes that ambiguity for API consumers.
   */
  address: string | null;
};

function isWeb3Row(row: {
  type: string;
  walletAddress?: string | null;
}): boolean {
  return row.type === "web3";
}

function deriveAddress(row: {
  type: string;
  walletAddress?: string | null;
}): string | null {
  if (!isWeb3Row(row)) {
    return null;
  }
  return row.walletAddress ? toChecksumAddress(row.walletAddress) : null;
}

/**
 * Get all integrations for a user, optionally filtered by type
 * Updated to support organization context
 */
export async function getIntegrations(
  userId: string,
  type?: IntegrationType,
  organizationId?: string | null
): Promise<DecryptedIntegration[]> {
  // No active org -> personal scope only. Constrain to integrations the user
  // created that are NOT org-scoped (organizationId IS NULL); without this the
  // fallback returns every connection the user ever created in ANY org, which
  // leaks cross-org connections into the workflow connection picker.
  const conditions = organizationId
    ? [eq(integrations.organizationId, organizationId)]
    : [eq(integrations.createdBy, userId), isNull(integrations.organizationId)];

  if (type) {
    conditions.push(eq(integrations.type, type));
  }

  const results = await db
    .select({
      id: integrations.id,
      createdBy: integrations.createdBy,
      organizationId: integrations.organizationId,
      name: integrations.name,
      type: integrations.type,
      config: integrations.config,
      isManaged: integrations.isManaged,
      createdAt: integrations.createdAt,
      updatedAt: integrations.updatedAt,
      walletAddress: organizationWallets.walletAddress,
    })
    .from(integrations)
    .leftJoin(
      organizationWallets,
      and(
        eq(organizationWallets.organizationId, integrations.organizationId),
        eq(organizationWallets.isActive, true)
      )
    )
    .where(and(...conditions))
    // Deterministic order so list consumers (e.g. the connection picker) see a
    // stable "first" row instead of unordered, insertion-dependent results.
    .orderBy(integrations.createdAt, integrations.id);

  return results.map((row) => ({
    id: row.id,
    createdBy: row.createdBy,
    name: row.name,
    type: row.type,
    config: decryptConfig(row.config as string) as IntegrationConfig,
    isManaged: row.isManaged,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    address: deriveAddress(row),
  }));
}

const integrationWithWalletSelect = {
  id: integrations.id,
  createdBy: integrations.createdBy,
  organizationId: integrations.organizationId,
  name: integrations.name,
  type: integrations.type,
  config: integrations.config,
  isManaged: integrations.isManaged,
  createdAt: integrations.createdAt,
  updatedAt: integrations.updatedAt,
  walletAddress: organizationWallets.walletAddress,
} as const;

/**
 * Get a single integration by ID
 * Updated to support organization context
 */
export async function getIntegration(
  integrationId: string,
  userId: string,
  organizationId?: string | null
): Promise<DecryptedIntegration | null> {
  // No active org -> personal scope only. Constrain the createdBy fallback to
  // org-less rows (organizationId IS NULL); otherwise a user could GET an
  // org-owned integration they created in ANY org by presenting a null-org
  // context, bypassing org membership and the deactivation-cascade gate.
  const conditions = organizationId
    ? [
        eq(integrations.id, integrationId),
        eq(integrations.organizationId, organizationId),
      ]
    : [
        eq(integrations.id, integrationId),
        eq(integrations.createdBy, userId),
        isNull(integrations.organizationId),
      ];

  const result = await db
    .select(integrationWithWalletSelect)
    .from(integrations)
    .leftJoin(
      organizationWallets,
      and(
        eq(organizationWallets.organizationId, integrations.organizationId),
        eq(organizationWallets.isActive, true)
      )
    )
    .where(and(...conditions))
    .limit(1);

  if (result.length === 0) {
    return null;
  }

  const row = result[0];
  return {
    id: row.id,
    createdBy: row.createdBy,
    name: row.name,
    type: row.type,
    config: decryptConfig(row.config as string) as IntegrationConfig,
    isManaged: row.isManaged,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    address: deriveAddress(row),
  };
}

/**
 * Get a single integration by ID without user check (for system use during workflow execution)
 */
export async function getIntegrationById(
  integrationId: string
): Promise<DecryptedIntegration | null> {
  const result = await db
    .select(integrationWithWalletSelect)
    .from(integrations)
    .leftJoin(
      organizationWallets,
      and(
        eq(organizationWallets.organizationId, integrations.organizationId),
        eq(organizationWallets.isActive, true)
      )
    )
    .where(eq(integrations.id, integrationId))
    .limit(1);

  if (result.length === 0) {
    return null;
  }

  const row = result[0];
  return {
    id: row.id,
    createdBy: row.createdBy,
    name: row.name,
    type: row.type,
    config: decryptConfig(row.config as string) as IntegrationConfig,
    isManaged: row.isManaged,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    address: deriveAddress(row),
  };
}

/**
 * Create a new integration
 * Updated to support organization context
 */
type CreateIntegrationOptions = {
  userId: string;
  name: string;
  type: IntegrationType;
  config: IntegrationConfig;
  organizationId?: string | null;
};

async function lookupWalletAddress(
  organizationId: string | null | undefined
): Promise<string | null> {
  if (!organizationId) {
    return null;
  }
  const [wallet] = await db
    .select({ walletAddress: organizationWallets.walletAddress })
    .from(organizationWallets)
    .where(
      and(
        eq(organizationWallets.organizationId, organizationId),
        eq(organizationWallets.isActive, true)
      )
    )
    .limit(1);
  return wallet?.walletAddress ?? null;
}

export async function createIntegration(
  options: CreateIntegrationOptions
): Promise<DecryptedIntegration> {
  const { userId, name, type, config, organizationId } = options;
  const encryptedConfig = encryptConfig(config);

  const [result] = await db
    .insert(integrations)
    .values({
      createdBy: userId,
      name,
      type,
      config: encryptedConfig,
      organizationId,
      // Org-scoped integrations are team-shared by default so collaborative
      // workflows keep working without a grant step; personal (no-org)
      // integrations stay owner-only. Matches the migration backfill. Owners
      // can later tighten an org integration to private/specific_members.
      visibility: organizationId ? "organization" : "private",
    })
    .returning();

  const walletAddress =
    type === "web3" ? await lookupWalletAddress(organizationId) : null;

  return {
    ...result,
    config,
    address: deriveAddress({ type, walletAddress }),
  };
}

/**
 * Build the canonical payload used to create the cosmetic web3 integration
 * row that backs an org's KeeperHub wallet. Shared between the provisioning
 * route (`app/api/user/wallet/route.ts`) and the read-path heal below so the
 * shape can't drift if one site adds a field.
 */
export function buildWalletIntegrationPayload(
  userId: string,
  organizationId: string,
  walletAddress: string
): CreateIntegrationOptions {
  return {
    userId,
    organizationId,
    // KEEP-484: store the canonical EIP-55 checksummed address. Historical
    // rows used a UI-truncated display string like `0x5623...960C`, which
    // API consumers mistook for a real address and passed verbatim to
    // contract calls. Truncation is a presentation concern handled by UI.
    name: toChecksumAddress(walletAddress),
    type: "web3",
    config: {},
  };
}

/**
 * Ensure the org's KeeperHub wallet has a backing web3 integration row.
 *
 * Wallet provisioning auto-creates a cosmetic web3 integration alongside the
 * wallet. For orgs whose wallet pre-dates that auto-create code, or whose
 * integration was deleted / migrated, the row can be missing -- which made
 * the Workflow Builder render a misleading "Add Web3 connection" warning
 * even though the wallet itself was working fine.
 *
 * Heals that drift idempotently: if the org has an active wallet but no
 * web3 integration row, create one with the canonical payload. Safe to call
 * from any read path that lists integrations -- after the first call for a
 * given org the row exists and subsequent calls early-return. The userId on
 * a healed row is just the first member to GET after deploy; reads are
 * org-scoped so this is benign.
 */
export async function ensureWalletIntegration(
  userId: string,
  organizationId: string
): Promise<void> {
  const hasWallet = await organizationHasWallet(organizationId);
  if (!hasWallet) {
    return;
  }

  const existing = await db
    .select({ id: integrations.id })
    .from(integrations)
    .where(
      and(
        eq(integrations.organizationId, organizationId),
        eq(integrations.type, "web3")
      )
    )
    .limit(1);
  if (existing.length > 0) {
    return;
  }

  const wallet = await getOrganizationWallet(organizationId);
  // The existence check above is racy: two concurrent /api/integrations GETs
  // for the same org can both pass it and both insert. The
  // `idx_integrations_org_web3` partial unique index makes the second insert
  // fail with Postgres unique_violation (23505); swallow it and treat as
  // success since the other caller already created the row. drizzle-orm wraps
  // driver errors in DrizzleQueryError with the original PostgresError on
  // `.cause` -- match the repo's established pattern (lib/mcp/listing.ts,
  // app/api/user/wallet/route.ts).
  try {
    await createIntegration(
      buildWalletIntegrationPayload(
        userId,
        organizationId,
        wallet.walletAddress
      )
    );
  } catch (err) {
    if (!isUniqueViolation(err)) {
      throw err;
    }
  }
}

function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== "object") {
    return false;
  }
  const e = err as { code?: string; cause?: { code?: string } };
  return (e.cause?.code ?? e.code) === "23505";
}

/**
 * Update an integration
 * Updated to support organization context
 */
export async function updateIntegration(
  integrationId: string,
  userId: string,
  updates: {
    name?: string;
    config?: IntegrationConfig;
  },
  organizationId?: string | null,
  existingIntegration?: DecryptedIntegration | null
): Promise<DecryptedIntegration | null> {
  const updateData: Partial<NewIntegration> = {
    updatedAt: new Date(),
  };

  if (updates.name !== undefined) {
    updateData.name = updates.name;
  }

  if (updates.config !== undefined) {
    // Clients never receive stored secrets back, so an unchanged secret
    // arrives blank. Merge for every type or the update would erase it.
    updateData.config = encryptConfig(
      existingIntegration
        ? mergeSecretConfig(
            existingIntegration.config,
            updates.config,
            existingIntegration.type
          )
        : updates.config
    );
  }

  // No active org -> personal scope only. Constrain the createdBy fallback to
  // org-less rows so a null-org context cannot UPDATE an org-owned integration
  // the user created in another org (IDOR/authz bypass).
  const conditions = organizationId
    ? [
        eq(integrations.id, integrationId),
        eq(integrations.organizationId, organizationId),
      ]
    : [
        eq(integrations.id, integrationId),
        eq(integrations.createdBy, userId),
        isNull(integrations.organizationId),
      ];

  const [result] = await db
    .update(integrations)
    .set(updateData)
    .where(and(...conditions))
    .returning();

  if (!result) {
    return null;
  }

  const walletAddress =
    result.type === "web3"
      ? await lookupWalletAddress(result.organizationId)
      : null;

  return {
    ...result,
    config: decryptConfig(result.config as string) as IntegrationConfig,
    address: deriveAddress({ type: result.type, walletAddress }),
  };
}

/**
 * Delete an integration
 * Updated to support organization context
 */
export async function deleteIntegration(
  integrationId: string,
  userId: string,
  organizationId?: string | null
): Promise<boolean> {
  // No active org -> personal scope only. Constrain the createdBy fallback to
  // org-less rows so a null-org context cannot DELETE an org-owned integration
  // the user created in another org (IDOR/authz bypass).
  const conditions = organizationId
    ? [
        eq(integrations.id, integrationId),
        eq(integrations.organizationId, organizationId),
      ]
    : [
        eq(integrations.id, integrationId),
        eq(integrations.createdBy, userId),
        isNull(integrations.organizationId),
      ];

  const result = await db
    .delete(integrations)
    .where(and(...conditions))
    .returning();

  return result.length > 0;
}

/**
 * Workflow node structure for validation
 */
type WorkflowNodeForValidation = {
  data?: {
    config?: {
      integrationId?: string;
      actionType?: string;
    };
  };
};

/**
 * Check if a node's integration ID should be included for validation
 */
function shouldIncludeIntegrationId(node: WorkflowNodeForValidation): boolean {
  const actionType = node.data?.config?.actionType;

  // No action type - include for validation
  if (!actionType || typeof actionType !== "string") {
    return true;
  }

  const action = findActionById(actionType);

  // Unknown action - include for validation
  if (!action) {
    return true;
  }

  const plugin = getPluginDefinition(action.integration);

  // Only include if plugin requires integration (defaults to true)
  return plugin?.requiresCredentials !== false;
}

/**
 * Extract all integration IDs from workflow nodes
 * Only includes nodes whose actions actually require an integration
 */
export function extractIntegrationIds(
  nodes: WorkflowNodeForValidation[]
): string[] {
  const integrationIds: string[] = [];

  for (const node of nodes) {
    const integrationId = node.data?.config?.integrationId;
    if (!integrationId || typeof integrationId !== "string") {
      continue;
    }

    if (shouldIncludeIntegrationId(node)) {
      integrationIds.push(integrationId);
    }
  }

  return [...new Set(integrationIds)];
}

/**
 * Validate that the executing/saving principal is authorized to use every
 * integration referenced by a workflow's nodes.
 *
 * Authorization is per-integration against the principal's grant - not merely
 * "same organization". This is what closes the lateral-movement path where any
 * org member could run a workflow that referenced another member's credential.
 * Non-existent ids (deleted integrations) stay valid so stale references
 * remain savable.
 *
 * The org owns workflows, so workflow save/execute gates pass the ORG
 * principal (the workflow's `organizationId`): the workflow may reference its
 * org's organization-visibility integrations and nothing personal, keeping
 * the gate consistent with the runtime credential fetch.
 *
 * @returns Object with `valid` boolean and optional `invalidIds` array
 */
export async function validateWorkflowIntegrations(
  nodes: WorkflowNodeForValidation[],
  organizationId?: string | null
): Promise<{ valid: boolean; invalidIds?: string[] }> {
  const integrationIds = extractIntegrationIds(nodes);

  if (integrationIds.length === 0) {
    return { valid: true };
  }

  const invalidIds = await filterUnauthorizedIntegrationIds(integrationIds, {
    organizationId: organizationId ?? null,
  });

  if (invalidIds.length > 0) {
    return { valid: false, invalidIds };
  }

  return { valid: true };
}
