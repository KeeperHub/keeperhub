import { describe, expect, it } from "vitest";

import {
  getAvailableFields,
  type NodeOutputs,
  processTemplate,
} from "@/lib/utils/template";

describe("template utils", () => {
  describe("processTemplate with @ references", () => {
    it("resolves nested paths under data (API response shape)", () => {
      const nodeOutputs: NodeOutputs = {
        node_1: {
          label: "HTTP Request",
          data: {
            success: true,
            data: { user: { id: "u1", name: "Alice" }, count: 2 },
            status: 200,
          },
        },
      };

      expect(
        processTemplate("{{@node_1:HTTP Request.data.user.name}}", nodeOutputs)
      ).toBe("Alice");
      expect(
        processTemplate("{{@node_1:HTTP Request.data.user.id}}", nodeOutputs)
      ).toBe("u1");
      expect(
        processTemplate("{{@node_1:HTTP Request.status}}", nodeOutputs)
      ).toBe("200");
      expect(
        processTemplate("{{@node_1:HTTP Request.data.count}}", nodeOutputs)
      ).toBe("2");
    });

    it("resolves array index path (items[0].name)", () => {
      const nodeOutputs: NodeOutputs = {
        n1: {
          label: "API",
          data: {
            data: {
              items: [{ name: "First" }, { name: "Second" }],
            },
          },
        },
      };

      expect(
        processTemplate("{{@n1:API.data.items[0].name}}", nodeOutputs)
      ).toBe("First");
      expect(
        processTemplate("{{@n1:API.data.items[1].name}}", nodeOutputs)
      ).toBe("Second");
    });

    it("returns empty string for missing nested path", () => {
      const nodeOutputs: NodeOutputs = {
        n1: {
          label: "Step",
          data: { data: { a: 1 } },
        },
      };

      expect(
        processTemplate("{{@n1:Step.data.missing.deep}}", nodeOutputs)
      ).toBe("");
    });

    it("returns empty string when node is not in nodeOutputs", () => {
      const nodeOutputs: NodeOutputs = {
        n1: {
          label: "Step",
          data: { data: { x: 1 } },
        },
      };

      expect(processTemplate("{{@missing:Label.path}}", nodeOutputs)).toBe("");
      expect(
        processTemplate("{{@otherNode:HTTP Request.data.name}}", nodeOutputs)
      ).toBe("");
    });

    it("returns whole node data when no field path", () => {
      const nodeOutputs: NodeOutputs = {
        n1: {
          label: "Step",
          data: { success: true, data: { x: 1 } },
        },
      };

      const result = processTemplate("{{@n1:Step}}", nodeOutputs);
      expect(result).toContain("success");
      expect(result).toContain("data");
    });
  });

  /**
   * Field access over an array cursor maps the key across every element. The
   * spread is the point - a real binding over a list of objects renders
   * "1, 2" - but when no element carries the key the map used to hand back an
   * array of holes, which is neither `undefined` nor `null` and so counted as
   * resolved. `formatValue` then joined the holes into ", " and the caller's
   * resolution tracker recorded nothing to fail on.
   *
   * A non-object element contributes a hole rather than a prototype lookup, so
   * the same rule reaches `.length` over a list of strings. The discriminator
   * is the element's type, which the pair of `.length` cases below pins from
   * both sides.
   *
   * All three spellings walk their own copy of the loop, so all three are
   * exercised: `{{@nodeId:Label.field}}` is what saved workflows store,
   * `{{$nodeId.field}}` and `{{Label.field}}` are the legacy forms.
   */
  describe("processTemplate over an array cursor", () => {
    const arrayOutputs: NodeOutputs = {
      n1: {
        label: "Step",
        data: {
          success: true,
          result: { owners: ["0xaaa", "0xbbb", "0xccc"] },
        },
      },
    };

    const objectListOutputs: NodeOutputs = {
      n2: {
        label: "Fees",
        data: { fees: [{ amt: 1 }, { amt: 2 }] },
      },
    };

    it("misses a key no element carries, in the stored spelling", () => {
      expect(
        processTemplate("{{@n1:Step.result.owners.typo}}", arrayOutputs)
      ).toBe("");
    });

    it("misses a key no element carries, in the $nodeId spelling", () => {
      expect(processTemplate("{{$n1.result.owners.typo}}", arrayOutputs)).toBe(
        ""
      );
    });

    it("misses a key no element carries, in the label spelling", () => {
      expect(processTemplate("{{Step.result.owners.typo}}", arrayOutputs)).toBe(
        ""
      );
    });

    it("still joins a real binding across the array", () => {
      expect(processTemplate("{{@n2:Fees.fees.amt}}", objectListOutputs)).toBe(
        "1, 2"
      );
      expect(processTemplate("{{$n2.fees.amt}}", objectListOutputs)).toBe(
        "1, 2"
      );
      expect(processTemplate("{{Fees.fees.amt}}", objectListOutputs)).toBe(
        "1, 2"
      );
    });

    it("resolves when only some elements carry the key", () => {
      const partial: NodeOutputs = {
        n3: {
          label: "Fees",
          data: { fees: [{ amt: 1 }, {}, { amt: 2 }] },
        },
      };

      // Not an all-holes map, so it is a real value and stays a hit. The gap
      // renders empty the way any other array element holding nothing does.
      expect(processTemplate("{{@n3:Fees.fees.amt}}", partial)).toBe("1, , 2");
      expect(processTemplate("{{$n3.fees.amt}}", partial)).toBe("1, , 2");
      expect(processTemplate("{{Fees.fees.amt}}", partial)).toBe("1, , 2");
    });

    it("leaves an empty array a hit", () => {
      const empty: NodeOutputs = {
        n4: { label: "Query", data: { events: [] } },
      };

      // No element to probe means no evidence the key is wrong, and a query
      // that legitimately matched nothing must not start failing the step.
      expect(processTemplate("{{@n4:Query.events.txHash}}", empty)).toBe("");
    });

    it("misses a key that only a builtin would answer", () => {
      // The map contributes undefined for a non-object element, so `.length`
      // over an array of strings is all holes rather than [5, 5, 5].
      expect(
        processTemplate("{{@n1:Step.result.owners.length}}", arrayOutputs)
      ).toBe("");
      expect(
        processTemplate("{{$n1.result.owners.length}}", arrayOutputs)
      ).toBe("");
      expect(
        processTemplate("{{Step.result.owners.length}}", arrayOutputs)
      ).toBe("");
    });

    it("keys off element type, not property name", () => {
      const pages: NodeOutputs = {
        n5: {
          label: "Pages",
          data: { pages: [{ length: 12 }, { length: 30 }] },
        },
      };

      // Same property name as the builtin above, but these elements are
      // objects that genuinely carry it, so it stays a real binding.
      expect(processTemplate("{{@n5:Pages.pages.length}}", pages)).toBe(
        "12, 30"
      );
    });
  });

  describe("getAvailableFields", () => {
    it("includes nested paths under data with nodeId and fieldPath", () => {
      const nodeOutputs: NodeOutputs = {
        node_1: {
          label: "HTTP Request",
          data: {
            success: true,
            data: { user: { id: "u1", name: "Alice" } },
            status: 200,
          },
        },
      };

      const fields = getAvailableFields(nodeOutputs);

      const fieldPaths = fields.map((f) => f.fieldPath).filter(Boolean);
      expect(fieldPaths).toContain("success");
      expect(fieldPaths).toContain("data");
      expect(fieldPaths).toContain("data.user");
      expect(fieldPaths).toContain("data.user.id");
      expect(fieldPaths).toContain("data.user.name");
      expect(fieldPaths).toContain("status");

      const withNodeId = fields.filter((f) => f.nodeId === "node_1");
      expect(withNodeId.length).toBeGreaterThan(0);
    });

    it("includes array first-element path (items[0]) and nested under it", () => {
      const nodeOutputs: NodeOutputs = {
        n1: {
          label: "API",
          data: {
            data: {
              items: [{ name: "First", value: 10 }],
            },
          },
        },
      };

      const fields = getAvailableFields(nodeOutputs);

      const fieldPaths = fields.map((f) => f.fieldPath).filter(Boolean);
      expect(fieldPaths).toContain("data");
      expect(fieldPaths).toContain("data.items");
      expect(fieldPaths).toContain("data.items[0]");
      expect(fieldPaths).toContain("data.items[0].name");
      expect(fieldPaths).toContain("data.items[0].value");
    });

    it("includes nested fields for objects", () => {
      const nodeOutputs: NodeOutputs = {
        n1: {
          label: "API",
          data: {
            data: {
              user: {
                id: "u1",
                name: "Alice",
                project: {
                  id: "p1",
                  name: "Project 1",
                  tags: ["tag1", "tag2"],
                  positions: {
                    x: 100,
                    y: 200,
                    z: 300,
                  },
                },
              },
            },
          },
        },
      };

      const fields = getAvailableFields(nodeOutputs);

      const fieldPaths = fields.map((f) => f.fieldPath).filter(Boolean);
      expect(fieldPaths).toContain("data");
      expect(fieldPaths).toContain("data.user");
      expect(fieldPaths).toContain("data.user.id");
      expect(fieldPaths).toContain("data.user.name");
      expect(fieldPaths).toContain("data.user.project");
      expect(fieldPaths).toContain("data.user.project.id");
      expect(fieldPaths).toContain("data.user.project.name");
      expect(fieldPaths).toContain("data.user.project.tags");
      expect(fieldPaths).toContain("data.user.project.positions");
      expect(fieldPaths).toContain("data.user.project.positions.x");
      expect(fieldPaths).toContain("data.user.project.positions.y");
      expect(fieldPaths).toContain("data.user.project.positions.z");
    });
  });
});
