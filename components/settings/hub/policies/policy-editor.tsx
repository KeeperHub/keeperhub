"use client";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { PolicyDocument } from "@/lib/policy";
import type {
  OrganizationPolicySummary,
  PolicyViolation,
} from "../hooks/use-policies";
import { SettingsCard } from "../section";
import { usePolicySource } from "./hooks/use-policy-source";

/**
 * The policy as text.
 *
 * The document is the contract; the builder is a view onto it. Anything the
 * builder cannot draw is edited here, which is why this view never refuses to
 * open a policy.
 */
export function PolicyEditor({
  policy,
  saving,
  violations,
  onSave,
  onCancel,
  modeToggle,
  fallbackReasons,
  draft,
  onDraftChange,
}: {
  policy: OrganizationPolicySummary | null;
  saving: boolean;
  violations: PolicyViolation[];
  onSave: (document: PolicyDocument) => void;
  onCancel: () => void;
  /** Rendered in the card header, so it is clear what it switches. */
  modeToggle: React.ReactNode;
  /** Why the builder cannot show this policy, when that is why we are here. */
  fallbackReasons: readonly string[];
  /** The document the builder currently holds, so switching keeps the work. */
  draft?: PolicyDocument | null;
  /** Reports edits upward, so switching back to the builder keeps them. */
  onDraftChange: (document: PolicyDocument) => void;
}): React.ReactElement {
  const source = usePolicySource({
    initial: draft ?? policy?.document ?? null,
    onDraftChange,
  });

  return (
    <SettingsCard
      action={
        <div className="flex items-center gap-2">
          {modeToggle}
          <Button
            disabled={saving}
            onClick={onCancel}
            size="sm"
            variant="ghost"
          >
            Cancel
          </Button>
          <Button
            disabled={saving}
            onClick={() => source.submit(onSave)}
            size="sm"
          >
            {policy ? "Save changes" : "Create policy"}
          </Button>
        </div>
      }
      description="Statements are checked when you save. A rule that could never match, or a signal used to permit something rather than to refuse it, is rejected here rather than failing quietly later."
      title={policy ? `Edit ${policy.name}` : "New policy"}
    >
      {fallbackReasons.length > 0 && (
        <Alert className="mb-3">
          <AlertDescription>
            <p className="mb-1 font-medium">
              Shown as text, because the builder cannot draw every statement in
              this policy:
            </p>
            <ul>
              {fallbackReasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}

      <Textarea
        aria-label="Policy document"
        className="min-h-[22rem] font-mono text-xs"
        onChange={(e) => source.edit(e.target.value)}
        spellCheck={false}
        value={source.text}
      />

      {source.parseError && (
        <p className="mt-2 text-destructive text-xs">{source.parseError}</p>
      )}

      {violations.length > 0 && (
        <Alert className="mt-3 border-destructive/40 bg-destructive/5">
          <AlertDescription>
            <p className="mb-2 font-medium text-destructive">
              This document was not saved:
            </p>
            <ul className="flex flex-col gap-1">
              {violations.map((violation) => (
                <li
                  className="text-destructive"
                  key={`${violation.sid ?? "doc"}-${violation.message}`}
                >
                  {violation.sid ? `${violation.sid}: ` : ""}
                  {violation.message}
                </li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}
    </SettingsCard>
  );
}
