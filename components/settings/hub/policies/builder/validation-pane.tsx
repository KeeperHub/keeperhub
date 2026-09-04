"use client";

import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  type CompatibilityFinding,
  CompatibilitySeverity,
} from "@/lib/policy/catalog";
import type { PolicyViolation } from "../../hooks/use-policies";

export type ValidationEntry = {
  key: string;
  location: string | null;
  message: string;
};

function toEntries(
  findings: readonly CompatibilityFinding[],
  severity: CompatibilitySeverity
): ValidationEntry[] {
  return findings
    .filter((finding) => finding.severity === severity)
    .map((finding) => ({
      key: `${finding.sid}-${finding.code}-${finding.subject ?? ""}`,
      location: `${finding.sid} / ${finding.field}`,
      message: finding.message,
    }));
}

function EntryList({
  entries,
  empty,
}: {
  entries: ValidationEntry[];
  empty: string;
}): React.ReactElement {
  if (entries.length === 0) {
    return <p className="py-3 text-muted-foreground text-xs">{empty}</p>;
  }
  return (
    <ul className="flex flex-col divide-y divide-border">
      {entries.map((entry) => (
        <li className="py-2" key={entry.key}>
          {entry.location && (
            <p className="font-mono text-[0.7rem] text-muted-foreground">
              {entry.location}
            </p>
          )}
          <p className="text-xs">{entry.message}</p>
        </li>
      ))}
    </ul>
  );
}

/**
 * The count is always shown, including zero.
 *
 * Hiding a zero made three tabs look identical and inert: switching between
 * them appeared to do nothing, because nothing distinguished a tab with no
 * findings from one that was not working.
 */
function CountedTab({
  value,
  label,
  count,
}: {
  value: string;
  label: string;
  count: number;
}): React.ReactElement {
  return (
    <TabsTrigger value={value}>
      {label}
      <Badge className="ml-1.5" variant={count > 0 ? "secondary" : "outline"}>
        {count}
      </Badge>
    </TabsTrigger>
  );
}

/**
 * What is known about the document, split by what it means for saving.
 *
 * When nothing is wrong there is nothing to sort through, so the tabs are
 * replaced by a single line saying so. Three empty tabs read as a broken
 * control rather than as a clean bill of health.
 */
export function ValidationPane({
  findings,
  violations,
  warnings,
}: {
  findings: readonly CompatibilityFinding[];
  violations: readonly PolicyViolation[];
  warnings: readonly string[];
}): React.ReactElement {
  const errors: ValidationEntry[] = [
    ...toEntries(findings, CompatibilitySeverity.ERROR),
    ...violations.map((violation, index) => ({
      key: `violation-${index}-${violation.message}`,
      location: violation.sid ?? null,
      message: violation.message,
    })),
  ];
  const warningEntries: ValidationEntry[] = [
    ...toEntries(findings, CompatibilitySeverity.WARNING),
    ...warnings.map((warning, index) => ({
      key: `warning-${index}`,
      location: null,
      message: warning,
    })),
  ];
  const security = toEntries(findings, CompatibilitySeverity.SECURITY);
  const total = errors.length + warningEntries.length + security.length;

  if (total === 0) {
    return (
      <div className="rounded-lg border border-border p-3">
        <p className="font-medium text-sm">Nothing to flag</p>
        <p className="text-muted-foreground text-xs">
          Every rule selects something that exists, every condition and limit
          binds on it, and nothing grants more than it appears to. Checks appear
          here as you pick contracts and functions.
        </p>
      </div>
    );
  }

  return (
    <Tabs defaultValue={errors.length > 0 ? "errors" : "security"}>
      <TabsList>
        <CountedTab count={errors.length} label="Errors" value="errors" />
        <CountedTab
          count={warningEntries.length}
          label="Warnings"
          value="warnings"
        />
        <CountedTab count={security.length} label="Security" value="security" />
      </TabsList>

      <TabsContent value="errors">
        <EntryList
          empty="No rule is empty or impossible to satisfy. A rule that grants nothing at all would appear here and would stop the policy saving."
          entries={errors}
        />
      </TabsContent>
      <TabsContent value="warnings">
        <EntryList
          empty="Every condition and limit binds on something. A condition none of the selected functions expose would appear here."
          entries={warningEntries}
        />
      </TabsContent>
      <TabsContent value="security">
        <EntryList
          empty="Nothing here grants more than it appears to. A function that forwards arbitrary calls, or an allow with no limit on what it may move, would appear here."
          entries={security}
        />
      </TabsContent>
    </Tabs>
  );
}
