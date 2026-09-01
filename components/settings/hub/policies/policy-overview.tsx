"use client";

import { Badge } from "@/components/ui/badge";
import { unrepresentable } from "@/lib/policy/catalog";
import type { PolicyDocument } from "@/lib/policy/types";
import { initialStatements } from "@/lib/policy/ui";
import { RuleSummary } from "./builder/rule-summary";

/**
 * What a policy says, without opening the editor.
 *
 * Reading a rule used to mean pressing Edit, which is a strange thing to ask of
 * someone who only wants to know what governs them, and impossible for an admin
 * who is not allowed to edit at all. This is the same description the builder
 * shows while a rule is being written, so the two cannot drift.
 */
export function PolicyOverview({
  document,
}: {
  document: PolicyDocument;
}): React.ReactElement {
  const rules = initialStatements(document);
  const undrawable = document.statements.filter(
    (statement) => unrepresentable(statement) !== null
  );

  return (
    <div className="flex flex-col gap-3 border-border border-t pt-3">
      <div className="flex flex-col gap-1">
        <span className="font-medium text-xs">What this claims</span>
        <div className="flex flex-wrap gap-1">
          {document.manages.map((scope) => (
            <Badge key={scope} variant="outline">
              <code className="text-xs">{scope}</code>
            </Badge>
          ))}
        </div>
        <p className="text-muted-foreground text-xs">
          Anything outside this is untouched. Inside it, nothing is permitted
          unless a rule below permits it.
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <span className="font-medium text-xs">
          {rules.length === 1 ? "Its rule" : `Its ${rules.length} rules`}
        </span>
        {rules.map((rule) => (
          <RuleSummary key={rule.sid} value={rule} />
        ))}
      </div>

      {undrawable.length > 0 && (
        <p className="text-muted-foreground text-xs">
          {undrawable.length} rule{undrawable.length === 1 ? "" : "s"} cannot be
          summarised here and {undrawable.length === 1 ? "is" : "are"} only
          visible in the source view:{" "}
          {undrawable.map((statement) => statement.sid).join(", ")}.
        </p>
      )}
    </div>
  );
}
