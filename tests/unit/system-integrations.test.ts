import { describe, expect, it } from "vitest";
import {
  SYSTEM_ACTION_INTEGRATIONS,
  SYSTEM_INTEGRATION_DESCRIPTIONS,
  SYSTEM_INTEGRATION_LABELS,
  SYSTEM_INTEGRATION_TYPES,
} from "@/lib/integrations/system";
import { SYSTEM_INTEGRATION_TYPES as GENERATOR_SYSTEM_TYPES } from "../../scripts/discover-plugins";

/**
 * System integrations are declared in two places that cannot import each other:
 * scripts/discover-plugins.ts owns the slug list that feeds the generated
 * IntegrationType union, and lib/integrations/system.ts owns the labels,
 * descriptions and action mapping the UI reads. The generator deliberately has
 * no app imports so it can run before a build exists, so nothing but this test
 * stops the two from drifting.
 */
describe("system integration registry", () => {
  it("covers exactly the slugs the type generator emits", () => {
    expect([...SYSTEM_INTEGRATION_TYPES].sort()).toEqual(
      [...GENERATOR_SYSTEM_TYPES].sort()
    );
  });

  it("gives every system integration a label and a description", () => {
    for (const type of GENERATOR_SYSTEM_TYPES) {
      expect(SYSTEM_INTEGRATION_LABELS[type]).toBeTruthy();
      expect(SYSTEM_INTEGRATION_DESCRIPTIONS[type]).toBeTruthy();
    }
  });

  it("maps every system action onto a known system integration", () => {
    for (const integration of Object.values(SYSTEM_ACTION_INTEGRATIONS)) {
      expect(GENERATOR_SYSTEM_TYPES).toContain(integration);
    }
  });
});
