import { describe, expect, it } from "vitest";
import {
  buildManualRunRequestBody,
  buildManualRunSample,
  getRequiredInputNames,
  hasManualRunInputs,
  hasManualTrigger,
  shouldCollectManualRunInput,
  validateManualRunInput,
} from "@/lib/workflow/editor/manual-run-input";

const SCHEMA = {
  type: "object",
  properties: {
    sender: { type: "string" },
    value: { type: "string", default: "0" },
    retries: { type: "number" },
    dryRun: { type: "boolean" },
    tags: { type: "array" },
    nested: {
      type: "object",
      properties: { inner: { type: "string" } },
    },
  },
  required: ["sender", "value"],
};

const manualTrigger = {
  data: { type: "trigger", config: { triggerType: "Manual" } },
};
const webhookTrigger = {
  data: { type: "trigger", config: { triggerType: "Webhook" } },
};
const scheduleTrigger = {
  data: { type: "trigger", config: { triggerType: "Schedule" } },
};
/** No triggerType at all - the editor treats this as Manual. */
const defaultTrigger = { data: { type: "trigger", config: {} } };
const actionNode = { data: { type: "action", config: {} } };

describe("hasManualRunInputs", () => {
  it("is true only when the schema declares properties", () => {
    expect(hasManualRunInputs(SCHEMA)).toBe(true);
    expect(hasManualRunInputs({ type: "object", properties: {} })).toBe(false);
    expect(hasManualRunInputs({})).toBe(false);
    expect(hasManualRunInputs(null)).toBe(false);
    expect(hasManualRunInputs(undefined)).toBe(false);
  });
});

describe("hasManualTrigger", () => {
  it("recognises an explicit Manual trigger", () => {
    expect(hasManualTrigger([manualTrigger])).toBe(true);
  });

  it("treats a missing triggerType as Manual, matching the editor", () => {
    expect(hasManualTrigger([defaultTrigger])).toBe(true);
  });

  it("treats a persisted null or empty triggerType as Manual", () => {
    // `template-helpers.ts` reads this config as `triggerType || "Manual"`, so a
    // falsy value is Manual everywhere else in the editor. Checking for
    // `undefined` alone would leave these rows running without a prompt.
    const nullTrigger = {
      data: { type: "trigger", config: { triggerType: null } },
    };
    const emptyTrigger = {
      data: { type: "trigger", config: { triggerType: "" } },
    };
    expect(hasManualTrigger([nullTrigger])).toBe(true);
    expect(hasManualTrigger([emptyTrigger])).toBe(true);
    expect(shouldCollectManualRunInput([nullTrigger], SCHEMA)).toBe(true);
    expect(shouldCollectManualRunInput([emptyTrigger], SCHEMA)).toBe(true);
  });

  it("does not treat automatic triggers as manual", () => {
    expect(hasManualTrigger([webhookTrigger])).toBe(false);
    expect(hasManualTrigger([scheduleTrigger])).toBe(false);
  });

  it("ignores non-trigger nodes", () => {
    expect(hasManualTrigger([actionNode])).toBe(false);
  });

  it("finds a manual trigger among several", () => {
    expect(hasManualTrigger([scheduleTrigger, actionNode, manualTrigger])).toBe(
      true
    );
  });
});

describe("shouldCollectManualRunInput", () => {
  // The wiring decision the toolbar makes: collect before starting, or start.
  it("collects when a manual trigger and declared inputs are both present", () => {
    expect(shouldCollectManualRunInput([manualTrigger], SCHEMA)).toBe(true);
  });

  it("does not collect when the workflow has no declared inputs", () => {
    expect(
      shouldCollectManualRunInput([manualTrigger], { type: "object" })
    ).toBe(false);
  });

  it("does not collect for an automatic-only workflow with a schema", () => {
    // A schedule or webhook run never receives editor input, so prompting for
    // it would ask the author for a value production never supplies.
    expect(shouldCollectManualRunInput([scheduleTrigger], SCHEMA)).toBe(false);
    expect(shouldCollectManualRunInput([webhookTrigger], SCHEMA)).toBe(false);
  });

  it("does not collect with no triggers at all", () => {
    expect(shouldCollectManualRunInput([actionNode], SCHEMA)).toBe(false);
  });
});

describe("buildManualRunSample", () => {
  it("leaves required properties out of the starting payload", () => {
    // The prefill must not satisfy the validation it is checked against. Every
    // required key being present by construction is what let an untouched prompt
    // submit `{"recipient": ""}` for a field nobody filled in.
    expect(buildManualRunSample(SCHEMA)).toEqual({
      retries: 0,
      dryRun: false,
      tags: [],
      nested: { inner: "" },
    });
  });

  it("cannot pass its own validation until the author supplies the required keys", () => {
    const sample = buildManualRunSample(SCHEMA);
    expect(validateManualRunInput(SCHEMA, sample)).toEqual([
      'Required input "sender" is missing.',
      'Required input "value" is missing.',
    ]);
    // Supplying one key is not enough, and the message names the one still out.
    expect(
      validateManualRunInput(SCHEMA, { ...sample, sender: "0xabc" })
    ).toEqual(['Required input "value" is missing.']);
    // Supplying both, including an empty string the author chose, passes.
    expect(
      validateManualRunInput(SCHEMA, { ...sample, sender: "0xabc", value: "" })
    ).toEqual([]);
  });

  it("leaves a required property inside a nested object out too", () => {
    const schema = {
      type: "object",
      properties: {
        outer: {
          type: "object",
          properties: { kept: { type: "string" } },
        },
        nestedRequired: {
          type: "object",
          properties: { inner: { type: "string" }, other: { type: "string" } },
          required: ["inner"],
        },
      },
    };
    expect(buildManualRunSample(schema)).toEqual({
      outer: { kept: "" },
      nestedRequired: { other: "" },
    });
  });

  it("prefers default, then first example, then first enum value", () => {
    const schema = {
      type: "object",
      properties: {
        fromDefault: { type: "string", default: "d" },
        fromExample: { type: "string", examples: ["e1", "e2"] },
        fromEnum: { type: "string", enum: ["x", "y"] },
      },
    };
    expect(buildManualRunSample(schema)).toEqual({
      fromDefault: "d",
      fromExample: "e1",
      fromEnum: "x",
    });
  });

  it("returns an empty object for a schema without properties", () => {
    expect(buildManualRunSample({ type: "object" })).toEqual({});
  });
});

describe("buildManualRunRequestBody", () => {
  it("nests the author's input under `input`", () => {
    // The shape the server parses
    // (`app/api/workflow/[workflowId]/execute/route.ts` reads `body.input`) and
    // the executor merges into the trigger output's data.
    expect(buildManualRunRequestBody({ sender: "0xabc" })).toEqual({
      input: { sender: "0xabc" },
    });
  });

  it("sends an empty object rather than dropping the field", () => {
    // The listing contract is presence-only, so `input` has to exist even when
    // the author supplied nothing.
    expect(buildManualRunRequestBody({})).toEqual({ input: {} });
  });

  it("passes the author's values through without reshaping them", () => {
    const input = {
      sender: "",
      retries: 0,
      dryRun: false,
      tags: [] as string[],
    };
    expect(buildManualRunRequestBody(input).input).toEqual(input);
  });
});

describe("validateManualRunInput", () => {
  it("reports every missing required input, not just the first", () => {
    expect(validateManualRunInput(SCHEMA, {})).toEqual([
      'Required input "sender" is missing.',
      'Required input "value" is missing.',
    ]);
  });

  it("accepts a payload that supplies every required field", () => {
    expect(
      validateManualRunInput(SCHEMA, { sender: "0xabc", value: "1" })
    ).toEqual([]);
  });

  it("accepts an empty string as a supplied value", () => {
    // Presence, not truthiness, matches the server contract
    // (`app/api/mcp/workflows/[slug]/call/route.ts` tests `field in body`), and
    // it is what lets a required field be run empty on purpose.
    expect(validateManualRunInput(SCHEMA, { sender: "", value: "1" })).toEqual(
      []
    );
  });

  it("accepts falsy-but-present values for non-required fields", () => {
    expect(
      validateManualRunInput(SCHEMA, {
        sender: "0xabc",
        value: "0",
        dryRun: false,
        retries: 0,
      })
    ).toEqual([]);
  });

  it("ignores required entries that are not strings", () => {
    expect(
      validateManualRunInput(
        { type: "object", required: [1, "sender"] },
        { sender: "set" }
      )
    ).toEqual([]);
  });
});

describe("getRequiredInputNames", () => {
  it("returns only string entries", () => {
    expect(getRequiredInputNames({ required: ["a", 2, null, "b"] })).toEqual([
      "a",
      "b",
    ]);
  });

  it("returns nothing when required is absent", () => {
    expect(getRequiredInputNames({})).toEqual([]);
  });
});
