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
  it("refetches only when what the row shows for the trigger changes", () => {
    const refetch = vi.fn();
    const unregister = registerSidebarRefetch(refetch);
    const schedule = {
      triggerType: "Schedule",
      scheduleCron: "*/5 * * * *",
      contractABI: "[]",
    };

    // The first save has nothing to compare to.
    refetchSidebarIfTriggerChanged("wf-1", nodes(schedule));
    expect(refetch).toHaveBeenCalledTimes(1);

    // The same trigger, in any key order, or an edit the row does not show.
    refetchSidebarIfTriggerChanged("wf-1", nodes({ ...schedule }));
    refetchSidebarIfTriggerChanged(
      "wf-1",
      nodes({
        contractABI: "[{}]",
        scheduleCron: "*/5 * * * *",
        triggerType: "Schedule",
      })
    );
    expect(refetch).toHaveBeenCalledTimes(1);

    refetchSidebarIfTriggerChanged(
      "wf-1",
      nodes({ ...schedule, scheduleTimezone: "Europe/Vilnius" })
    );
    expect(refetch).toHaveBeenCalledTimes(2);

    // Removing the trigger node is a change too.
    refetchSidebarIfTriggerChanged("wf-1", []);
    expect(refetch).toHaveBeenCalledTimes(3);

    unregister();
  });

  it("tracks each workflow on its own", () => {
    const refetch = vi.fn();
    const unregister = registerSidebarRefetch(refetch);
    const event = { triggerType: "Event", eventName: "Lift" };
    refetchSidebarIfTriggerChanged("wf-a", nodes(event));
    refetchSidebarIfTriggerChanged("wf-b", nodes(event));
    expect(refetch).toHaveBeenCalledTimes(2);
    unregister();
  });
});
