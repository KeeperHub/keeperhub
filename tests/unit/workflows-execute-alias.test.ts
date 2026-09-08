import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("workflow/api", () => ({ start: vi.fn() }));

describe("KEEP-477: plural /api/workflows/[id]/execute alias", () => {
  it("re-exports the same POST handler as the singular route", async () => {
    const singular = await import(
      "@/app/api/workflow/[workflowId]/execute/route"
    );
    const plural = await import(
      "@/app/api/workflows/[workflowId]/execute/route"
    );

    expect(typeof plural.POST).toBe("function");
    expect(plural.POST).toBe(singular.POST);
  });
});
