"use client";

import { Download, Upload } from "lucide-react";
import { useRouter } from "next/navigation";
import { type ChangeEvent, useCallback, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { api } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import {
  type WorkflowExportV1,
  workflowExportV1Schema,
} from "@/lib/workflow/export-schema";
import {
  type CodeStepDescriptor,
  findCodeStepsWithContent,
} from "@/lib/workflow/import-utils";

// SEC-01 client-side cap. Server enforces the same in app/api/workflows/import/route.ts.
const MAX_IMPORT_BYTES = 1_048_576;

type WorkflowIOOverlayProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called when the user clicks "Export JSON". Plan 42-08 wires this to actions.handleDownload. */
  onExport: () => void;
  isDownloading?: boolean;
  /** Optional success callback after import; otherwise router.push to the new workflow. */
  onImported?: (workflowId: string) => void;
};

export function WorkflowIOOverlay({
  open,
  onOpenChange,
  onExport,
  isDownloading,
  onImported,
}: WorkflowIOOverlayProps) {
  const router = useRouter();
  const [fileName, setFileName] = useState<string | null>(null);
  const [parsedFile, setParsedFile] = useState<WorkflowExportV1 | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [codeSteps, setCodeSteps] = useState<CodeStepDescriptor[]>([]);
  const [codeStepsConfirmed, setCodeStepsConfirmed] = useState(false);

  const resetImportState = useCallback(() => {
    setFileName(null);
    setParsedFile(null);
    setError(null);
    setCodeSteps([]);
    setCodeStepsConfirmed(false);
  }, []);

  // MODAL-05/MODAL-07: state reset on close (Escape, X, programmatic close).
  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next) {
        resetImportState();
      }
      onOpenChange(next);
    },
    [onOpenChange, resetImportState]
  );

  const handleFile = useCallback(async (file: File) => {
    setError(null);
    setFileName(file.name);
    setParsedFile(null);
    setCodeSteps([]);
    setCodeStepsConfirmed(false);

    // SEC-01: 1 MB client-side cap. Never call file.text() for oversize files.
    if (file.size > MAX_IMPORT_BYTES) {
      const mb = (file.size / 1_048_576).toFixed(2);
      setError(`File too large: ${mb} MB > 1 MB`);
      return;
    }

    try {
      const text = await file.text();
      const json = JSON.parse(text) as unknown;

      const result = workflowExportV1Schema.safeParse(json);
      if (!result.success) {
        const firstIssue = result.error.issues[0];
        const path = firstIssue?.path.join(".") || "(root)";
        setError(
          `Invalid workflow export at ${path}: ${firstIssue?.message ?? "validation failed"}`
        );
        return;
      }

      setParsedFile(result.data);
      // SEC-05: detect code steps and surface the gate
      const codeStepDescriptors = findCodeStepsWithContent(result.data);
      setCodeSteps(codeStepDescriptors);
    } catch (e) {
      setError(
        e instanceof Error
          ? `Could not read file: ${e.message}`
          : "Could not read file"
      );
    }
  }, []);

  const handleFileChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (file) {
        handleFile(file).catch(() => {
          /* handled inside handleFile */
        });
      }
    },
    [handleFile]
  );

  const importDisabled =
    !parsedFile ||
    submitting ||
    (codeSteps.length > 0 && !codeStepsConfirmed);

  // MODAL-06: submit ordering — import -> setSubmitting(false) -> toast -> close -> navigate
  const handleImport = useCallback(async () => {
    if (!parsedFile) {
      return;
    }
    setSubmitting(true);
    try {
      const created = await api.workflow.import(parsedFile);
      setSubmitting(false);
      toast.success("Workflow imported");
      onOpenChange(false);
      // Reset internal state explicitly here too (handleOpenChange also resets on next open).
      resetImportState();
      if (onImported) {
        onImported(created.id);
      } else {
        router.push(`/workflows/${created.id}`);
      }
    } catch (e) {
      setSubmitting(false);
      const msg = e instanceof Error ? e.message : "Failed to import workflow";
      setError(msg);
      toast.error(msg);
    }
  }, [parsedFile, onImported, onOpenChange, resetImportState, router]);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Workflow Import / Export</DialogTitle>
          <DialogDescription>
            Import a workflow from a JSON export, or export this workflow to
            share or back up.
          </DialogDescription>
        </DialogHeader>

        {/* IMPORT SECTION */}
        <section aria-labelledby="io-import-heading" className="space-y-4">
          <div className="flex items-center gap-2 text-muted-foreground">
            <Upload className="size-5" />
            <h3
              className="font-medium text-foreground"
              id="io-import-heading"
            >
              Import
            </h3>
          </div>

          {/* Inline error block lives at the TOP of the import section per CONTEXT
              error-display rule (size, schema, webhook rejections). */}
          {error && (
            <div
              className={cn(
                "rounded-md border border-destructive/40 bg-destructive/5 p-3 text-destructive text-sm"
              )}
              role="alert"
            >
              {error}
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="workflow-import-file">Workflow JSON file</Label>
            <Input
              accept="application/json,.json"
              id="workflow-import-file"
              onChange={handleFileChange}
              type="file"
            />
          </div>

          {fileName && !error && parsedFile && codeSteps.length === 0 && (
            <p className="text-muted-foreground text-sm">
              Selected:{" "}
              <span className="font-medium text-foreground">{fileName}</span>
              {parsedFile.integrationBindings.length > 0 && (
                <>
                  {". "}
                  {parsedFile.integrationBindings.length} integration
                  {parsedFile.integrationBindings.length === 1 ? "" : "s"} need
                  to be reconnected after import.
                </>
              )}
            </p>
          )}

          {/* SEC-05: code-step confirmation gate. Renders only when the parsed
              payload contains >= 1 code/run-code node with non-empty user code. */}
          {codeSteps.length > 0 && parsedFile && !error && (
            <div className="space-y-3 rounded-md border border-yellow-500/40 bg-yellow-500/5 p-3">
              <p className="font-medium text-foreground text-sm">
                This workflow contains {codeSteps.length} custom code step
                {codeSteps.length === 1 ? "" : "s"}. Review before importing:
              </p>
              <ul className="space-y-2">
                {codeSteps.map((step) => (
                  <li className="space-y-1" key={step.nodeId}>
                    <div className="font-medium text-foreground text-sm">
                      {step.label}
                    </div>
                    <pre className="overflow-x-auto rounded bg-muted p-2 font-mono text-xs">
                      {step.codePreview}
                      {step.codePreview.length === 80 ? "..." : ""}
                    </pre>
                  </li>
                ))}
              </ul>
              <Label className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={codeStepsConfirmed}
                  onCheckedChange={(v) => setCodeStepsConfirmed(v === true)}
                />
                I trust this code, import anyway
              </Label>
            </div>
          )}

          <div className="flex justify-end">
            <Button
              disabled={importDisabled}
              onClick={() => {
                handleImport().catch(() => {
                  /* handled inside handleImport */
                });
              }}
              type="button"
            >
              {submitting ? "Importing..." : "Import workflow"}
            </Button>
          </div>
        </section>

        <Separator />

        {/* EXPORT SECTION — UX lifted verbatim from the legacy export overlay. */}
        <section aria-labelledby="io-export-heading" className="space-y-4">
          <div className="flex items-center gap-2 text-muted-foreground">
            <Download className="size-5" />
            <h3
              className="font-medium text-foreground"
              id="io-export-heading"
            >
              Export
            </h3>
          </div>
          <p className="text-muted-foreground text-sm">
            Download this workflow as a JSON file you can re-import into
            another KeeperHub instance or share with your team.
          </p>
          <p className="text-muted-foreground text-sm">
            Credentials are not included in the export. Imported workflows
            preserve the structure of nodes and edges; you will need to
            reconnect any integrations after import.
          </p>
          <div className="flex justify-end">
            <Button
              disabled={isDownloading}
              onClick={() => {
                onExport();
                onOpenChange(false);
              }}
              type="button"
              variant="default"
            >
              {isDownloading ? "Exporting..." : "Export JSON"}
            </Button>
          </div>
        </section>
      </DialogContent>
    </Dialog>
  );
}
