import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/workflow/executor/step-handler", async () =>
  (await import("../mocks/step-mocks")).stepHandlerPassthrough()
);

vi.mock("@/lib/credential-fetcher", () => ({
  fetchCredentials: vi.fn(),
}));

vi.mock("@/lib/safe-fetch", () => ({
  safeFetch: vi.fn(),
}));

import { getIntegration } from "@/plugins/registry";

describe("AI Gateway registry discovery", () => {
  const cases: Array<{
    slug: string;
    stepFunction: string;
    load: () => Promise<Record<string, unknown>>;
  }> = [
    {
      slug: "generate-text",
      stepFunction: "generateTextStep",
      load: () => import("@/plugins/ai-gateway/steps/generate-text"),
    },
    {
      slug: "generate-image",
      stepFunction: "generateImageStep",
      load: () => import("@/plugins/ai-gateway/steps/generate-image"),
    },
  ];

  it.each(cases)("discovers ai-gateway/$slug", async (testCase) => {
    const plugin = getIntegration("ai-gateway");
    const action = plugin?.actions.find(
      (candidate) => candidate.slug === testCase.slug
    );

    expect(action).toMatchObject({
      stepFunction: testCase.stepFunction,
      stepImportPath: testCase.slug,
    });
    const stepModule = await testCase.load();
    expect(stepModule[testCase.stepFunction]).toBeTypeOf("function");
  });
});
