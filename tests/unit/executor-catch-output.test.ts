import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  processCodeTemplates,
  processTemplates,
  recordCatchOutput,
} from "@/lib/workflow/executor/executor.workflow";
import { createTracker } from "@/lib/workflow/executor/template-resolution";

const successOutputs = {
  bungee: {
    label: "Bungee",
    data: {
      success: true,
      data: { result: { autoRoute: { output: { amount: "998899" } } } },
      status: 200,
    },
  },
};

const softFailOutputs = {
  bungee: {
    label: "Bungee",
    data: { success: true, data: null, status: 400, error: "Validation Error" },
  },
};

const nullifiedOutputs = {
  bungee: {
    label: "Bungee",
    data: null,
  },
};

describe("template resolver baseline (bungee fixtures)", () => {
  it("processCodeTemplates resolves a successful step's data", () => {
    const t = createTracker();
    processCodeTemplates("const x = {{@bungee:Bungee}};", successOutputs, t);
    expect(t.unresolved.map((r) => r.reason)).toEqual([]);
  });
  it("processCodeTemplates passes a soft-fail wrapper (success:true, inner data:null) through to the user code", () => {
    const t = createTracker();
    processCodeTemplates("const x = {{@bungee:Bungee}};", softFailOutputs, t);
    expect(t.unresolved.map((r) => r.reason)).toEqual([]);
  });
  it("processTemplates resolves a successful step's data", () => {
    const t = createTracker();
    processTemplates(
      { code: "const x = {{@bungee:Bungee}};" },
      successOutputs,
      t
    );
    expect(t.unresolved.map((r) => r.reason)).toEqual([]);
  });
  it("processTemplates passes a soft-fail wrapper through", () => {
    const t = createTracker();
    processTemplates(
      { code: "const x = {{@bungee:Bungee}};" },
      softFailOutputs,
      t
    );
    expect(t.unresolved.map((r) => r.reason)).toEqual([]);
  });

  // Sentinel: confirms the post-nullify shape (output present, data===null)
  // is what triggers the strict-mode "produced no data" error. If this stops
  // reporting "no-data", the resolver semantics have shifted and the
  // catch-handler preserve-prior-success fix may no longer be load-bearing.
  it("processCodeTemplates records no-data when output exists but data===null (post-nullify shape)", () => {
    const t = createTracker();
    processCodeTemplates("const x = {{@bungee:Bungee}};", nullifiedOutputs, t);
    expect(t.unresolved.map((r) => r.reason)).toEqual(["no-data"]);
  });
});

// recordCatchOutput is the catch-handler write previously inlined at the
// catch site. It must preserve a prior in-memory success so that an SDK
// replay (whose first attempt already populated outputs) does not destroy
// successful data on its way to providing a downstream-safe null for
// genuinely-failed nodes.
describe("recordCatchOutput", () => {
  it("writes {data: null} when there is no prior entry for the node", () => {
    const outputs: Record<string, { label: string; data: unknown }> = {};
    recordCatchOutput(outputs, "bungee", "Bungee");
    expect(outputs.bungee).toEqual({ label: "Bungee", data: null });
  });

  it("writes {data: null} when the prior entry has data===undefined", () => {
    const outputs = {
      bungee: { label: "Bungee", data: undefined as unknown },
    };
    recordCatchOutput(outputs, "bungee", "Bungee");
    expect(outputs.bungee).toEqual({ label: "Bungee", data: null });
  });

  it("writes {data: null} when the prior entry has data===null", () => {
    const outputs = {
      bungee: { label: "Bungee", data: null as unknown },
    };
    recordCatchOutput(outputs, "bungee", "Bungee");
    expect(outputs.bungee).toEqual({ label: "Bungee", data: null });
  });

  // Failing-without-fix case.
  // Before the fix, the catch handler unconditionally wrote {data: null},
  // discarding the prior success object stored by the first (succeeded)
  // attempt of a step that the SDK then replayed. Downstream resolvers
  // then reported `Node "bungee" produced no data.`
  it("preserves a prior success object (SDK replay after first attempt succeeded)", () => {
    const successData = {
      success: true,
      data: { result: { autoRoute: { output: { amount: "998899" } } } },
      status: 200,
    };
    const outputs = {
      bungee: { label: "Bungee", data: successData as unknown },
    };
    recordCatchOutput(outputs, "bungee", "Bungee");
    expect(outputs.bungee.data).toBe(successData);
  });

  it("preserves a prior soft-fail wrapper (success:true, inner data:null) which is still a valid output shape", () => {
    const softFailData = {
      success: true,
      data: null,
      status: 400,
      error: "Validation Error",
    };
    const outputs = {
      bungee: { label: "Bungee", data: softFailData as unknown },
    };
    recordCatchOutput(outputs, "bungee", "Bungee");
    expect(outputs.bungee.data).toBe(softFailData);
  });
});
