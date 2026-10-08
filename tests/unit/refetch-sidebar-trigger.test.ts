import { describe, expect, it, vi } from "vitest";
import {
  refetchSidebarIfTriggerChanged,
  registerSidebarRefetch,
} from "@/lib/refetch-sidebar";

const nodes = (config: Record<string, unknown>) => [
  { data: { type: "trigger", config } },
  { data: { type: "action", config: { actionType: "x" } } },
];

describe("refetchSidebarIfTriggerChanged", () => {
  it("refetches only when a workflow's saved trigger changes", () => {
    const refetch = vi.fn();
    const unregister = registerSidebarRefetch(refetch);
    const schedule = { triggerType: "Schedule", scheduleCron: "*/5 * * * *" };

    // The first save has nothing to compare to.
    refetchSidebarIfTriggerChanged("wf-1", nodes(schedule));
    expect(refetch).toHaveBeenCalledTimes(1);

    // Saving other nodes, or the same trigger again, does not.
    refetchSidebarIfTriggerChanged("wf-1", nodes({ ...schedule }));
    expect(refetch).toHaveBeenCalledTimes(1);

    refetchSidebarIfTriggerChanged(
      "wf-1",
      nodes({ ...schedule, scheduleCron: "0 * * * *" })
    );
    expect(refetch).toHaveBeenCalledTimes(2);

    // Removing the trigger node is a change too.
    refetchSidebarIfTriggerChanged("wf-1", []);
    expect(refetch).toHaveBeenCalledTimes(3);

    unregister();
  });
});
