"use client";

import { useMemo, useState } from "react";
import { Overlay } from "@/components/overlays/overlay";
import { useOverlay } from "@/components/overlays/overlay-provider";
import type { OverlayComponentProps } from "@/components/overlays/types";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  buildManualRunSample,
  validateManualRunInput,
} from "@/lib/workflow/editor/manual-run-input";

type ManualRunInputOverlayProps = OverlayComponentProps<{
  inputSchema: Record<string, unknown>;
  onSubmit: (input: Record<string, unknown>) => void | Promise<void>;
}>;

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

  const handleSubmit = async () => {
    try {
      const input = JSON.parse(value) as unknown;
      if (!input || typeof input !== "object" || Array.isArray(input)) {
        setError("Input must be a JSON object.");
        return;
      }
      const errors = validateManualRunInput(
        inputSchema,
        input as Record<string, unknown>
      );
      if (errors.length > 0) {
        setError(errors.join(" "));
        return;
      }
      await onSubmit(input as Record<string, unknown>);
      pop();
    } catch {
      setError("Input must be valid JSON.");
    }
  };

  return (
    <Overlay
      actions={[
        { label: "Cancel", onClick: pop, variant: "outline" },
        { label: "Run workflow", onClick: handleSubmit },
      ]}
      description="Provide the same input object exposed to Marketplace callers."
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
