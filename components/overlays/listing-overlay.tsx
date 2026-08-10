"use client";

import { Store } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Overlay } from "@/components/overlays/overlay";
import { useOverlay } from "@/components/overlays/overlay-provider";
import type { OverlayComponentProps } from "@/components/overlays/types";
import { OutputMappingSelector } from "@/components/workflow/config/output-mapping-selector";
import {
  SchemaBuilder,
  type SchemaField,
} from "@/components/workflow/config/schema-builder";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api, ApiError } from "@/lib/api-client";
import { canShareExecutionStatus } from "@/lib/workflow/share-execution-status";
import type {
  WorkflowNode,
  WorkflowVisibility,
} from "@/lib/workflow/store";
import { ConfirmOverlay } from "./confirm-overlay";

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

function toKebabSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

function fieldsToJsonSchema(fields: SchemaField[]): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const field of fields) {
    const prop: Record<string, unknown> = { type: field.type };

    if (field.description) {
      prop.description = field.description;
    }

    if (field.type === "array" && field.itemType) {
      prop.items = { type: field.itemType };
    }

    const hasNestedFields =
      field.type === "object" ||
      (field.type === "array" && field.itemType === "object");

    if (hasNestedFields && field.fields?.length) {
      const nested = fieldsToJsonSchema(field.fields);
      if (field.type === "object") {
        prop.properties = (nested as Record<string, unknown>).properties;
        if ((nested as Record<string, unknown>).required) {
          prop.required = (nested as Record<string, unknown>).required;
        }
      } else {
        prop.items = nested;
      }
    }

    properties[field.name] = prop;

    if (field.required) {
      required.push(field.name);
    }
  }

  const schema: Record<string, unknown> = { type: "object", properties };
  if (required.length > 0) {
    schema.required = required;
  }
  return schema;
}

function parseSchemaToFields(schema: Record<string, unknown>): SchemaField[] {
  const properties = schema.properties as Record<string, unknown> | undefined;
  if (!properties) {
    return [];
  }

  const requiredNames = Array.isArray(schema.required)
    ? (schema.required as string[])
    : [];

  const fields: SchemaField[] = [];

  for (const [name, rawProp] of Object.entries(properties)) {
    const prop = rawProp as Record<string, unknown>;
    const field: SchemaField = {
      name,
      type: (prop.type as SchemaField["type"]) ?? "string",
      description: typeof prop.description === "string" ? prop.description : undefined,
      required: requiredNames.includes(name),
    };

    if (field.type === "array" && prop.items) {
      const items = prop.items as Record<string, unknown>;
      if (items.type && items.type !== "object") {
        field.itemType = items.type as SchemaField["itemType"];
      } else if (items.type === "object") {
        field.itemType = "object";
        field.fields = parseSchemaToFields(items);
      }
    }

    if (field.type === "object" && prop.properties) {
      field.fields = parseSchemaToFields(prop as Record<string, unknown>);
    }

    fields.push(field);
  }

  return fields;
}

function parseOutputMapping(
  mapping: Record<string, unknown>
): { nodeId: string; field: string } | null {
  if (
    typeof mapping.nodeId === "string" &&
    typeof mapping.field === "string"
  ) {
    return { nodeId: mapping.nodeId, field: mapping.field };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Input-schema reference check
// ---------------------------------------------------------------------------

function collectConfigStrings(value: unknown, out: string[]): void {
  if (typeof value === "string") {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectConfigStrings(item, out);
    }
    return;
  }
  if (value && typeof value === "object") {
    for (const v of Object.values(value)) {
      collectConfigStrings(v, out);
    }
  }
}

function escapeForRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Matches the template patterns resolved by the executor (see
// lib/workflow-executor.workflow.ts processTemplates): both stored
// {{@nodeId:Label.field}} and display {{Label.field}} forms.
function fieldIsReferencedInConfigs(
  fieldName: string,
  nodes: WorkflowNode[]
): boolean {
  const pattern = new RegExp(
    `\\{\\{[^}]*\\b${escapeForRegex(fieldName)}\\b[^}]*\\}\\}`
  );
  const strings: string[] = [];
  for (const node of nodes) {
    if (node.data.config) {
      collectConfigStrings(node.data.config, strings);
    }
  }
  return strings.some((s) => pattern.test(s));
}

function findUnreferencedRequiredInputs(
  fields: SchemaField[],
  nodes: WorkflowNode[]
): string[] {
  return fields
    .filter((f) => f.required && f.name)
    .map((f) => f.name)
    .filter((name) => !fieldIsReferencedInConfigs(name, nodes));
}

function getTriggerLabel(nodes: WorkflowNode[]): string {
  const trigger = nodes.find((n) => n.data.type === "trigger");
  if (!trigger) {
    return "Manual";
  }
  if (trigger.data.label) {
    return trigger.data.label;
  }
  const configured = trigger.data.config?.triggerType;
  return typeof configured === "string" ? configured : "Manual";
}

function hasChanges(
  local: {
    isListed: boolean;
    slug: string;
    price: string;
    inputSchema: SchemaField[];
    outputMapping: { nodeId: string; field: string } | null;
    shareExecutionStatus: boolean;
  },
  existing: {
    existingIsListed: boolean;
    existingSlug: string | null;
    existingPrice: string | null;
    existingInputSchema: Record<string, unknown> | null;
    existingOutputMapping: Record<string, unknown> | null;
    existingShareExecutionStatus: boolean;
  },
  workflowName: string
): boolean {
  const defaultSlug = toKebabSlug(workflowName);

  if (local.isListed !== existing.existingIsListed) return true;
  if (local.slug !== (existing.existingSlug ?? defaultSlug)) return true;
  if (local.price !== (existing.existingPrice ?? "0")) return true;

  const existingFields = existing.existingInputSchema
    ? parseSchemaToFields(existing.existingInputSchema)
    : [];
  if (JSON.stringify(local.inputSchema) !== JSON.stringify(existingFields)) {
    return true;
  }

  const existingMapping = existing.existingOutputMapping
    ? parseOutputMapping(existing.existingOutputMapping)
    : null;
  if (JSON.stringify(local.outputMapping) !== JSON.stringify(existingMapping)) {
    return true;
  }

  if (local.shareExecutionStatus !== existing.existingShareExecutionStatus) {
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function validateSlug(
  slug: string,
  isListed: boolean
): string | null {
  if (isListed && !slug) {
    return "Slug is required to list this workflow.";
  }
  if (slug && !SLUG_PATTERN.test(slug)) {
    return "Slug must be lowercase letters, numbers, and hyphens only.";
  }
  if (slug.length > 60) {
    return "Slug must be 60 characters or fewer.";
  }
  return null;
}

function validatePrice(price: string): string | null {
  const num = Number(price);
  if (Number.isNaN(num) || num < 0) {
    return "Price must be 0 or greater.";
  }
  const decimalPart = price.split(".")[1];
  if (decimalPart && decimalPart.length > 2) {
    return "Price must have at most 2 decimal places.";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

type ListingOverlayProps = OverlayComponentProps<{
  workflowId: string;
  workflowName: string;
  nodes: WorkflowNode[];
  existingIsListed: boolean;
  existingSlug: string | null;
  existingListedAt: string | null;
  existingInputSchema: Record<string, unknown> | null;
  existingOutputMapping: Record<string, unknown> | null;
  existingPrice: string | null;
  existingShareExecutionStatus: boolean;
  existingVisibility: WorkflowVisibility;
  onSave: (data: {
    isListed: boolean;
    listedSlug: string | null;
    inputSchema: Record<string, unknown> | null;
    outputMapping: Record<string, unknown> | null;
    priceUsdcPerCall: string | null;
    shareExecutionStatus: boolean;
  }) => void;
}>;

export function ListingOverlay({
  overlayId,
  workflowId,
  workflowName,
  nodes,
  existingIsListed,
  existingSlug,
  existingListedAt,
  existingInputSchema,
  existingOutputMapping,
  existingPrice,
  existingShareExecutionStatus,
  existingVisibility,
  onSave,
}: ListingOverlayProps) {
  const { closeAll, push } = useOverlay();

  const [localIsListed, setLocalIsListed] = useState(existingIsListed);
  const [localSlug, setLocalSlug] = useState(
    existingSlug ?? toKebabSlug(workflowName)
  );
  const [localPrice, setLocalPrice] = useState(
    existingPrice != null ? String(existingPrice) : "0"
  );
  const [localInputSchema, setLocalInputSchema] = useState<SchemaField[]>(
    existingInputSchema ? parseSchemaToFields(existingInputSchema) : []
  );
  const [localOutputMapping, setLocalOutputMapping] = useState<{
    nodeId: string;
    field: string;
  } | null>(
    existingOutputMapping ? parseOutputMapping(existingOutputMapping) : null
  );
  // Shown as off, and saved as off, whenever visibility cannot support it -
  // both because a toggle reading "on" over links that 404 is the lie this
  // gate removes, and because the server now refuses a `true` on a private
  // workflow, so echoing a stale one back would 422 an unrelated edit. Saving
  // clears the stale flag on rows that predate the gate.
  const [localShareExecutionStatus, setLocalShareExecutionStatus] = useState(
    existingShareExecutionStatus && canShareExecutionStatus(existingVisibility)
  );
  const [isSaving, setIsSaving] = useState(false);

  const slugError = validateSlug(localSlug, localIsListed);
  const priceError = validatePrice(localPrice);
  const isSlugImmutable = existingSlug !== null && existingListedAt !== null;
  // The server gate for shared execution links is visibility, not listing
  // (lib/workflow/share-execution-status.ts::canShareExecutionStatus), and
  // visibility is set elsewhere (the go-live flow), never by this overlay.
  // Offering the toggle on a private workflow persisted the flag and returned
  // a success toast for links that then 404 for every recipient.
  const isPubliclyVisible = canShareExecutionStatus(existingVisibility);

  const changed = hasChanges(
    {
      isListed: localIsListed,
      slug: localSlug,
      price: localPrice,
      inputSchema: localInputSchema,
      outputMapping: localOutputMapping,
      shareExecutionStatus: localShareExecutionStatus,
    },
    {
      existingIsListed,
      existingSlug,
      existingPrice,
      existingInputSchema,
      existingOutputMapping,
      existingShareExecutionStatus,
    },
    workflowName
  );

  const isFormValid = !slugError && !priceError;
  const isSaveDisabled = isSaving || !changed || !isFormValid;

  const isGoingLive = localIsListed && !existingIsListed;
  const saveCta = isGoingLive ? "List Workflow" : "Save Settings";

  const performSave = async (overrides?: {
    isListed?: boolean;
  }): Promise<void> => {
    const effectiveIsListed = overrides?.isListed ?? localIsListed;

    if (effectiveIsListed && localInputSchema.length > 0) {
      const unreferenced = findUnreferencedRequiredInputs(
        localInputSchema,
        nodes
      );
      if (unreferenced.length > 0) {
        const triggerLabel = getTriggerLabel(nodes);
        const [firstField] = unreferenced;
        const suffix =
          unreferenced.length > 1
            ? ` (and ${unreferenced.length - 1} more)`
            : "";
        toast.error(
          `Input "${firstField}"${suffix} is declared but not referenced by any node. In a node field, type @ and select ${triggerLabel}.data.${firstField}.`
        );
        return;
      }
    }

    setIsSaving(true);
    try {
      const schema =
        localInputSchema.length > 0
          ? fieldsToJsonSchema(localInputSchema)
          : null;
      const mapping = localOutputMapping
        ? { nodeId: localOutputMapping.nodeId, field: localOutputMapping.field }
        : null;

      const updated = await api.workflow.update(workflowId, {
        isListed: effectiveIsListed,
        listedSlug: localSlug || null,
        inputSchema: schema,
        outputMapping: mapping,
        priceUsdcPerCall: localPrice || null,
        shareExecutionStatus: localShareExecutionStatus,
      });

      closeAll();
      setTimeout(() => {
        onSave({
          isListed: updated.isListed ?? effectiveIsListed,
          listedSlug: updated.listedSlug ?? (localSlug || null),
          inputSchema: updated.inputSchema ?? schema,
          outputMapping: updated.outputMapping ?? mapping,
          priceUsdcPerCall: updated.priceUsdcPerCall ?? (localPrice || null),
          // Server clears this on unlist; never echo stale local true.
          shareExecutionStatus: updated.shareExecutionStatus ?? false,
        });
      }, 250);

      const successMessage =
        effectiveIsListed && !existingIsListed
          ? "Workflow listed successfully"
          : existingIsListed && !effectiveIsListed
            ? "Workflow unlisted"
            : "Listing settings saved";

      toast.success(successMessage);
    } catch (error) {
      const message =
        error instanceof ApiError
          ? error.message
          : "Failed to save listing settings. Please try again.";
      toast.error(message);
    } finally {
      setIsSaving(false);
    }
  };

  const handleSave = (): void => {
    if (isGoingLive && existingSlug === null) {
      push(ConfirmOverlay, {
        title: "Set workflow slug",
        message: `Once listed, the slug "${localSlug}" cannot be changed. Agents will use it to call this workflow permanently. Continue?`,
        confirmLabel: "Confirm and List",
        cancelLabel: "Go Back",
        onConfirm: performSave,
      });
      return;
    }
    void performSave();
  };

  const handleToggleListed = (checked: boolean): void => {
    if (!checked && existingIsListed) {
      push(ConfirmOverlay, {
        title: "Unlist workflow",
        message:
          "This workflow will no longer be callable by agents. Your slug and configuration are preserved. You can re-list at any time.",
        confirmLabel: "Unlist",
        cancelLabel: "Go Back",
        confirmVariant: "destructive" as const,
        destructive: true,
        onConfirm: () => {
          closeAll();
          setLocalIsListed(false);
          void performSave({ isListed: false });
        },
      });
      return;
    }
    setLocalIsListed(checked);
  };

  return (
    <Overlay
      actions={[
        { label: "Close", variant: "outline", onClick: closeAll },
        {
          label: saveCta,
          onClick: handleSave,
          disabled: isSaveDisabled,
        },
      ]}
      overlayId={overlayId}
      title="Listing Settings"
    >
      <Tabs className="w-full" defaultValue="overview">
        <TabsList className="mb-4 w-full">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="input-schema">Input Schema</TabsTrigger>
          <TabsTrigger value="output-mapping">Output Mapping</TabsTrigger>
        </TabsList>

        {/* Fixed height prevents modal jumping between tabs; scroll if content overflows */}
        <div className="h-[500px] overflow-y-auto">
        {/* Overview Tab */}
        <TabsContent className="space-y-6" value="overview">
          {/* Info banner */}
          <div className="flex items-start gap-2 rounded-md border border-border/40 bg-muted/30 px-3 py-2">
            <Store className="mt-1 size-4 shrink-0 text-muted-foreground" />
            <p className="text-muted-foreground text-sm">
              Listed workflows are discoverable by AI agents via the{" "}
              <a
                className="underline"
                href="https://eips.ethereum.org/EIPS/eip-8004"
                rel="noopener"
                target="_blank"
              >
                ERC-8004
              </a>{" "}
              registry. Agents can search for, pay for, and call your workflow as
              an automated service. Your credentials and node graph remain
              private.
            </p>
          </div>

          {/* List / Unlist toggle */}
          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="list-toggle">List this workflow</Label>
              <p className="text-muted-foreground text-xs">
                Make it callable by AI agents
              </p>
            </div>
            <Switch
              aria-label="List this workflow"
              checked={localIsListed}
              id="list-toggle"
              onCheckedChange={handleToggleListed}
            />
          </div>

          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="share-execution-status">
                Share execution status publicly
              </Label>
              <p className="text-muted-foreground text-xs">
                {isPubliclyVisible
                  ? "Allow anyone with the link to view run progress"
                  : "Set this workflow's visibility to public or unlisted first - while it is private, shared run links return not found"}
              </p>
            </div>
            <Switch
              aria-label="Share execution status publicly"
              checked={localShareExecutionStatus}
              disabled={!(localIsListed && isPubliclyVisible)}
              id="share-execution-status"
              onCheckedChange={setLocalShareExecutionStatus}
            />
          </div>

          {/* Slug field */}
          <div className="space-y-2">
            <Label htmlFor="workflow-slug">Workflow slug</Label>
            <div className="flex items-center gap-2">
              <Input
                className="font-mono text-sm"
                disabled={isSlugImmutable}
                id="workflow-slug"
                onChange={(e) => setLocalSlug(e.target.value)}
                placeholder="my-workflow-slug"
                value={localSlug}
              />
            </div>
            {slugError && (
              <p className="mt-1 text-destructive text-xs">{slugError}</p>
            )}
            <p className="text-muted-foreground text-xs">
              {isSlugImmutable
                ? "This slug is permanent. Changing it would break existing agent integrations."
                : "Used by agents to call this workflow. Cannot be changed after first listing."}
            </p>
          </div>

          {/* Price field */}
          <div className="space-y-2">
            <Label htmlFor="workflow-price">Price per call (USDC)</Label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">
                $
              </span>
              <Input
                className="pl-7"
                id="workflow-price"
                min="0"
                onChange={(e) => setLocalPrice(e.target.value)}
                placeholder="0.00"
                step="0.01"
                type="number"
                value={localPrice}
              />
            </div>
            {priceError && (
              <p className="mt-1 text-destructive text-xs">{priceError}</p>
            )}
            <p className="text-muted-foreground text-xs">
              Set to 0 for free access. Agents pay per invocation in USDC on
              Base.
            </p>
          </div>
        </TabsContent>

        {/* Input Schema Tab */}
        <TabsContent className="space-y-4" value="input-schema">
          <div className="flex items-start gap-2 rounded-md border border-border/40 bg-muted/30 px-3 py-2">
            <Store className="mt-1 size-4 shrink-0 text-muted-foreground" />
            <p className="text-muted-foreground text-sm">
              Define the fields that AI agents must provide when calling your
              workflow. For example, a contract address or chain ID.
            </p>
          </div>
          <SchemaBuilder
            onChange={setLocalInputSchema}
            schema={localInputSchema}
          />
          {localInputSchema.length > 0 && (
            <p className="px-1 text-muted-foreground text-xs">
              Reference each input in a node field: type{" "}
              <code className="rounded bg-muted px-1">@</code> and select{" "}
              <code className="rounded bg-muted px-1">
                {getTriggerLabel(nodes)}.data.{"<fieldName>"}
              </code>
              .
            </p>
          )}
        </TabsContent>

        {/* Output Mapping Tab */}
        <TabsContent className="space-y-4" value="output-mapping">
          <div className="flex items-start gap-2 rounded-md border border-border/40 bg-muted/30 px-3 py-2">
            <Store className="mt-1 size-4 shrink-0 text-muted-foreground" />
            <p className="text-muted-foreground text-sm">
              Choose which action node's output is returned to the calling agent.
              For example, if your workflow ends with an "Assess Risk" node,
              select it and pick the fields agents should receive (e.g.
              riskScore, recommendation).
            </p>
          </div>
          <OutputMappingSelector
            nodes={nodes}
            onChange={setLocalOutputMapping}
            value={localOutputMapping}
          />
        </TabsContent>
        </div>
      </Tabs>
    </Overlay>
  );
}
