import { api, type SavedWorkflow } from "@/lib/api-client";
import { authClient } from "@/lib/auth-client";
import { latestVisibleWorkflow } from "@/lib/workflow/latest-workflow";

type StartedWorkflow = {
  id: string;
  // False when an anonymous visitor already has their one workflow, which
  // `id` then names instead of a new one.
  created: boolean;
};

/**
 * What New Workflow does before it shows a workflow: an empty workflow
 * outside any project. Anonymous visitors get a session first and are capped
 * at one workflow, so with one already they are sent to it.
 */
export async function startNewWorkflow({
  isAnonymous,
  hasSession,
}: {
  isAnonymous: boolean;
  hasSession: boolean;
}): Promise<StartedWorkflow> {
  if (isAnonymous) {
    if (!hasSession) {
      await authClient.signIn.anonymous();
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const existing = await api.workflow
      .getAll()
      .catch(() => [] as SavedWorkflow[]);
    const latest = latestVisibleWorkflow(existing);
    if (latest) {
      return { id: latest.id, created: false };
    }
  }
  const workflow = await api.workflow.create({
    name: "Untitled Workflow",
    description: "",
    nodes: [],
    edges: [],
  });
  return { id: workflow.id, created: true };
}
