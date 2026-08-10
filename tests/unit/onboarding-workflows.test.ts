import { describe, expect, it } from "vitest";
import {
  ONBOARDING_WORKFLOW_FIXTURES,
  type OnboardingWorkflowFixture,
} from "@/scripts/seed/fixtures/onboarding-workflows";
import { USER_EDIT_EPSILON_MS } from "@/scripts/seed/seed-onboarding-workflows";

describe("ONBOARDING_WORKFLOW_FIXTURES", () => {
  it("has the expected fixture count", () => {
    expect(ONBOARDING_WORKFLOW_FIXTURES).toHaveLength(8);
  });

  it("has unique ids", () => {
    const ids = ONBOARDING_WORKFLOW_FIXTURES.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("has unique listedSlugs", () => {
    const slugs = ONBOARDING_WORKFLOW_FIXTURES.map((f) => f.listedSlug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  for (const fixture of ONBOARDING_WORKFLOW_FIXTURES) {
    describe(`fixture: ${fixture.id}`, () => {
      it("has required string fields", () => {
        expect(typeof fixture.id).toBe("string");
        expect(typeof fixture.listedSlug).toBe("string");
        expect(typeof fixture.name).toBe("string");
        expect(typeof fixture.description).toBe("string");
        expect(typeof fixture.featuredProtocol).toBe("string");
        expect(fixture.id.length).toBeGreaterThan(0);
        expect(fixture.listedSlug.length).toBeGreaterThan(0);
        expect(fixture.name.length).toBeGreaterThan(0);
      });

      it("has at least one node and one edge", () => {
        expect((fixture.nodes as unknown[]).length).toBeGreaterThan(0);
        expect((fixture.edges as unknown[]).length).toBeGreaterThan(0);
      });

      it("edge source and target IDs reference existing nodes", () => {
        type NodeLike = { id: string };
        type EdgeLike = { source: string; target: string };
        const nodeIds = new Set((fixture.nodes as NodeLike[]).map((n) => n.id));
        for (const edge of fixture.edges as EdgeLike[]) {
          expect(
            nodeIds.has(edge.source),
            `edge source "${edge.source}" missing from nodes`
          ).toBe(true);
          expect(
            nodeIds.has(edge.target),
            `edge target "${edge.target}" missing from nodes`
          ).toBe(true);
        }
      });

      it("first node is a trigger", () => {
        type NodeLike = {
          id: string;
          data?: { config?: { triggerType?: string } };
        };
        const first = (fixture.nodes as NodeLike[])[0];
        expect(first.id).toBe("trigger-1");
        expect(first.data?.config?.triggerType).toBeTruthy();
      });
    });
  }
});

describe("USER_EDIT_EPSILON_MS", () => {
  it("is 5000 ms", () => {
    expect(USER_EDIT_EPSILON_MS).toBe(5000);
  });
});

describe("whale-withdrawal fixture", () => {
  const fixture = ONBOARDING_WORKFLOW_FIXTURES.find(
    (f) => f.listedSlug === "whale-withdrawal"
  ) as OnboardingWorkflowFixture;

  it("exists", () => {
    expect(fixture).toBeDefined();
  });

  it("has a condition node as step-1", () => {
    type NodeLike = {
      id: string;
      data?: { config?: { actionType?: string; condition?: string } };
    };
    const step1 = (fixture.nodes as NodeLike[]).find((n) => n.id === "step-1");
    expect(step1?.data?.config?.actionType).toBe("Condition");
    expect(step1?.data?.config?.condition).toContain("100000000000");
  });

  it("routes only the true branch to Discord", () => {
    type EdgeLike = {
      source: string;
      target: string;
      sourceHandle?: string | null;
    };
    const discordEdge = (fixture.edges as EdgeLike[]).find(
      (e) => e.source === "step-1"
    );
    expect(discordEdge?.sourceHandle).toBe("true");
    expect(discordEdge?.target).toBe("step-2");
  });
});
