import { api } from "@/lib/api-client";
import { buildWorkflow } from "@/lib/scan/factory";
import type { SuggestionDescriptor } from "@/lib/scan/suggestions/types";
import type { WorkflowNode } from "@/lib/workflow/store";

type CreateWorkflowResponse = { id: string };

/**
 * Prefill the recipient on email-alert nodes that have none.
 *
 * Every scan shape ends in a `sendgrid/send-email` node whose `emailTo` is
 * required by the plugin schema but left blank by the factory (no email is
 * known at anonymous scan time). Once the user is signed in we know their
 * address, so defaulting it here lets Run / Save-on-schedule pass config
 * validation instead of failing with "invalid config". Only blank recipients
 * are filled — a user-edited value is preserved.
 */
function applyDefaultEmail(
  nodes: WorkflowNode[],
  email: string | undefined
): WorkflowNode[] {
  if (!email) {
    return nodes;
  }
  return nodes.map((node) => {
    const config = node.data.config as Record<string, unknown> | undefined;
    if (
      config?.actionType === "sendgrid/send-email" &&
      (config.emailTo === "" || config.emailTo === undefined)
    ) {
      return {
        ...node,
        data: { ...node.data, config: { ...config, emailTo: email } },
      };
    }
    return node;
  });
}

/**
 * Shared persist sequence for scan suggestions.
 *
 * Re-derives the workflow through the factory (re-runs validateTemplateRefs +
 * MaxUint256 + approve-token guards). Cookie confirmInputs are never trusted
 * directly — the factory is the trust boundary (T-54-20).
 *
 * Steps:
 *   1. buildWorkflow(descriptor) — factory re-derivation
 *   2. POST /api/workflows/create  (enabled:true for schedule, false for run)
 *   3. PATCH /api/workflows/{id} with {nodes} — triggers syncWorkflowSchedule
 *      (schedule mode only)
 *   4. api.workflow.execute(id, {}) — immediate one-off run, "run" mode only.
 *      Schedule mode does NOT auto-run (UAT feedback): "Use this workflow"
 *      saves the monitor and lets its schedule fire it; the first run happens
 *      on the next scheduled tick or when the user runs it from the canvas.
 *
 * Returns { id } so the caller can navigate to /workflows/{id}.
 *
 * Consumed by PendingScanRunner (54-03) and the suggestion drawer (54-04).
 * FUNNEL-03.
 */
export async function persistSuggestion(
  descriptor: SuggestionDescriptor,
  mode: "run" | "schedule",
  options: { defaultEmail?: string } = {}
): Promise<{ id: string }> {
  const built = buildWorkflow(descriptor);
  const { name, description, edges } = built;
  const nodes = applyDefaultEmail(built.nodes, options.defaultEmail);

  // POST /api/workflows/create
  // enabled:true only for schedule mode; DB default is false (T-54-23 defensive)
  const createRes = await fetch("/api/workflows/create", {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      // Prometheus conversion label (keeperhub_workflows_created_total):
      // marks this create as originating from the scan funnel.
      "x-keeperhub-source": `scan-${mode}`,
    },
    body: JSON.stringify({
      name,
      description,
      nodes,
      edges,
      enabled: mode === "schedule",
    }),
  });

  if (!createRes.ok) {
    let errBody: { error?: string } = {};
    try {
      errBody = (await createRes.json()) as { error?: string };
    } catch {
      // ignore parse errors
    }
    throw new Error(errBody.error ?? "Failed to create workflow");
  }

  const created = (await createRes.json()) as CreateWorkflowResponse;
  const { id } = created;

  // PATCH triggers syncWorkflowSchedule server-side (schedule mode only)
  if (mode === "schedule") {
    const patchRes = await fetch(`/api/workflows/${id}`, {
      method: "PATCH",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nodes }),
    });

    if (!patchRes.ok) {
      let errBody: { error?: string } = {};
      try {
        errBody = (await patchRes.json()) as { error?: string };
      } catch {
        // ignore parse errors
      }
      throw new Error(errBody.error ?? "Failed to sync schedule");
    }
  }

  // Immediate one-off execution only for explicit "run" mode. Schedule mode
  // deliberately does NOT auto-run (UAT feedback superseding FUNNEL-04):
  // "Use this workflow" saves the enabled monitor and its schedule fires it.
  if (mode === "run") {
    await api.workflow.execute(id, {});
  }

  return { id };
}
