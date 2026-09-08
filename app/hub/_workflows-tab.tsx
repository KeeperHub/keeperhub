// Server-component shoulder for the Workflows tab. Reads the `hub_view`
// cookie (Phase-43 HUB-19 contract: cookie read in RSC so first paint is
// correct, no hydration mismatch) and forwards the `?tag=` deep-link slug
// down to the lifted client view-shell (`./_view-shell.tsx`).
//
// This file is intentionally thin — the heavy lifting still lives in the
// Phase-43 `HubViewShell` client island. Plan 44-02 keeps the client bundle
// name stable to minimize git diff and editor-managed import churn.
import { cookies } from "next/headers";
import HubViewShell from "./_view-shell";

type WorkflowsTabProps = {
  initialTagSlug: string | null;
};

type View = "cards" | "list";

function readView(value: string | undefined): View {
  return value === "list" ? "list" : "cards";
}

export async function HubWorkflowsTab({
  initialTagSlug,
}: WorkflowsTabProps): Promise<React.ReactElement> {
  const cookieStore = await cookies();
  const initialView = readView(cookieStore.get("hub_view")?.value);
  return (
    <HubViewShell initialTagSlug={initialTagSlug} initialView={initialView} />
  );
}
