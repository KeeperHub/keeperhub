"use client";

import { useEffect, useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { WorkflowNode } from "@/lib/workflow/store";

const INTERNAL_CONFIG_KEYS = new Set([
  "actionType",
  "integrationId",
  "nodeId",
  "label",
]);

function getNodeOutputFields(node: WorkflowNode): string[] {
  const config = node.data.config;
  if (!config) {
    return [];
  }
  return Object.keys(config).filter((key) => !INTERNAL_CONFIG_KEYS.has(key));
}

type OutputMappingSelectorProps = {
  nodes: WorkflowNode[];
  value: { nodeId: string; field: string } | null;
  onChange: (mapping: { nodeId: string; field: string } | null) => void;
};

export function OutputMappingSelector({
  nodes,
  value,
  onChange,
}: OutputMappingSelectorProps) {
  const actionNodes = nodes.filter(
    (n) => n.data.type !== "trigger" && n.data.type !== "add"
  );

  const [freeTextField, setFreeTextField] = useState<string>(
    value?.field ?? ""
  );

  // Auto-select the last action node when no mapping exists. Runs in an effect
  // so we don't update the parent's state during this component's render.
  const [autoSelected, setAutoSelected] = useState(false);
  const lastActionNodeId = actionNodes.at(-1)?.id;
  useEffect(() => {
    if (autoSelected || value || !lastActionNodeId) {
      return;
    }
    onChange({ nodeId: lastActionNodeId, field: "" });
    setAutoSelected(true);
  }, [autoSelected, value, lastActionNodeId, onChange]);

  if (actionNodes.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        No action nodes in this workflow yet. Add action nodes to the canvas
        first, then return here to configure the output.
      </p>
    );
  }

  const selectedNode = value?.nodeId
    ? actionNodes.find((n) => n.id === value.nodeId) ?? null
    : null;

  const outputFields = selectedNode ? getNodeOutputFields(selectedNode) : [];
  const useFreeText = selectedNode !== null && outputFields.length === 0;

  const handleNodeChange = (nodeId: string) => {
    setFreeTextField("");
    onChange({ nodeId, field: "" });
  };

  const handleFieldChange = (field: string) => {
    if (!value?.nodeId) {
      return;
    }
    onChange({ nodeId: value.nodeId, field });
  };

  const handleFreeTextChange = (field: string) => {
    setFreeTextField(field);
    if (!value?.nodeId) {
      return;
    }
    onChange({ nodeId: value.nodeId, field });
  };

  const selectedNodeLabel =
    selectedNode?.data.label || "Unnamed Step";

  const previewLabel = selectedNode
    ? value?.field
      ? `${selectedNodeLabel}.${value.field}`
      : `${selectedNodeLabel} (entire output)`
    : null;

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="output-node-select">
          Response node <span className="text-destructive">*</span>
        </Label>
        <Select
          onValueChange={handleNodeChange}
          value={value?.nodeId ?? ""}
        >
          <SelectTrigger id="output-node-select">
            <SelectValue placeholder="Select a node" />
          </SelectTrigger>
          <SelectContent>
            {actionNodes.map((node) => (
              <SelectItem key={node.id} value={node.id}>
                {node.data.label || "Unnamed Step"}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-muted-foreground text-xs">
          The node whose output is returned to the calling agent.
        </p>
      </div>

      {selectedNode !== null && (
        <div className="space-y-2">
          <Label htmlFor="output-field-select">
            Filter to specific field{" "}
            <span className="text-muted-foreground font-normal">(optional)</span>
          </Label>
          {useFreeText ? (
            <Input
              id="output-field-select"
              onChange={(e) => handleFreeTextChange(e.target.value)}
              placeholder="e.g. riskScore"
              value={freeTextField}
            />
          ) : (
            <Select
              onValueChange={handleFieldChange}
              value={value?.field ?? ""}
            >
              <SelectTrigger id="output-field-select">
                <SelectValue placeholder="All fields (entire output)" />
              </SelectTrigger>
              <SelectContent>
                {outputFields.map((field) => (
                  <SelectItem key={field} value={field}>
                    {field}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <p className="text-muted-foreground text-xs">
            Leave empty to return the entire node output. Specify a field to
            return only that value.
          </p>
        </div>
      )}

      {previewLabel !== null && (
        <div className="rounded-md border border-border/40 bg-muted/30 p-4">
          <p className="text-muted-foreground text-xs">Agents will receive:</p>
          <span className="font-mono text-sm">{previewLabel}</span>
        </div>
      )}
    </div>
  );
}
