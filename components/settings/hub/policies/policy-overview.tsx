"use client";

import { ExternalLink } from "lucide-react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { unrepresentable } from "@/lib/policy/catalog";
import type { PolicyDocument } from "@/lib/policy/types";
import { initialStatements } from "@/lib/policy/ui";
import { resourceLink } from "@/lib/policy/ui/resource-link";
import { useSettingsContext } from "../settings-context";
import { RuleSummary } from "./builder/rule-summary";

/**
 * What a policy says, without opening the editor.
 *
 * Reading a rule used to mean pressing Edit, which is a strange thing to ask of
 * someone who only wants to know what governs them, and impossible for an admin
 * who is not allowed to edit at all. This is the same description the builder
 * shows while a rule is being written, so the two cannot drift.
 */
/**
 * An identifier, as a link where the platform has a page for the thing.
 *
 * A rule names what it governs by identifier, which leaves a reader holding an
 * opaque string. Where there is somewhere to go, this makes it one click rather
 * than a search; where there is not, it stays plain text rather than becoming a
 * link that goes nowhere.
 */
function Identifier({
  value,
  organizationId,
}: {
  value: string;
  organizationId: string | null;
}): React.ReactElement {
  const link = resourceLink(value, organizationId);
  if (!link) {
    return <code className="text-xs">{value}</code>;
  }
  if (link.external) {
    return (
      <a
        className="inline-flex items-center gap-1 underline underline-offset-2 hover:text-foreground"
        href={link.href}
        rel="noopener"
        target="_blank"
      >
        <code className="text-xs">{value}</code>
        <ExternalLink aria-hidden="true" className="size-3" />
      </a>
    );
  }
  return (
    <Link
      className="underline underline-offset-2 hover:text-foreground"
      href={link.href}
    >
      <code className="text-xs">{value}</code>
    </Link>
  );
}

export function PolicyOverview({
  document,
}: {
  document: PolicyDocument;
}): React.ReactElement {
  const { organizationId } = useSettingsContext();
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
              <Identifier organizationId={organizationId} value={scope} />
            </Badge>
          ))}
        </div>
        <p className="text-muted-foreground text-xs">
          Anything outside this is untouched. Inside it, nothing is permitted
          unless a rule below permits it.
        </p>
      </div>

      {document.statements.some(
        (statement) => (statement.resource ?? []).length > 0
      ) && (
        <div className="flex flex-col gap-1">
          <span className="font-medium text-xs">What it names</span>
          <div className="flex flex-wrap gap-2">
            {[
              ...new Set(
                document.statements.flatMap(
                  (statement) => statement.resource ?? []
                )
              ),
            ].map((identifier) => (
              <Identifier
                key={identifier}
                organizationId={organizationId}
                value={identifier}
              />
            ))}
          </div>
        </div>
      )}

      <div className="flex flex-col gap-2">
        <span className="font-medium text-xs">
          {rules.length === 1 ? "Its rule" : `Its ${rules.length} rules`}
        </span>
        {rules.map((rule) => (
          <RuleSummary key={rule.sid} value={rule} />
        ))}
      </div>

      <details className="group">
        <summary className="cursor-pointer text-muted-foreground text-xs hover:text-foreground">
          The document itself
        </summary>
        <pre className="mt-2 max-h-80 overflow-auto rounded-md border border-border bg-muted/40 p-3 text-xs">
          <code>{JSON.stringify(document, null, 2)}</code>
        </pre>
      </details>

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
