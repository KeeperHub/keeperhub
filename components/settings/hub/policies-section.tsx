"use client";

import { ChevronRight } from "lucide-react";
import { useCallback, useState } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { type PolicyDocument, PolicyEnforcementMode } from "@/lib/policy";
import {
  type UnrepresentableReason,
  unrepresentable,
} from "@/lib/policy/catalog";
import {
  type OrganizationPolicySummary,
  usePolicies,
} from "./hooks/use-policies";
import {
  type EditorMode,
  EditorModeToggle,
} from "./policies/builder/editor-mode-toggle";
import { PolicyBuilder } from "./policies/builder/policy-builder";
import { PolicyCatalogProvider } from "./policies/policy-context";
import { PolicyDecisions } from "./policies/policy-decisions";
import { PolicyEditor } from "./policies/policy-editor";
import { PolicyOverview } from "./policies/policy-overview";
import { PolicySimulator } from "./policies/policy-simulator";
import { SectionHeader, SettingsCard } from "./section";
import { useSettingsContext } from "./settings-context";
import { FormSkeleton } from "./skeletons";

/**
 * A policy row.
 *
 * Enforcement is a switch rather than a dropdown because it is the only choice
 * that changes whether anything is blocked, and it deserves to look like a
 * switch. Monitor is the resting state: a policy records what it would have
 * done until somebody deliberately turns it on.
 */
function PolicyRow({
  policy,
  disabled,
  expanded,
  onToggleExpanded,
  children,
  onToggleEnforcement,
  onToggleEnabled,
  onEdit,
  onRemove,
}: {
  policy: OrganizationPolicySummary;
  disabled: boolean;
  expanded: boolean;
  onToggleExpanded: () => void;
  children: React.ReactNode;
  onToggleEnforcement: (next: PolicyEnforcementMode) => void;
  onToggleEnabled: (next: boolean) => void;
  onEdit: () => void;
  onRemove: () => void;
}): React.ReactElement {
  const enforcing = policy.enforcement === PolicyEnforcementMode.ENFORCE;
  const pending = new Date(policy.effectiveAt).getTime() > Date.now();

  return (
    <div className="flex flex-col gap-3 rounded-lg border p-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <button
          aria-expanded={expanded}
          className="flex min-w-0 flex-1 cursor-pointer flex-col gap-1 text-left"
          onClick={onToggleExpanded}
          type="button"
        >
          <div className="flex flex-wrap items-center gap-2">
            <ChevronRight
              aria-hidden="true"
              className={`size-3.5 text-muted-foreground transition-transform ${
                expanded ? "rotate-90" : ""
              }`}
            />
            <span className="font-medium text-sm">{policy.name}</span>
            <Badge variant={enforcing ? "default" : "secondary"}>
              {enforcing ? "Enforcing" : "Monitoring"}
            </Badge>
            {!policy.enabled && <Badge variant="outline">Disabled</Badge>}
            {policy.protected && <Badge variant="outline">Protected</Badge>}
            {pending && (
              <Badge variant="outline">
                Takes effect {new Date(policy.effectiveAt).toLocaleString()}
              </Badge>
            )}
          </div>
          <p className="text-muted-foreground text-xs">
            {policy.coverage
              ? `Binds ${policy.coverage.score}% of the available guards. `
              : ""}
            {policy.description ??
              `Governs ${policy.document.manages.length} scope${
                policy.document.manages.length === 1 ? "" : "s"
              }, ${policy.document.statements.length} statement${
                policy.document.statements.length === 1 ? "" : "s"
              }.`}
          </p>
        </button>

        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 text-xs">
            <span className="text-muted-foreground">Enforce</span>
            <Switch
              aria-label={`Enforce ${policy.name}`}
              checked={enforcing}
              disabled={disabled || !policy.enabled}
              onCheckedChange={(next) =>
                onToggleEnforcement(
                  next
                    ? PolicyEnforcementMode.ENFORCE
                    : PolicyEnforcementMode.MONITOR
                )
              }
            />
          </div>
          <div className="flex items-center gap-2 text-xs">
            <span className="text-muted-foreground">Enabled</span>
            <Switch
              aria-label={`Enable ${policy.name}`}
              checked={policy.enabled}
              disabled={disabled}
              onCheckedChange={onToggleEnabled}
            />
          </div>
          <Button
            disabled={disabled}
            onClick={onEdit}
            size="sm"
            variant="ghost"
          >
            Edit
          </Button>
          <Button
            disabled={disabled || policy.protected}
            onClick={onRemove}
            size="sm"
            variant="ghost"
          >
            Remove
          </Button>
        </div>
      </div>

      {expanded && children}
    </div>
  );
}

export function PoliciesSection(): React.ReactElement {
  const {
    policies,
    loading,
    saving,
    violations,
    warnings,
    create,
    update,
    remove,
    clearFeedback,
  } = usePolicies();
  // Reading policy is open to admins, changing it is not. Without this an
  // admin gets a working editor and finds out the server refuses only when
  // they press save, which reads as a broken page rather than a rule.
  const { isOwner, roleLoading } = useSettingsContext();
  const canEdit = isOwner && !roleLoading;

  const [editing, setEditing] = useState<OrganizationPolicySummary | null>(
    null
  );
  const [composing, setComposing] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [mode, setMode] = useState<EditorMode>("builder");
  const [fallbackReasons, setFallbackReasons] = useState<string[]>([]);
  const [draft, setDraft] = useState<PolicyDocument | null>(null);

  /**
   * The editor, wherever it belongs.
   *
   * Editing a policy renders this inside that policy's own card, because an
   * editor that opens somewhere else leaves the reader scrolling to find what
   * they just pressed Edit on. Composing a new one has no card to sit in, so it
   * gets its own.
   */
  const renderEditor = () =>
    mode === "builder" ? (
      <PolicyBuilder
        draft={draft}
        modeToggle={
          <EditorModeToggle
            builderDisabled={fallbackReasons.length > 0}
            mode={mode}
            onChange={setMode}
          />
        }
        onCancel={closeEditor}
        onDraftChange={setDraft}
        onSave={async (document) => {
          const ok = editing
            ? await update(editing.id, { document })
            : await create(document);
          if (ok) {
            closeEditor();
          }
        }}
        policy={editing}
        saving={saving}
        violations={violations}
        warnings={warnings}
      />
    ) : (
      <PolicyEditor
        draft={draft}
        fallbackReasons={fallbackReasons}
        modeToggle={
          <EditorModeToggle
            builderDisabled={fallbackReasons.length > 0}
            mode={mode}
            onChange={setMode}
          />
        }
        onCancel={closeEditor}
        onDraftChange={setDraft}
        onSave={async (document) => {
          const ok = editing
            ? await update(editing.id, { document })
            : await create(document);
          if (ok) {
            closeEditor();
          }
        }}
        policy={editing}
        saving={saving}
        violations={violations}
      />
    );

  const closeEditor = useCallback(() => {
    setEditing(null);
    setComposing(false);
    setFallbackReasons([]);
    setDraft(null);
    setMode("builder");
    clearFeedback();
  }, [clearFeedback]);

  /**
   * Open a stored policy, in the builder where it can be shown there.
   *
   * A statement the builder cannot render sends the author to the source
   * editor with the reason named, rather than refusing to open the policy or
   * silently dropping what it cannot draw.
   */
  const openForEdit = useCallback(
    (policy: OrganizationPolicySummary) => {
      clearFeedback();
      const reasons = policy.document.statements
        .map((statement) => unrepresentable(statement))
        .filter((reason): reason is UnrepresentableReason => reason !== null)
        .map((reason) => `${reason.sid}: ${reason.reason}`);
      setFallbackReasons(reasons);
      setMode(reasons.length > 0 ? "source" : "builder");
      setEditing(policy);
      // Open the card being edited, so the editor appears where it was asked
      // for rather than somewhere else on the page.
      setExpandedId(policy.id);
    },
    [clearFeedback]
  );

  return (
    <PolicyCatalogProvider>
      <SectionHeader
        description="Rules that bound what workflows, agents and members may do here. A policy claims a slice of activity; inside that slice nothing is permitted unless a statement permits it. Everything it does not claim is untouched."
        title="Policies"
      />

      <SettingsCard
        action={
          <Button
            disabled={saving || !canEdit}
            onClick={() => {
              clearFeedback();
              setComposing(true);
            }}
            size="sm"
          >
            New policy
          </Button>
        }
        description="A new policy starts in monitor mode: it records what it would have blocked without blocking anything. Turn enforcement on once the decisions look right."
        title="Policies"
      >
        {!(loading || roleLoading || canEdit) && (
          <Alert className="mb-3">
            <AlertDescription>
              You can read this organization's policies. Only the owner can
              change them.
            </AlertDescription>
          </Alert>
        )}
        {loading && <FormSkeleton rows={3} />}
        {!loading && policies.length === 0 && (
          <p className="text-muted-foreground text-sm">
            No policies yet. Without one, nothing here is governed and every
            action is allowed.
          </p>
        )}
        {!loading && policies.length > 0 && (
          <div className="flex flex-col gap-2">
            {policies.map((policy) => (
              <PolicyRow
                disabled={saving || !canEdit}
                expanded={expandedId === policy.id}
                key={policy.id}
                onEdit={() => openForEdit(policy)}
                onRemove={() => remove(policy.id)}
                onToggleEnabled={(next) => update(policy.id, { enabled: next })}
                onToggleEnforcement={(next) =>
                  update(policy.id, { enforcement: next })
                }
                onToggleExpanded={() =>
                  setExpandedId((current) =>
                    current === policy.id ? null : policy.id
                  )
                }
                policy={policy}
              >
                {editing?.id === policy.id ? (
                  renderEditor()
                ) : (
                  <PolicyOverview document={policy.document} />
                )}
              </PolicyRow>
            ))}
          </div>
        )}

        {warnings.length > 0 && (
          <Alert className="mt-3">
            <AlertDescription>
              {warnings.map((warning) => (
                <p key={warning}>{warning}</p>
              ))}
            </AlertDescription>
          </Alert>
        )}
      </SettingsCard>

      {composing && renderEditor()}

      <PolicySimulator />

      <PolicyDecisions />
    </PolicyCatalogProvider>
  );
}
