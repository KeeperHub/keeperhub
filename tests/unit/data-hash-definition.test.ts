import { describe, expect, it } from "vitest";
import { buildConfigForActionTypeChange } from "@/lib/workflow/editor/action-type-transition";
import { evaluateShowWhen } from "@/lib/workflow/editor/show-when";
import { validateWorkflowActionConfigs } from "@/lib/workflow/validation/action-config";
import { ALGORITHMS } from "@/plugins/data/steps/hash-core";
import {
  findActionById,
  flattenConfigFields,
  generateAIActionPrompts,
} from "@/plugins/registry";

const ACTION_TYPE = "data/hash";

const FROB_SIG = "frob(bytes32,address,address,address,int256,int256)";

function fields() {
  const action = findActionById(ACTION_TYPE);
  if (!action?.configFields) {
    throw new Error(`${ACTION_TYPE} has no config fields`);
  }
  return flattenConfigFields(action.configFields);
}

function field(key: string) {
  const found = fields().find((candidate) => candidate.key === key);
  if (!found) {
    throw new Error(`${ACTION_TYPE} has no ${key} field`);
  }
  return found;
}

function editorConfig(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return { ...buildConfigForActionTypeChange(ACTION_TYPE, {}), ...overrides };
}

function visibleKeys(config: Record<string, unknown>): string[] {
  return fields()
    .filter((candidate) => evaluateShowWhen(candidate.showWhen, config))
    .map((candidate) => candidate.key);
}

function actionNode(config: Record<string, unknown>) {
  return {
    id: "node-1",
    type: "action",
    data: {
      label: "Hash",
      type: "action",
      config: { actionType: ACTION_TYPE, ...config },
    },
  };
}

/**
 * Plain code-unit comparison on the lowercased label. Deliberately not
 * localeCompare: ICU collation can treat "-" as ignorable, which would let
 * "SHA-256" and "SHA3-256" reorder between environments and make this test
 * pass locally and fail in CI.
 */
function byLabel(a: string, b: string): number {
  const left = a.toLowerCase();
  const right = b.toLowerCase();
  if (left < right) {
    return -1;
  }
  return left > right ? 1 : 0;
}

describe("data/hash definition", () => {
  describe("algorithm options", () => {
    it("lists the algorithms alphabetically by label", () => {
      const labels = field("algorithm").options?.map((option) => option.label);

      expect(labels).toEqual([
        "BLAKE2b-256",
        "keccak256 (Ethereum)",
        "RIPEMD-160",
        "SHA-256",
        "SHA-512",
        "SHA3-256 (NIST - not Ethereum)",
      ]);
    });

    // The assertion above pins today's list; this one keeps the rule true for
    // whatever is added next, without anyone having to re-sort by hand.
    it("stays sorted as algorithms are added", () => {
      const labels =
        field("algorithm").options?.map((option) => option.label) ?? [];

      expect(labels).toEqual([...labels].sort(byLabel));
    });

    // Sorting the dropdown must not quietly drop or invent an entry.
    it("offers exactly the algorithms the step implements", () => {
      const values =
        field("algorithm").options?.map((option) => option.value) ?? [];

      expect([...values].sort()).toEqual([...ALGORITHMS].sort());
    });

    it("has no duplicate value or label", () => {
      const options = field("algorithm").options ?? [];

      expect(new Set(options.map((option) => option.value)).size).toBe(
        options.length
      );
      expect(new Set(options.map((option) => option.label)).size).toBe(
        options.length
      );
    });

    // Alphabetical order moved keccak256 out of first place. Every EVM use
    // wants it, so the form must still open on it.
    it("defaults to keccak256 even though it is not listed first", () => {
      const algorithm = field("algorithm");

      expect(algorithm.options?.[0]?.value).not.toBe("keccak256");
      expect(algorithm.defaultValue).toBe("keccak256");
      expect(buildConfigForActionTypeChange(ACTION_TYPE, {}).algorithm).toBe(
        "keccak256"
      );
    });

    it("names SHA3-256 so it cannot be mistaken for keccak256", () => {
      const sha3 = field("algorithm").options?.find(
        (option) => option.value === "sha3-256"
      );

      expect(sha3?.label).toContain("not Ethereum");
    });
  });

  describe("input encoding options", () => {
    it("offers text, hex bytes and base64, defaulting to text", () => {
      const inputEncoding = field("inputEncoding");

      expect(inputEncoding.options?.map((option) => option.value)).toEqual([
        "utf8",
        "hex",
        "base64",
      ]);
      expect(inputEncoding.defaultValue).toBe("utf8");
    });

    it("offers hex, base64 and base64url as output, defaulting to hex", () => {
      const outputFormat = field("outputFormat");

      expect(outputFormat.options?.map((option) => option.value)).toEqual([
        "hex",
        "base64",
        "base64url",
      ]);
      expect(outputFormat.defaultValue).toBe("hex");
    });

    it("is required, so the reading of the value is never implicit", () => {
      expect(field("inputEncoding").required).toBe(true);
    });
  });

  describe("defaults", () => {
    it("seeds the whole form when the action is picked", () => {
      const config = buildConfigForActionTypeChange(ACTION_TYPE, {});

      expect(config.algorithm).toBe("keccak256");
      expect(config.inputEncoding).toBe("utf8");
      expect(config.outputFormat).toBe("hex");
    });

    // The widths default to blank, so the form opens on a whole digest and the
    // generated config says "leave blank" rather than naming a width.
    it("leaves the widths unset, so a full digest is the default", () => {
      const config = buildConfigForActionTypeChange(ACTION_TYPE, {});

      expect(config.outputBytes ?? "").toBe("");
      expect(config.padTo ?? "").toBe("");
    });
  });

  // generateAIActionPrompts reads example, then defaultValue, then a type
  // default of 10, and the line it builds is the canonical config for this
  // action in the workflow-generation prompt. A width of 4 and 32 there would
  // seed every generated node to truncate to a selector; a type default of 10
  // would be worse still. A blank default reads as "leave blank".
  describe("AI prompt example", () => {
    it("leaves the widths blank rather than seeding a truncation", () => {
      expect(field("outputBytes").example).toBeUndefined();
      expect(field("padTo").example).toBeUndefined();
      expect(field("outputBytes").defaultValue).toBe("");
      expect(field("padTo").defaultValue).toBe("");
    });

    it("produces a coherent example config", () => {
      const line = generateAIActionPrompts()
        .split("\n")
        .find((entry) => entry.includes(`(${ACTION_TYPE}): `));
      if (!line) {
        throw new Error(`no prompt line for ${ACTION_TYPE}`);
      }

      const example = JSON.parse(line.slice(line.indexOf("{"))) as Record<
        string,
        unknown
      >;

      expect(example.algorithm).toBe("keccak256");
      expect(example.inputEncoding).toBe("utf8");
      expect(example.outputBytes).toBe("");
      expect(example.padTo).toBe("");
      expect(example.outputFormat).toBe("hex");
    });
  });

  describe("field visibility", () => {
    // No showWhen anywhere: unlike data/encode, no field here is meaningful
    // only for some other field's value.
    it("shows every field at all times", () => {
      expect(visibleKeys(editorConfig())).toEqual([
        "algorithm",
        "value",
        "inputEncoding",
        "outputBytes",
        "padTo",
        "outputFormat",
      ]);
    });

    it("keeps every field visible for every algorithm", () => {
      const expected = visibleKeys(editorConfig());

      for (const algorithm of ALGORITHMS) {
        expect(visibleKeys(editorConfig({ algorithm }))).toEqual(expected);
      }
    });
  });

  describe("save-time validation", () => {
    it.each(ALGORITHMS)("accepts the editor config for %s", (algorithm) => {
      const result = validateWorkflowActionConfigs([
        actionNode(editorConfig({ algorithm, value: FROB_SIG })),
      ]);

      expect(result).toEqual({ valid: true, issues: [] });
    });

    it("accepts a selector config", () => {
      const result = validateWorkflowActionConfigs([
        actionNode(
          editorConfig({ value: FROB_SIG, outputBytes: "4", padTo: "32" })
        ),
      ]);

      expect(result).toEqual({ valid: true, issues: [] });
    });

    // The field stays required at save time even though the step hashes an
    // empty value: a blank config is a mistake, whereas an upstream node that
    // resolves to empty at run time is not.
    it("requires the value at save time", () => {
      const result = validateWorkflowActionConfigs([
        actionNode(editorConfig()),
      ]);

      expect(result.valid).toBe(false);
      expect(result.issues).toEqual([
        expect.objectContaining({ path: "nodes[0].data.config.value" }),
      ]);
    });

    // inputEncoding is required, so a config without it does not save. This is
    // not the "node saved before the field existed" case data/encode has to
    // handle: the action is new, so every stored node was created with the
    // whole form seeded. The step's fallback for a missing key is a run-time
    // robustness property, covered in data-hash.test.ts, not a save-time one.
    it("refuses a config missing the required input encoding", () => {
      const result = validateWorkflowActionConfigs([
        actionNode({ value: FROB_SIG, algorithm: "keccak256" }),
      ]);

      expect(result.valid).toBe(false);
      expect(result.issues).toEqual([
        expect.objectContaining({
          code: "MISSING_REQUIRED_FIELD",
          field: "inputEncoding",
        }),
      ]);
    });

    // outputFormat is the one option field that is genuinely optional.
    it("does not require the output format", () => {
      const result = validateWorkflowActionConfigs([
        actionNode({
          value: FROB_SIG,
          algorithm: "keccak256",
          inputEncoding: "utf8",
        }),
      ]);

      expect(result).toEqual({ valid: true, issues: [] });
    });
  });
});
