import { afterEach, describe, expect, it } from "vitest";

import { buildActionSchemasResponse } from "@/lib/action-schemas/builder";

const originalPythApiKey = process.env.PYTH_API_KEY;

async function triggerKeys(): Promise<string[]> {
  const response = await buildActionSchemasResponse({
    category: "triggers",
    includeChains: false,
    endpointLabel: "test",
  });
  return Object.keys(response.triggers as object);
}

describe("action schemas Pyth trigger availability", () => {
  afterEach(() => {
    if (originalPythApiKey === undefined) {
      delete process.env.PYTH_API_KEY;
    } else {
      process.env.PYTH_API_KEY = originalPythApiKey;
    }
  });

  it("omits Pyth Price when PYTH_API_KEY is unset", async () => {
    delete process.env.PYTH_API_KEY;

    const keys = await triggerKeys();

    expect(keys).not.toContain("Pyth Price");
    expect(keys).toContain("Manual");
  });

  it("lists Pyth Price when PYTH_API_KEY is set", async () => {
    process.env.PYTH_API_KEY = "test-pyth-api-key";

    expect(await triggerKeys()).toContain("Pyth Price");
  });
});
