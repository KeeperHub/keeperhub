// A category filter that matches nothing used to return an empty action map
// with a 200, which reads as "this action does not exist" rather than "that
// is not a category". The response now names the valid categories instead.

import { describe, expect, it } from "vitest";

import { buildActionSchemasResponse } from "@/lib/action-schemas/builder";

async function build(category?: string): Promise<Record<string, unknown>> {
  return await buildActionSchemasResponse({
    category,
    includeChains: false,
    endpointLabel: "test",
  });
}

describe("action schemas unknown category filter", () => {
  it("names the valid categories when the filter matches nothing", async () => {
    const response = await build("datas");

    expect(Object.keys(response.actions as object)).toHaveLength(0);
    expect(response.availableCategories).toContain("data");
    expect(response.availableCategories).toContain("system");
    expect(response.availableCategories).toContain("triggers");
  });

  it("omits the hint when the filter matches actions", async () => {
    const response = await build("data");

    expect(Object.keys(response.actions as object).length).toBeGreaterThan(0);
    expect(response.availableCategories).toBeUndefined();
  });

  it("omits the hint when no filter is given", async () => {
    const response = await build();

    expect(response.availableCategories).toBeUndefined();
  });

  // category=triggers fills the `triggers` key and leaves `actions` empty by
  // design, so a hint keyed on `actions` alone would reject a valid filter
  // and point the caller straight back at it.
  it("omits the hint for triggers, which populates its own key", async () => {
    const response = await build("triggers");

    expect(Object.keys(response.actions as object)).toHaveLength(0);
    expect(Object.keys(response.triggers as object).length).toBeGreaterThan(0);
    expect(response.availableCategories).toBeUndefined();
  });

  it("omits the hint for system, which populates actions", async () => {
    const response = await build("system");

    expect(Object.keys(response.actions as object).length).toBeGreaterThan(0);
    expect(response.availableCategories).toBeUndefined();
  });

  // The type filter must neither trigger the hint nor suppress it: what
  // decides is whether the category itself matched, judged before the type
  // narrows the map.
  it("emits the hint when the category is wrong and the type is valid", async () => {
    const response = await buildActionSchemasResponse({
      category: "web33",
      type: "web3/read-contract",
      includeChains: false,
      endpointLabel: "test",
    });

    expect(Object.keys(response.actions as object)).toHaveLength(0);
    expect(response.availableCategories).toContain("web3");
  });

  // A category list cannot correct a mistyped actionType, and naming the
  // category the caller got right reads as though that were the mistake.
  it("omits the hint when a valid category carries an unmatched type", async () => {
    const response = await buildActionSchemasResponse({
      category: "web3",
      type: "web3/read-contarct",
      includeChains: false,
      endpointLabel: "test",
    });

    expect(Object.keys(response.actions as object)).toHaveLength(0);
    expect(response.availableCategories).toBeUndefined();
  });

  it("omits the hint for an unmatched type filter, which it cannot correct", async () => {
    const response = await buildActionSchemasResponse({
      type: "web3/check-balnce",
      includeChains: false,
      endpointLabel: "test",
    });

    expect(Object.keys(response.actions as object)).toHaveLength(0);
    expect(response.availableCategories).toBeUndefined();
  });

  it("matches a category case-insensitively", async () => {
    const response = await build("Data");

    expect(response.actions).toHaveProperty("data/hash");
    expect(response.availableCategories).toBeUndefined();
  });

  it("lists every registered plugin type as a valid category", async () => {
    const response = await build("no-such-category");
    const categories = response.availableCategories as string[];

    expect(categories).toContain("web3");
    expect(categories).toEqual([...categories].sort());
  });
});
