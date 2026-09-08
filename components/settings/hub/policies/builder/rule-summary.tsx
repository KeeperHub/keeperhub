"use client";

import { Badge } from "@/components/ui/badge";
import { PolicyEffect } from "@/lib/policy";
import { describeStatement, type StatementFormValue } from "@/lib/policy/ui";

/**
 * What a rule does, and what it leaves out, without opening anything.
 *
 * An exception is otherwise visible only inside a dropdown or in the document,
 * and a rule that quietly excludes something is exactly the one a reader needs
 * to see at a glance. Exceptions are marked rather than blended in, because
 * "except two counterparties" changes what a rule means more than any other
 * clause in it.
 */
export function RuleSummary({
  value,
}: {
  value: StatementFormValue;
}): React.ReactElement {
  const summary = describeStatement(value);
  const exceptions = summary.clauses.filter((clause) => clause.exception);

  return (
    <div className="rounded-md border border-border bg-muted/40 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge
          variant={
            value.effect === PolicyEffect.DENY ? "destructive" : "secondary"
          }
        >
          {summary.verb}
        </Badge>
        <span className="text-sm">{summary.headline}</span>
      </div>

      {summary.clauses.length > 0 && (
        <ul className="mt-2 flex flex-col gap-1">
          {summary.clauses.map((clause) => (
            <li className="flex items-center gap-2 text-xs" key={clause.text}>
              {clause.exception ? (
                <Badge variant="outline">Exception</Badge>
              ) : (
                <span className="text-muted-foreground">and</span>
              )}
              <span
                className={
                  clause.exception ? "font-medium" : "text-muted-foreground"
                }
              >
                {clause.text}
              </span>
            </li>
          ))}
        </ul>
      )}

      {exceptions.length > 0 && value.effect === PolicyEffect.DENY && (
        <p className="mt-2 text-muted-foreground text-xs">
          What this refusal leaves out stays permitted only if some rule allows
          it. A permission written in another policy cannot reopen what this one
          refuses.
        </p>
      )}
    </div>
  );
}
