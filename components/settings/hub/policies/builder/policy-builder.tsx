"use client";

import { Plus } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { DEFAULT_POLICY_NAME, type PolicyDocument } from "@/lib/policy";
import type {
  OrganizationPolicySummary,
  PolicyViolation,
} from "../../hooks/use-policies";
import { SettingsCard } from "../../section";
import { useStatementBuilder } from "../hooks/use-statement-builder";
import { StatementCard } from "./statement-card";
import { ValidationPane } from "./validation-pane";

/**
 * Build a policy from real resources rather than by typing identifiers.
 *
 * Presentational. Every value it shows and every document it produces comes
 * from `useStatementBuilder`, so the same policy is derived one way whether it
 * is being edited here or read back from the text view.
 */
export function PolicyBuilder({
  policy,
  saving,
  violations,
  warnings,
  onSave,
  onCancel,
  modeToggle,
  onDraftChange,
  draft,
}: {
  policy: OrganizationPolicySummary | null;
  saving: boolean;
  violations: PolicyViolation[];
  warnings: string[];
  onSave: (document: PolicyDocument) => void;
  onCancel: () => void;
  /** Rendered in the card header, so it is clear what it switches. */
  modeToggle: React.ReactNode;
  /** Reports the document as it stands, so switching to text keeps the work. */
  onDraftChange: (document: PolicyDocument) => void;
  /** What the text editor last held, so switching back keeps that work too. */
  draft?: PolicyDocument | null;
}): React.ReactElement {
  const builder = useStatementBuilder({
    source: draft ?? policy?.document ?? null,
    onDocumentChange: onDraftChange,
  });

  const managed = builder.document.manages;

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
            onClick={() => onSave(builder.document)}
            size="sm"
          >
            {policy ? "Save changes" : "Create policy"}
          </Button>
        </div>
      }
      description="Pick a contract, pick the functions it may call, and set what it may move. New policies start in monitor mode: they record what they would have done without blocking anything."
      title={policy ? `Edit ${policy.name}` : "New policy"}
    >
      <div className="flex flex-col gap-5">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="policy-name">Name</Label>
            <Input
              id="policy-name"
              onChange={(e) => builder.setName(e.target.value)}
              placeholder={DEFAULT_POLICY_NAME}
              value={builder.name}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="policy-description">What it is for</Label>
            <Input
              id="policy-description"
              onChange={(e) => builder.setDescription(e.target.value)}
              placeholder="Bounds on the rebalancer"
              value={builder.description}
            />
          </div>
        </div>

        {managed.length > 0 && (
          <Alert>
            <AlertDescription>
              This policy takes control of {managed.length}{" "}
              {managed.length === 1 ? "area" : "areas"}. Inside{" "}
              {managed.length === 1 ? "it" : "them"}, anything you do not allow
              below is denied. Everything else the organization does is
              untouched.
            </AlertDescription>
          </Alert>
        )}

        {builder.statements.map((statement, index) => (
          <StatementCard
            index={index}
            key={statement.sid}
            onChange={(next) => builder.update(index, next)}
            onContractLoaded={builder.rememberContract}
            onRemove={() => builder.remove(index)}
            value={statement}
          />
        ))}

        <Button
          className="self-start"
          onClick={builder.add}
          size="sm"
          variant="outline"
        >
          <Plus className="size-4" />
          Add a rule
        </Button>

        <ValidationPane
          findings={builder.findings}
          violations={violations}
          warnings={warnings}
        />

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="policy-json">The document this produces</Label>
          <Textarea
            className="min-h-[14rem] font-mono text-xs"
            id="policy-json"
            readOnly
            spellCheck={false}
            value={JSON.stringify(builder.document, null, 2)}
          />
        </div>
      </div>
    </SettingsCard>
  );
}
