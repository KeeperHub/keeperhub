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
