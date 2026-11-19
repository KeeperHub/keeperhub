"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ConditionQueryBuilder } from "@/components/workflow/condition-query-builder";
import { Label } from "@/components/ui/label";
import { TemplateBadgeInput } from "@/components/ui/template-badge-input";
import type { ConditionGroup } from "@/lib/workflow/nodes/condition/builder-types";
import {
  countRegexRules,
  createEmptyGroup,
  editorConditionState,
  visualConditionToExpression,
} from "@/lib/workflow/nodes/condition/builder-utils";
import { resolveConditionExpression } from "@/lib/workflow/nodes/condition/resolver";
import {
  validateConditionExpressionUI,
  visualConditionLimitError,
} from "@/lib/workflow/nodes/condition/validator";

/** Condition fields: the visual rule builder and the expression mode toggle. */
export function ConditionFields({
  config,
  onUpdateConfig,
  disabled,
}: {
  config: Record<string, unknown>;
  onUpdateConfig: (key: string, value: string | boolean | Record<string, unknown> | undefined) => void;
  disabled: boolean;
}) {
  const conditionValue =
    resolveConditionExpression(config ?? {}) ?? "";
  const existingConditionConfig = config?.conditionConfig as
    | { group: ConditionGroup }
    | undefined;

  // Rules for the condition text, when they rebuild it exactly, and the mode
  // to open in (editorConditionState).
  const { parsedGroup, initialMode } = useMemo(
    () => editorConditionState(conditionValue, existingConditionConfig?.group),
    [conditionValue, existingConditionConfig]
  );

  const [mode, setMode] = useState<"visual" | "expression">(initialMode);

  // Save parsed rules with the workflow while the rules are what is shown;
  // typing in Expression mode must not save rules for a half-typed text.
  const persistedForExpression = useRef<string | null>(null);
  useEffect(() => {
    if (
      mode === "visual" &&
      parsedGroup &&
      persistedForExpression.current !== conditionValue
    ) {
      onUpdateConfig("conditionConfig", { group: parsedGroup });
      persistedForExpression.current = conditionValue;
    }
  }, [mode, parsedGroup, conditionValue, onUpdateConfig]);

  const [validationError, setValidationError] = useState<string | null>(null);

  // Debounced validation for expression mode
  useEffect(() => {
    if (mode !== "expression" || !conditionValue.trim()) {
      setValidationError(null);
      return;
    }

    const timeoutId = setTimeout(() => {
      const result = validateConditionExpressionUI(conditionValue);
      setValidationError(result.valid ? null : result.error);
    }, 400);

    return () => clearTimeout(timeoutId);
  }, [conditionValue, mode]);

  const handleVisualChange = (group: ConditionGroup): void => {
    const expression = visualConditionToExpression(group);
    onUpdateConfig("conditionConfig", { group });
    onUpdateConfig("condition", expression);
  };

  // Switching modes keeps the saved rules, so switching back shows them; an
  // edit to the text clears them, since the text is then what runs.
  const handleModeSwitch = (newMode: "visual" | "expression"): void => {
    setMode(newMode);
  };

  const handleExpressionChange = (value: string): void => {
    if (existingConditionConfig) {
      onUpdateConfig("conditionConfig", undefined);
    }
    onUpdateConfig("condition", value);
  };

  // Text with no rules that rebuild it: the builder starts empty.
  const shownAsRules = Boolean(existingConditionConfig) || parsedGroup !== null;

  const emptyGroup = useMemo(() => createEmptyGroup(), []);
  const currentGroup =
    existingConditionConfig?.group ?? parsedGroup ?? emptyGroup;

  // Limits the rules can reach that would fail every run.
  const visualLimitError = useMemo(
    () =>
      mode === "visual"
        ? visualConditionLimitError(
            conditionValue,
            countRegexRules(currentGroup)
          )
        : undefined,
    [mode, conditionValue, currentGroup]
  );

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <Label>Condition</Label>
        <div className="flex gap-1 rounded-md border p-0.5">
          <button
            className={`rounded px-2 py-0.5 text-xs transition-colors ${
              mode === "visual"
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
            disabled={disabled}
            onClick={() => handleModeSwitch("visual")}
            type="button"
          >
            Visual
          </button>
          <button
            className={`rounded px-2 py-0.5 text-xs transition-colors ${
              mode === "expression"
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
            disabled={disabled}
            onClick={() => handleModeSwitch("expression")}
            type="button"
          >
            Expression
          </button>
        </div>
      </div>

      {mode === "visual" ? (
        <div className="space-y-3">
          {!shownAsRules && conditionValue.trim() && (
            <p className="text-muted-foreground text-xs">
              This condition can't be shown as rules without changing it.
              Changing a rule here replaces it; edit it in Expression mode to
              keep it.
            </p>
          )}
          <ConditionQueryBuilder
            disabled={disabled}
            group={currentGroup}
            onChange={handleVisualChange}
          />
          {/* Always mounted, so screen readers announce it once. */}
          <div aria-live="polite">
            {visualLimitError && (
              <p className="text-destructive text-xs">{visualLimitError}</p>
            )}
          </div>
          {conditionValue.trim() && (
            <div className="space-y-1">
              <Label className="text-muted-foreground text-xs">
                {shownAsRules ? "Generated expression" : "Current expression"}
              </Label>
              <pre className="bg-muted rounded-md p-2 text-xs break-all whitespace-pre-wrap">
                {conditionValue}
              </pre>
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          <TemplateBadgeInput
            disabled={disabled}
            id="condition"
            onChange={handleExpressionChange}
            placeholder="e.g., 5 > 3, status === 200, {{PreviousNode.value}} > 100"
            value={conditionValue}
          />
          {/* Always mounted, so screen readers announce an error once. */}
          <div aria-live="polite">
            {validationError && (
              <p className="text-xs text-yellow-600">{validationError}</p>
            )}
          </div>
          <p className="text-muted-foreground text-xs">
            Enter a JavaScript expression that evaluates to true or false. Use @
            to reference previous node outputs.
          </p>
          <p className="text-muted-foreground text-xs">
            Regex: matchesRegex(@field, &quot;^0x&quot;). Inside the quotes, type
            each backslash twice, e.g. &quot;^\\d+$&quot;.
          </p>
        </div>
      )}
    </div>
  );
}
