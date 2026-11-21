import { describe, expect, it, vi } from "vitest";

// The real helpers (flattening, display-only and toggle checks) so this test
// cannot drift from them; only the integration list is replaced.
vi.mock("@/plugins/registry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/plugins/registry")>()),
  getAllIntegrations: vi.fn(),
}));

import {
  preparePinDataForWorkflow,
  type WorkflowNodeLike,
} from "@/lib/mcp/prepare-test-pin-data";
import { getAllIntegrations } from "@/plugins/registry";

function mockRegistry(
  actions: Array<{
    pluginType: string;
    slug: string;
    configFields: unknown[];
  }>
) {
  vi.mocked(getAllIntegrations).mockReturnValue(
    actions.map((a) => ({
      type: a.pluginType,
      label: a.pluginType,
      description: "",
      icon: () => null,
      actions: [
        {
          slug: a.slug,
          label: a.slug,
          description: "",
          category: "test",
          configFields: a.configFields,
          stepFunction: "",
          stepImportPath: "",
        },
      ],
    })) as unknown as ReturnType<typeof getAllIntegrations>
  );
}

describe("preparePinDataForWorkflow", () => {
  it("empty workflow returns empty array", () => {
    mockRegistry([]);
    expect(preparePinDataForWorkflow([])).toEqual([]);
  });

  it("resolves an action by full ID and produces pinSchema", () => {
    mockRegistry([
      {
        pluginType: "web3",
        slug: "read-contract",
        configFields: [
          { key: "address", label: "Address", type: "text", required: true },
          {
            key: "abi",
            label: "ABI",
            type: "abi-with-auto-fetch",
            required: false,
          },
        ],
      },
    ]);
    const nodes: WorkflowNodeLike[] = [
      {
        id: "n1",
        type: "action",
        data: {
          type: "action",
          label: "Read",
          config: { actionType: "web3/read-contract" },
        },
      },
    ];
    const result = preparePinDataForWorkflow(nodes);
    expect(result).toHaveLength(1);
    expect(result[0].nodeId).toBe("n1");
    expect(result[0].nodeName).toBe("Read");
    expect(result[0].pinSchema.properties.address).toEqual({
      type: "string",
      description: "Address",
    });
    expect(result[0].pinSchema.required).toEqual(["address"]);
    expect(result[0].required).toBe(true);
  });

  it("types a generic switch field as boolean", () => {
    mockRegistry([
      {
        pluginType: "data",
        slug: "filter",
        configFields: [
          { key: "ignoreCase", label: "Ignore case", type: "switch" },
        ],
      },
    ]);
    const result = preparePinDataForWorkflow([
      {
        id: "n1",
        type: "action",
        data: { label: "Filter", config: { actionType: "data/filter" } },
      },
    ]);
    expect(result[0].pinSchema.properties.ignoreCase).toEqual({
      type: "boolean",
      description: "Ignore case",
      default: false,
    });
  });

  it("unresolved action returns fallback schema with additionalProperties:true", () => {
    mockRegistry([]);
    const result = preparePinDataForWorkflow([
      {
        id: "n1",
        type: "action",
        data: { config: { actionType: "non/existent" } },
      },
    ]);
    expect(result[0].pinSchema.additionalProperties).toBe(true);
    expect(result[0].required).toBe(false);
  });

  it("number field type -> JSON Schema type:number", () => {
    mockRegistry([
      {
        pluginType: "x",
        slug: "y",
        configFields: [{ key: "amount", label: "Amount", type: "number" }],
      },
    ]);
    const r = preparePinDataForWorkflow([
      {
        id: "n",
        data: { config: { actionType: "x/y" } },
      },
    ]);
    expect(r[0].pinSchema.properties.amount.type).toBe("number");
  });

  it("protocol-bool field type -> JSON Schema type:boolean", () => {
    mockRegistry([
      {
        pluginType: "x",
        slug: "y",
        configFields: [{ key: "flag", label: "Flag", type: "protocol-bool" }],
      },
    ]);
    const r = preparePinDataForWorkflow([
      {
        id: "n",
        data: { config: { actionType: "x/y" } },
      },
    ]);
    expect(r[0].pinSchema.properties.flag.type).toBe("boolean");
  });

  it.each(["fail-on-error-switch", "gas-sponsorship-switch"])(
    "%s field type -> JSON Schema type:boolean, as the action schema says",
    (type) => {
      mockRegistry([
        {
          pluginType: "x",
          slug: "y",
          configFields: [
            { key: "toggle", label: "Toggle", type, defaultValue: "true" },
          ],
        },
      ]);
      const r = preparePinDataForWorkflow([
        {
          id: "n",
          data: { config: { actionType: "x/y" } },
        },
      ]);
      expect(r[0].pinSchema.properties.toggle).toEqual({
        type: "boolean",
        description: "Toggle",
        default: true,
      });
    }
  );

  it.each([
    ["fail-on-error-switch", "false"],
    ["fail-on-error-switch", undefined],
    ["gas-sponsorship-switch", "false"],
    ["gas-sponsorship-switch", undefined],
  ])(
    "%s advertises default true whatever defaultValue says (%s)",
    (type, defaultValue) => {
      mockRegistry([
        {
          pluginType: "x",
          slug: "y",
          configFields: [
            { key: "toggle", label: "Toggle", type, defaultValue },
          ],
        },
      ]);
      const r = preparePinDataForWorkflow([
        { id: "n", data: { config: { actionType: "x/y" } } },
      ]);
      expect(r[0].pinSchema.properties.toggle?.default).toBe(true);
    }
  );

  it("select field type with options -> enum present", () => {
    mockRegistry([
      {
        pluginType: "x",
        slug: "y",
        configFields: [
          {
            key: "mode",
            label: "Mode",
            type: "select",
            options: [
              { value: "a", label: "A" },
              { value: "b", label: "B" },
            ],
          },
        ],
      },
    ]);
    const r = preparePinDataForWorkflow([
      {
        id: "n",
        data: { config: { actionType: "x/y" } },
      },
    ]);
    expect(r[0].pinSchema.properties.mode.enum).toEqual(["a", "b"]);
  });

  it("group configField is flattened — group label is NOT a property", () => {
    mockRegistry([
      {
        pluginType: "x",
        slug: "y",
        configFields: [
          {
            type: "group",
            label: "Advanced",
            fields: [{ key: "gas", label: "Gas", type: "number" }],
          },
        ],
      },
    ]);
    const r = preparePinDataForWorkflow([
      {
        id: "n",
        data: { config: { actionType: "x/y" } },
      },
    ]);
    expect(r[0].pinSchema.properties.gas).toBeDefined();
    expect(r[0].pinSchema.properties.Advanced).toBeUndefined();
  });

  it("falls back to bare slug when full ID not in data.config", () => {
    mockRegistry([
      {
        pluginType: "web3",
        slug: "read-contract",
        configFields: [{ key: "address", label: "Address", type: "text" }],
      },
    ]);
    const r = preparePinDataForWorkflow([
      {
        id: "n",
        type: "action",
        data: { type: "read-contract", label: "Read", config: {} },
      },
    ]);
    expect(r[0].pinSchema.properties.address).toBeDefined();
  });
});
