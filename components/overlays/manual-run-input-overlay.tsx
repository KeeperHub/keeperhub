"use client";

import { useMemo, useState } from "react";
import { Overlay } from "@/components/overlays/overlay";
import { useOverlay } from "@/components/overlays/overlay-provider";
import type { OverlayComponentProps } from "@/components/overlays/types";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  buildManualRunSample,
  type ManualRunInputSchema,
  validateManualRunInput,
} from "@/lib/workflow/editor/manual-run-input";

type ManualRunInputOverlayProps = OverlayComponentProps<{
  inputSchema: ManualRunInputSchema;
  /**
   * Starts the run with the collected input. Resolves true when the execution
   * was accepted; false leaves the overlay open so the author can retry without
   * retyping, for example after a rejection at the concurrency check.
   */
  onSubmit: (input: Record<string, unknown>) => Promise<boolean>;
}>;

/**
 * Collects the input a Manual-trigger workflow declares in its `inputSchema`,
 * before the editor's Run button starts the execution.
 *
 * The payload is the same object a listed workflow receives from an API or MCP
 * caller, so a run started here exercises the same `{{Manual.data.<field>}}`
 * references. The starting value is shaped from the schema (defaults, then
 * examples, then enums, then a type-appropriate empty) so the author edits
 * values rather than writing JSON from scratch.
 *
 * Per-field primitive inputs would be friendlier than one JSON textarea, and
 * are a reasonable follow-up; the schema-derived prefill removes most of the
 * downside of editing raw JSON, because the field names and shapes are already
 * correct and required fields are visible.
 */
export function ManualRunInputOverlay({
  overlayId,
  inputSchema,
  onSubmit,
}: ManualRunInputOverlayProps) {
  const { pop } = useOverlay();
  const initialValue = useMemo(
    () => JSON.stringify(buildManualRunSample(inputSchema), null, 2),
    [inputSchema]
  );
  const [value, setValue] = useState(initialValue);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (): Promise<void> => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      setError("Input must be valid JSON.");
      return;
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      setError("Input must be a JSON object.");
      return;
    }

    const errors = validateManualRunInput(
      inputSchema,
      parsed as Record<string, unknown>
    );
    if (errors.length > 0) {
      setError(errors.join(" "));
      return;
    }

    setSubmitting(true);
    try {
      const started = await onSubmit(parsed as Record<string, unknown>);
      // Only a run that actually started closes the prompt. Closing it on a
      // rejected start discarded the payload and made a retry a retype.
      if (started) {
        pop();
      }
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Failed to start the workflow."
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Overlay
      actions={[
        {
          label: "Cancel",
          onClick: pop,
          variant: "outline",
          disabled: submitting,
        },
        {
          label: "Run workflow",
          onClick: () => {
            handleSubmit().catch(() => {
              /* handleSubmit reports its own failures via setError */
            });
          },
          loading: submitting,
        },
      ]}
      description="The same input object a Marketplace caller supplies. A field the schema marks required has to be present; an optional one left out runs as undefined."
      overlayId={overlayId}
      title="Test workflow input"
    >
      <div className="space-y-2">
        <Label htmlFor="manual-run-input">Input JSON</Label>
        <Textarea
          aria-invalid={error ? true : undefined}
          className="min-h-64 font-mono text-sm"
          id="manual-run-input"
          onChange={(event) => {
            setValue(event.target.value);
            setError(null);
          }}
          value={value}
        />
        {error && (
          <p className="text-destructive text-sm" role="alert">
            {error}
          </p>
        )}
      </div>
    </Overlay>
  );
}
