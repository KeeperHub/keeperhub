"use client";

import { Copy, History, Key, Server, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Pager } from "@/components/activity/pager";
import { DualFactorInput } from "@/components/auth/dual-factor-input";
import { DualFactorSteps } from "@/components/auth/dual-factor-steps";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { isWalletEmail } from "@/lib/auth/wallet-constants";
import { authClient, useSession } from "@/lib/auth-client";
import { handleGuardError } from "@/lib/client/handle-guard-error";
import {
  runWalletStepUp,
  signStepUpChallenge,
} from "@/lib/wallet/step-up-client";
import { usePaginatedResource } from "@/lib/hooks/use-paginated-resource";
import { useActiveMember } from "@/lib/hooks/use-organization";
import type { Page, PageMeta } from "@/lib/pagination";
import { useDualFactorState } from "@/lib/mfa/use-dual-factor-state";
import { SCOPE_MCP_READ, SUPPORTED_SCOPES } from "@/lib/mcp/oauth-scopes";
import { ConfirmOverlay } from "./confirm-overlay";
import { KeyActivityOverlay } from "./key-activity-overlay";
import { Overlay } from "./overlay";
import { useOverlay } from "./overlay-provider";
import type { OverlayComponentProps } from "./types";

export type ApiKey = {
  id: string;
  name: string | null;
  keyPrefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  scope?: string | null;
  createdByName?: string | null;
  createdByEmail?: string | null;
  createdByRole?: string | null;
  key?: string;
};

type ApiKeysOverlayProps = OverlayComponentProps<{
  // Highlight + scroll to this key (e.g. opened from the activity feed). The
  // resource type selects which tab opens: org keys vs personal/user keys.
  highlightId?: string;
  highlightType?: "api_key" | "org_api_key";
  // Fires once, with the full secret, right after a key is created. Lets a
  // caller (e.g. the onboarding connect-agent step) reflect the new key.
  onKeyCreated?: (key: string, type: "webhook" | "organisation") => void;
}>;

// Read is genuinely read-only at the API layer: it is refused with 403 at the
// direct-execution endpoints. Say so here, because a key created with Write
// unchecked cannot broadcast and that is not recoverable without a new key.
const SCOPE_LABELS: Record<string, string> = {
  "mcp:read":
    "Read your workflows, executions, and plugin schemas. Cannot run workflows or send transactions.",
  "mcp:write":
    "Write your workflows, executions, and integrations, and send transactions",
  "mcp:admin": "Full access to all existing and future actions",
};

/**
 * Overlay for creating a new API key.
 * Pushed onto the stack from ApiKeysOverlay.
 */
export function CreateApiKeyOverlay({
  overlayId,
  onCreated,
  endpoint,
  keyType,
}: {
  overlayId: string;
  onCreated: (key: ApiKey) => void;
  endpoint: string;
  keyType: "webhook" | "organisation";
}): React.ReactElement {
  const { pop } = useOverlay();
  const session = useSession();
  const isWallet = isWalletEmail(session.data?.user?.email);
  const [keyName, setKeyName] = useState("");
  const [phase, setPhase] = useState<"label" | "codes">("label");
  const dual = useDualFactorState();
  const [creating, setCreating] = useState(false);
  // Only read is pre-checked. Pre-checking all three made the least-effort
  // mint a full-access mcp:admin key, which is the widest-by-default outcome
  // parseScopeInput was just changed to stop producing on the API side.
  const [selectedScopes, setSelectedScopes] = useState<Record<string, boolean>>(
    () =>
      Object.fromEntries(
        SUPPORTED_SCOPES.map((s) => [s, s === SCOPE_MCP_READ])
      )
  );

  // Scope is only enforced for organisation keys (kh_): authenticateApiKey
  // reads the column on organizationApiKeys, and requireScope gates on it.
  // Webhook keys (wfb_) are looked up by hash in the workflow webhook route and
  // dispatched without consulting scope, so offering the checkboxes there would
  // promise a restriction nothing applies.
  const scopesApply = keyType === "organisation";
  const activeScopes = SUPPORTED_SCOPES.filter((s) => selectedScopes[s]);
  const hasScopeSelected = !scopesApply || activeScopes.length > 0;
  // Omitted rather than sent-and-ignored for webhook keys, so the stored column
  // says what is true: this key carries no scope restriction.
  const scopesForRequest = scopesApply ? activeScopes : undefined;

  const toggleScope = (id: string, checked: boolean): void => {
    if (id === "mcp:admin" && checked) {
      setSelectedScopes((prev) =>
        Object.fromEntries(Object.keys(prev).map((k) => [k, true]))
      );
    } else {
      setSelectedScopes((prev) => ({ ...prev, [id]: checked }));
    }
  };

  const isAdminSelected = selectedScopes["mcp:admin"] ?? false;

  const emptyCodesFetch = (): Promise<Response> =>
    fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: keyName.trim() || null,
        scopes: scopesForRequest,
      }),
    });

  // Wallet users confirm by signing instead of entering TOTP + email codes.
  const handleWalletCreate = async (): Promise<void> => {
    setCreating(true);
    try {
      const response = await runWalletStepUp((extra) =>
        fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            // Spread first so the step-up payload cannot silently take over a
            // field the operator set: whatever it returns is overridden by the
            // explicit keys below rather than the other way round.
            ...extra,
            name: keyName.trim() || null,
            // The same Permissions block is shown to wallet users, so the
            // selection has to reach the API here too. Omitting it minted an
            // unscoped key that ignored whatever the user unchecked.
            scopes: scopesForRequest,
          }),
        })
      );
      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as {
          error?: string;
        };
        toast.error(data.error || "Failed to create API key");
        return;
      }
      onCreated(await response.json());
      toast.success("API key created successfully");
      pop();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to create API key"
      );
    } finally {
      setCreating(false);
    }
  };

  const handleCreate = async (): Promise<void> => {
    setCreating(true);
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: keyName.trim() || null,
          scopes: scopesForRequest,
          code: dual.totpCode.trim(),
          emailOtp: dual.emailOtp.trim() || undefined,
        }),
      });

      if (!response.ok) {
        // Guard failures (role / MFA) surface as a toast and leave the user
        // on this dialog. Don't pop and bounce them to Settings or the
        // step-up page; that reads as being dropped onto an unrelated modal.
        const guarded = await handleGuardError(response);
        if (guarded) {
          return;
        }
        const data = (await response.json().catch(() => ({}))) as {
          error?: string;
          code?: string;
        };
        if (
          dual.handleResponse(data.code, data.error, (msg) => toast.error(msg))
        ) {
          return;
        }
        throw new Error(data.error ?? "Failed to create API key");
      }

      const newKey = (await response.json()) as ApiKey;
      onCreated(newKey);
      toast.success("API key created successfully");
      pop();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to create API key"
      );
    } finally {
      setCreating(false);
    }
  };

  const description =
    keyType === "webhook"
      ? "Create a new API key for webhook authentication"
      : "Create a new API key for MCP server and external integrations";

  if (phase === "codes") {
    return (
      <Overlay overlayId={overlayId} title="Create API Key">
        <p className="mb-4 text-muted-foreground text-sm">
          Confirm with both factors to mint{" "}
          <span className="font-medium text-foreground">
            {keyName.trim() || "this API key"}
          </span>
          .
        </p>
        <DualFactorSteps
          busy={creating}
          dual={dual}
          onBack={pop}
          onPrefetchEmail={() => dual.prefetchEmail(emptyCodesFetch)}
          onResendEmail={() => dual.resendEmail(emptyCodesFetch)}
          onSubmit={handleCreate}
          submitLabel="Create API key"
        />
      </Overlay>
    );
  }

  return (
    <Overlay
      actions={[
        isWallet
          ? {
              label: "Create API key",
              onClick: handleWalletCreate,
              disabled: !keyName.trim() || creating || !hasScopeSelected,
            }
          : {
              label: "Continue",
              onClick: () => setPhase("codes"),
              disabled: !keyName.trim() || !hasScopeSelected,
            },
      ]}
      overlayId={overlayId}
      title="Create API Key"
    >
      <p className="mb-4 text-muted-foreground text-sm">{description}</p>
      <div className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="key-name">Label</Label>
          <Input
            id="key-name"
            onChange={(e) => setKeyName(e.target.value)}
            placeholder="e.g., Production, Testing"
            value={keyName}
          />
        </div>
        {scopesApply && (
          <div className="space-y-2">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Permissions
            </p>
            <div className="rounded-lg border bg-muted/30 p-4">
              <ul className="space-y-3">
                {SUPPORTED_SCOPES.map((scopeId) => {
                  const lockedByAdmin = scopeId !== "mcp:admin" && isAdminSelected;
                  return (
                    <li key={scopeId}>
                      <label
                        className={`flex items-center gap-3 text-sm text-foreground ${lockedByAdmin ? "cursor-default opacity-50" : "cursor-pointer"}`}
                      >
                        <input
                          checked={selectedScopes[scopeId] ?? false}
                          className="h-4 w-4 shrink-0 rounded border-input accent-[var(--ds-green-accent)]"
                          disabled={lockedByAdmin}
                          onChange={(e) => toggleScope(scopeId, e.target.checked)}
                          type="checkbox"
                          value={scopeId}
                        />
                        {SCOPE_LABELS[scopeId] ?? scopeId}
                      </label>
                    </li>
                  );
                })}
              </ul>
            </div>
          </div>
        )}
      </div>
    </Overlay>
  );
}

/**
 * Shared component for displaying and managing API keys list
 */
/**
 * Confirm-and-revoke dialog. Replaces the older ConfirmOverlay path
 * because revocation now requires a fresh TOTP code in addition to
 * a confirmation click; the generic ConfirmOverlay can't collect a
 * second factor without bloating its API.
 */
export function DeleteApiKeyOverlay({
  overlayId,
  keyId,
  onDelete,
  deleteEndpoint,
}: {
  overlayId: string;
  keyId: string;
  onDelete: (
    keyId: string,
    code: string,
    emailOtp: string,
    signature?: string
  ) => Promise<{ ok: true } | { ok: false; code: string; challenge?: string }>;
  deleteEndpoint: (id: string) => string;
}): React.ReactElement {
  const { pop } = useOverlay();
  const session = useSession();
  const isWallet = isWalletEmail(session.data?.user?.email);
  const dual = useDualFactorState();
  const [submitting, setSubmitting] = useState(false);

  // Wallet users revoke by signing the step-up challenge.
  const handleWalletRevoke = async (): Promise<void> => {
    setSubmitting(true);
    try {
      const first = await onDelete(keyId, "", "");
      if (first.ok) {
        pop();
        return;
      }
      if (first.code === "signature_required" && first.challenge) {
        const signature = await signStepUpChallenge(first.challenge);
        const second = await onDelete(keyId, "", "", signature);
        if (second.ok || second.code === "guarded" || second.code === "unknown") {
          pop();
        }
      }
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to revoke key"
      );
    } finally {
      setSubmitting(false);
    }
  };

  const emptyCodesFetch = (): Promise<Response> =>
    fetch(deleteEndpoint(keyId), {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

  const handleConfirm = async (): Promise<void> => {
    setSubmitting(true);
    try {
      const result = await onDelete(
        keyId,
        dual.totpCode.trim(),
        dual.emailOtp.trim()
      );
      if (result.ok) {
        pop();
        return;
      }
      if (
        dual.handleResponse(result.code, undefined, (msg) => toast.error(msg))
      ) {
        return;
      }
      // "guarded" or "unknown": parent helper already toasted; just close.
      pop();
    } finally {
      setSubmitting(false);
    }
  };

  if (isWallet) {
    return (
      <Overlay
        actions={[
          { label: "Cancel", onClick: pop, variant: "outline" },
          {
            label: "Sign to revoke",
            onClick: handleWalletRevoke,
            variant: "destructive",
            disabled: submitting,
          },
        ]}
        overlayId={overlayId}
        title="Revoke API Key"
      >
        <p className="text-muted-foreground text-sm">
          Any integrations using this key will stop working immediately. Sign
          with your wallet to confirm.
        </p>
      </Overlay>
    );
  }

  return (
    <Overlay overlayId={overlayId} title="Revoke API Key">
      <p className="mb-4 text-muted-foreground text-sm">
        Any integrations using this key will stop working immediately. Confirm
        with both factors below.
      </p>
      <DualFactorSteps
        busy={submitting}
        dual={dual}
        onBack={pop}
        onPrefetchEmail={() => dual.prefetchEmail(emptyCodesFetch)}
        onResendEmail={() => dual.resendEmail(emptyCodesFetch)}
        onSubmit={handleConfirm}
        submitLabel="Revoke key"
        submitVariant="destructive"
      />
    </Overlay>
  );
}

function ApiKeysList({
  apiKeys,
  meta,
  onPage,
  newlyCreatedKey,
  deleting,
  onDelete,
  onDismissNewKey,
  showCreator = false,
  showScope = true,
  deleteEndpoint,
  canDelete = true,
  readOnlyReason,
  highlightId,
}: {
  apiKeys: ApiKey[];
  meta?: PageMeta | null;
  onPage?: (page: number) => void;
  newlyCreatedKey: string | null;
  deleting: string | null;
  onDelete: (
    keyId: string,
    code: string,
    emailOtp: string
  ) => Promise<{ ok: true } | { ok: false; code: string }>;
  onDismissNewKey: () => void;
  showCreator?: boolean;
  /**
   * Webhook (wfb_) keys store a scope that nothing reads: the workflow webhook
   * route looks a key up by hash and dispatches without consulting it. Showing
   * it there states a restriction that is not applied.
   */
  showScope?: boolean;
  deleteEndpoint: (id: string) => string;
  canDelete?: boolean;
  readOnlyReason?: string;
  highlightId?: string;
}) {
  const { push } = useOverlay();
  const highlightedRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (highlightId && highlightedRef.current) {
      highlightedRef.current.scrollIntoView({ block: "nearest" });
    }
  }, [highlightId]);

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    toast.success("Copied to clipboard");
  };

  const formatDate = (dateString: string) =>
    new Date(dateString).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });

  const openDeleteConfirm = (keyId: string) => {
    push(DeleteApiKeyOverlay, {
      keyId,
      onDelete,
      deleteEndpoint,
    });
  };

  return (
    <div className="space-y-4">
      {/* Newly created key warning */}
      {newlyCreatedKey && (
        <div className="rounded-md border border-yellow-500/50 bg-yellow-500/10 p-3">
          <p className="mb-2 font-medium text-sm text-yellow-600 dark:text-yellow-400">
            Copy your API key now. You won't be able to see it again!
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 break-all rounded bg-muted px-2 py-1 font-mono text-xs">
              {newlyCreatedKey}
            </code>
            <Button
              onClick={() => copyToClipboard(newlyCreatedKey)}
              size="sm"
              variant="outline"
            >
              <Copy className="size-4" />
            </Button>
          </div>
          <Button
            className="mt-2"
            onClick={onDismissNewKey}
            size="sm"
            variant="ghost"
          >
            Dismiss
          </Button>
        </div>
      )}

      {/* API Keys list */}
      {apiKeys.length === 0 ? (
        <div className="py-8 text-center text-muted-foreground text-sm">
          <Key className="mx-auto mb-2 size-8 opacity-50" />
          <p>No API keys yet</p>
        </div>
      ) : (
        <div className="space-y-2">
          {apiKeys.map((apiKey) => (
            <div
              className={`flex items-center justify-between rounded-md border p-3 ${apiKey.id === highlightId
                ? "bg-muted/40 ring-2 ring-primary/60 ring-inset"
                : ""
                }`}
              key={apiKey.id}
              ref={apiKey.id === highlightId ? highlightedRef : undefined}
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                    {apiKey.keyPrefix}...
                  </code>
                </div>
                {apiKey.name && (
                  <p className="mt-2 mb-2 text-sm">
                    {"Name: "}
                    <span className="truncate text-sm">{apiKey.name}</span>
                  </p>
                )}
                {showScope && apiKey.scope && (
                  <p className="mt-2 mb-2 text-sm">
                    {"Scope: "}
                    {apiKey.scope.split(" ").map((s) => (
                      <span key={s}>
                        <code className="rounded bg-muted px-1.5 py-0.5 font-mono">
                          {s.startsWith("mcp:") ? s.slice(4) : s}
                        </code>
                        {" "}
                      </span>
                    ))}
                  </p>
                )}
                <p className="mt-1 text-muted-foreground text-xs">
                  Created {formatDate(apiKey.createdAt)}
                  {showCreator &&
                    apiKey.createdByName &&
                    ` by ${apiKey.createdByName}`}
                  {apiKey.lastUsedAt
                    ? ` · Last used ${formatDate(apiKey.lastUsedAt)}`
                    : " · Never used"}
                </p>
              </div>
              <Button
                disabled={!canDelete || deleting === apiKey.id}
                onClick={() => openDeleteConfirm(apiKey.id)}
                size="sm"
                title={canDelete ? undefined : readOnlyReason}
                variant="ghost"
              >
                {deleting === apiKey.id ? (
                  <Spinner className="size-4" />
                ) : (
                  <Trash2 className="size-4 text-destructive" />
                )}
              </Button>
            </div>
          ))}
        </div>
      )}
      {meta && meta.totalPages > 1 && (
        <div className="pt-2">
          <Pager meta={meta} onPage={onPage ?? (() => undefined)} unit="keys" />
        </div>
      )}
    </div>
  );
}

/**
 * Hook for managing API keys state and operations
 */
export function useApiKeys(
  listEndpoint: string,
  deleteEndpoint: (id: string) => string
) {
  const [newlyCreatedKey, setNewlyCreatedKey] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  // Organisation keys are scoped server-side to the active org, so the org id
  // belongs in the query identity: switching org must reload the list.
  const { data: activeOrg } = authClient.useActiveOrganization();

  const {
    items: apiKeys,
    meta,
    setPage,
    loading,
    error,
    reload,
  } = usePaginatedResource<ApiKey>(
    (page) =>
      fetch(`${listEndpoint}?page=${page}`).then((r) => {
        if (!r.ok) {
          throw new Error("Failed to load API keys");
        }
        return r.json() as Promise<Page<ApiKey>>;
      }),
    `${listEndpoint}:${activeOrg?.id ?? ""}`
  );

  useEffect(() => {
    if (error) {
      toast.error("Failed to load API keys");
    }
  }, [error]);

  const handleKeyCreated = (newKey: ApiKey) => {
    setNewlyCreatedKey(newKey.key ?? null);
    reload();
  };

  const handleDelete = async (
    keyId: string,
    code: string,
    emailOtp: string,
    signature?: string
  ): Promise<
    { ok: true } | { ok: false; code: string; challenge?: string }
  > => {
    setDeleting(keyId);
    try {
      const response = await fetch(deleteEndpoint(keyId), {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code,
          emailOtp: emailOtp || undefined,
          signature,
        }),
      });

      if (!response.ok) {
        // Guard failures (role / MFA) surface as a toast and the confirm
        // dialog closes back to the key list. Don't bounce the user to
        // Settings or the step-up page; that reads as a random modal.
        const guarded = await handleGuardError(response);
        if (guarded) {
          return { ok: false, code: "guarded" };
        }
        const data = (await response.json().catch(() => ({}))) as {
          error?: string;
          code?: string;
          challenge?: string;
        };
        if (
          data.code === "factors_required" ||
          data.code === "mfa_code_invalid" ||
          data.code === "email_code_invalid" ||
          data.code === "signature_required"
        ) {
          return { ok: false, code: data.code, challenge: data.challenge };
        }
        toast.error(data.error || "Failed to delete API key");
        return { ok: false, code: "unknown" };
      }

      reload();
      toast.success("API key revoked");
      return { ok: true };
    } catch (error) {
      console.error("Failed to delete API key:", error);
      toast.error(
        error instanceof Error ? error.message : "Failed to delete API key"
      );
      return { ok: false, code: "unknown" };
    } finally {
      setDeleting(null);
    }
  };

  return {
    loading,
    apiKeys,
    meta,
    setPage,
    newlyCreatedKey,
    deleting,
    handleKeyCreated,
    handleDelete,
    deleteEndpoint,
    dismissNewKey: () => setNewlyCreatedKey(null),
  };
}

/**
 * Read-only card surfacing the MCP server endpoint URL with a copy button.
 * The endpoint is derived from NEXT_PUBLIC_APP_URL, falling back to the current
 * origin (resolved after mount to avoid a hydration mismatch when the env var
 * is unset).
 */
function McpEndpointCard() {
  const [mcpUrl, setMcpUrl] = useState(
    process.env.NEXT_PUBLIC_APP_URL
      ? `${process.env.NEXT_PUBLIC_APP_URL}/mcp`
      : ""
  );

  useEffect(() => {
    if (!mcpUrl) {
      setMcpUrl(`${window.location.origin}/mcp`);
    }
  }, [mcpUrl]);

  const copyEndpoint = () => {
    navigator.clipboard.writeText(mcpUrl);
    toast.success("Copied to clipboard");
  };

  return (
    <div className="mb-4 rounded-md border border-border bg-muted/40 p-3">
      <div className="mb-2 flex items-center gap-2">
        <Server className="size-4 text-muted-foreground" />
        <p className="font-medium text-sm">MCP endpoint</p>
      </div>
      <p className="mb-2 text-muted-foreground text-xs">
        Connect an agent or MCP client to this URL, authenticating with an
        organisation API key.
      </p>
      <div className="flex items-center gap-2">
        <code className="flex-1 break-all rounded bg-muted px-2 py-1 font-mono text-xs">
          {mcpUrl}
        </code>
        <Button
          disabled={!mcpUrl}
          onClick={copyEndpoint}
          size="sm"
          variant="outline"
        >
          <Copy className="size-4" />
        </Button>
      </div>
    </div>
  );
}

/**
 * Opens the key-activity modal (create/revoke trail) for a key set. The audit
 * read is admin/owner-only, so the caller gates this on that.
 */
function KeyActivityButton({
  resourceType,
  title,
  keys,
  defaultActor,
}: {
  resourceType: string;
  title: string;
  keys: ApiKey[];
  defaultActor?: {
    name?: string | null;
    email?: string | null;
    role?: string | null;
  } | null;
}): React.ReactElement {
  const { push } = useOverlay();
  return (
    <div className="mt-4 border-border border-t pt-3">
      <Button
        className="px-0 text-muted-foreground text-xs hover:text-foreground"
        onClick={() =>
          push(KeyActivityOverlay, {
            resourceType,
            title,
            keys,
            defaultActor,
          })
        }
        size="sm"
        variant="link"
      >
        <History className="mr-1.5 size-3.5" />
        View key activity
      </Button>
    </div>
  );
}

/**
 * Main API Keys management overlay with tabs for Webhook and Organisation keys.
 */
type ApiKeysPanelProps = {
  highlightId?: string;
  highlightType?: "api_key" | "org_api_key";
  onKeyCreated?: (key: string, type: "webhook" | "organisation") => void;
};

/**
 * Key list, scopes and activity. Rendered inline on the settings route; the
 * overlay below is the thin legacy wrapper around the same panel.
 */
export function ApiKeysPanel({
  highlightId,
  highlightType,
  onKeyCreated,
}: ApiKeysPanelProps) {
  const { push } = useOverlay();
  const { isAdmin, role } = useActiveMember();
  const { data: session } = useSession();
  // Webhook keys are personal, so their creator is the current user.
  const currentUser = {
    name: session?.user?.name ?? null,
    email: session?.user?.email ?? null,
    role: role ?? null,
  };
  const [activeTab, setActiveTab] = useState(
    highlightType === "api_key" ? "webhook" : "organisation"
  );

  // Webhook (User) keys
  const webhookKeys = useApiKeys(
    "/api/api-keys",
    (id) => `/api/api-keys/${id}`
  );

  // Organisation keys
  const orgKeys = useApiKeys(
    "/api/keys",
    (id) => `/api/keys/${id}`
  );

  const currentKeys = activeTab === "webhook" ? webhookKeys : orgKeys;
  const createEndpoint =
    activeTab === "webhook" ? "/api/api-keys" : "/api/keys";
  // Org keys are admin/owner-only at the API layer. Mirror that on the
  // UI so members see the list (useful context) but can't mint or
  // revoke. Personal webhook keys stay fully writable for every user.
  const canManageOrgKeys = isAdmin;
  const orgReadOnlyReason =
    "Only organization admins or owners can manage these keys.";

  const createKey = (): void => {
    push(CreateApiKeyOverlay, {
      onCreated: (key: ApiKey) => {
        currentKeys.handleKeyCreated(key);
        if (key.key) {
          onKeyCreated?.(key.key, activeTab as "webhook" | "organisation");
        }
      },
      endpoint: createEndpoint,
      keyType: activeTab as "webhook" | "organisation",
    });
  };

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button
          disabled={activeTab === "organisation" && !canManageOrgKeys}
          onClick={createKey}
          variant="outline"
        >
          New API Key
        </Button>
      </div>
      <McpEndpointCard />
      <Tabs className="-mt-2" onValueChange={setActiveTab} value={activeTab}>
        <TabsList className="w-full">
          <TabsTrigger className="flex-1" value="organisation">
            Organisation
          </TabsTrigger>
          <TabsTrigger className="flex-1" value="webhook">
            User
          </TabsTrigger>
        </TabsList>

        <TabsContent className="mt-4" value="organisation">
          <p className="mb-4 text-muted-foreground text-xs">
            Organisation-wide API keys for MCP servers and external
            integrations. These keys provide access to all workflows in the
            organisation.
          </p>
          {!canManageOrgKeys && (
            <p className="mb-3 rounded-md border border-border bg-muted/40 p-2 text-muted-foreground text-xs">
              {orgReadOnlyReason}
            </p>
          )}
          {orgKeys.loading ? (
            <div className="flex items-center justify-center py-8">
              <Spinner />
            </div>
          ) : (
            <ApiKeysList
              apiKeys={orgKeys.apiKeys}
              canDelete={canManageOrgKeys}
              deleteEndpoint={orgKeys.deleteEndpoint}
              deleting={orgKeys.deleting}
              highlightId={
                highlightType === "org_api_key" ? highlightId : undefined
              }
              meta={orgKeys.meta}
              newlyCreatedKey={orgKeys.newlyCreatedKey}
              onDelete={orgKeys.handleDelete}
              onDismissNewKey={orgKeys.dismissNewKey}
              onPage={orgKeys.setPage}
              readOnlyReason={orgReadOnlyReason}
              showCreator
            />
          )}

          {/* Create + revoke trail across all keys (incl. revoked ones no
              longer in the list). Audit read is admin/owner only. */}
          {canManageOrgKeys && (
            <KeyActivityButton
              keys={orgKeys.apiKeys}
              resourceType="org_api_key"
              title="Organisation key activity"
            />
          )}
        </TabsContent>

        <TabsContent className="mt-4" value="webhook">
          <p className="mb-4 text-muted-foreground text-xs">
            Personal API keys for authenticating webhook requests to your
            workflows.
          </p>
          {webhookKeys.loading ? (
            <div className="flex items-center justify-center py-8">
              <Spinner />
            </div>
          ) : (
            <ApiKeysList
              apiKeys={webhookKeys.apiKeys}
              showScope={false}
              deleteEndpoint={webhookKeys.deleteEndpoint}
              deleting={webhookKeys.deleting}
              highlightId={
                highlightType === "api_key" ? highlightId : undefined
              }
              meta={webhookKeys.meta}
              newlyCreatedKey={webhookKeys.newlyCreatedKey}
              onDelete={webhookKeys.handleDelete}
              onDismissNewKey={webhookKeys.dismissNewKey}
              onPage={webhookKeys.setPage}
            />
          )}
          {/* Audit read is admin/owner only (org-scoped security trail). */}
          {isAdmin && (
            <KeyActivityButton
              defaultActor={currentUser}
              keys={webhookKeys.apiKeys}
              resourceType="api_key"
              title="User key activity"
            />
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}

export function ApiKeysOverlay({
  overlayId,
  highlightId,
  highlightType,
  onKeyCreated,
}: ApiKeysOverlayProps) {
  const { closeAll } = useOverlay();
  return (
    <Overlay
      actions={[{ label: "Done", onClick: closeAll }]}
      overlayId={overlayId}
      title="API Keys"
    >
      <ApiKeysPanel
        highlightId={highlightId}
        highlightType={highlightType}
        onKeyCreated={onKeyCreated}
      />
    </Overlay>
  );
}
