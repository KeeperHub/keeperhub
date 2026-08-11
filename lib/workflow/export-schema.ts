import { z } from "zod";
import type { WorkflowEdge, WorkflowNode } from "@/lib/workflow/store";

// SEC: Webhook URLs must use https only. Rejects http://, file://, javascript:, etc.
const HTTPS_URL_REGEX = /^https:\/\//;

export const WORKFLOW_EXPORT_VERSION = 1;

const positionSchema = z.object({
  x: z.number(),
  y: z.number(),
});

const nodeDataSchema = z
  .object({
    label: z.string().max(500),
    description: z.string().max(2000).optional(),
    // "add" is a UI placeholder node and must not appear in exports.
    type: z.enum(["trigger", "action"]),
    // CRITICAL: data.config keeps z.record(z.string(), z.unknown()) — plugin-specific keys must remain free.
    // .strict() lives ONLY on the outer envelope, not on config.
    config: z.record(z.string(), z.unknown()).optional(),
    status: z.enum(["idle", "running", "success", "error"]).optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

const exportNodeSchema = z
  .object({
    id: z.string().min(1),
    type: z.string(),
    position: positionSchema,
    data: nodeDataSchema,
  })
  .strict();

const exportEdgeSchema = z
  .object({
    id: z.string().min(1),
    source: z.string(),
    target: z.string(),
    type: z.string().optional(),
    sourceHandle: z.string().nullable().optional(),
    targetHandle: z.string().nullable().optional(),
    label: z.string().optional(),
    data: z.unknown().optional(),
  })
  .passthrough();

const integrationBindingSchema = z.object({
  nodeId: z.string().min(1),
  integrationType: z.string().min(1),
});

export const workflowExportV1Schema = z
  .object({
    version: z.literal(WORKFLOW_EXPORT_VERSION),
    exportedAt: z.string().datetime(),
    workflow: z.object({
      name: z.string().min(1).max(200),
      description: z.string().max(2000).optional(),
    }),
    nodes: z.array(exportNodeSchema).max(200),
    edges: z.array(exportEdgeSchema).max(500),
    integrationBindings: z.array(integrationBindingSchema),
  })
  .superRefine((value, ctx) => {
    const nodesById = new Map(value.nodes.map((n) => [n.id, n]));
    for (const [index, binding] of value.integrationBindings.entries()) {
      const node = nodesById.get(binding.nodeId);
      if (!node) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["integrationBindings", index, "nodeId"],
          message: `integrationBindings[${index}].nodeId "${binding.nodeId}" does not match any node in nodes[]`,
        });
        continue;
      }
      // If the bound node carries its own integrationType (it usually does
      // post-export), require the binding to agree. A divergence means the
      // file was hand-edited or built by a non-canonical exporter.
      const nodeConfig = node.data.config as
        | Record<string, unknown>
        | undefined;
      const nodeIntegrationType = nodeConfig?.integrationType;
      if (
        typeof nodeIntegrationType === "string" &&
        nodeIntegrationType !== binding.integrationType
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["integrationBindings", index, "integrationType"],
          message: `integrationBindings[${index}].integrationType "${binding.integrationType}" disagrees with node "${binding.nodeId}".data.config.integrationType "${nodeIntegrationType}"`,
        });
      }
    }
    // SEC: https-only webhook URL gate. Rejects http://, file://, javascript:, etc.
    for (const [index, node] of value.nodes.entries()) {
      const cfg = node.data.config as Record<string, unknown> | undefined;
      if (!cfg) {
        continue;
      }
      const webhookUrl = cfg.webhookUrl;
      if (typeof webhookUrl === "string" && !HTTPS_URL_REGEX.test(webhookUrl)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["nodes", index, "data", "config", "webhookUrl"],
          message: `Webhook URL must use https:// (received: ${webhookUrl.slice(0, 64)}...)`,
        });
      }
    }
  });

export type WorkflowExportV1 = z.infer<typeof workflowExportV1Schema>;
export type WorkflowExportIntegrationBinding = z.infer<
  typeof integrationBindingSchema
>;

const STRIPPED_CONFIG_KEYS = ["integrationId", "integrationConfig"] as const;

function stripIntegrationFromConfig(
  config: Record<string, unknown> | undefined
): {
  config: Record<string, unknown> | undefined;
  integrationType: string | undefined;
} {
  if (!config) {
    return { config, integrationType: undefined };
  }

  const integrationType =
    typeof config.integrationType === "string"
      ? config.integrationType
      : undefined;

  const stripped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if ((STRIPPED_CONFIG_KEYS as readonly string[]).includes(key)) {
      continue;
    }
    stripped[key] = value;
  }

  return { config: stripped, integrationType };
}

/**
 * Build a v1 export payload from a stored workflow record. Strips
 * `integrationId`/`integrationConfig` from action node configs and records
 * the integration type per node so an importer can re-bind credentials.
 */
export function buildWorkflowExportV1(workflow: {
  name: string;
  description: string | null;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}): WorkflowExportV1 {
  const integrationBindings: WorkflowExportIntegrationBinding[] = [];

  // "add" is a UI placeholder; never include it in the export.
  const persistedNodes = workflow.nodes.filter(
    (node) => node.data?.type !== "add"
  );

  const exportNodes = persistedNodes.map((node) => {
    const { config, integrationType } = stripIntegrationFromConfig(
      node.data?.config
    );

    if (integrationType && node.data?.type === "action") {
      integrationBindings.push({
        nodeId: node.id,
        integrationType,
      });
    }

    return {
      ...node,
      data: {
        ...node.data,
        ...(config === undefined ? {} : { config }),
      },
    };
  });

  // Drop edges that referenced the filtered placeholder nodes.
  const persistedNodeIds = new Set(persistedNodes.map((n) => n.id));
  const persistedEdges = workflow.edges.filter(
    (edge) =>
      persistedNodeIds.has(edge.source) && persistedNodeIds.has(edge.target)
  );

  return {
    version: WORKFLOW_EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    workflow: {
      name: workflow.name,
      // Preserve empty strings; only null/undefined collapse to "no description".
      ...(workflow.description == null
        ? {}
        : { description: workflow.description }),
    },
    nodes: exportNodes as WorkflowExportV1["nodes"],
    edges: persistedEdges as WorkflowExportV1["edges"],
    integrationBindings,
  };
}

/**
 * Sanitize node payload from an import: strip any `integrationId` that may
 * have leaked in, since they are not portable across instances/orgs. The
 * importing user re-binds integrations in the editor.
 */
export function stripIntegrationsFromImportNodes(
  nodes: WorkflowExportV1["nodes"]
): Record<string, unknown>[] {
  return nodes.map((node) => {
    const data = node.data as Record<string, unknown>;
    const config = data.config as Record<string, unknown> | undefined;
    const { config: cleanedConfig } = stripIntegrationFromConfig(config);

    return {
      ...node,
      data: {
        ...data,
        ...(cleanedConfig === undefined ? {} : { config: cleanedConfig }),
      },
    };
  });
}
