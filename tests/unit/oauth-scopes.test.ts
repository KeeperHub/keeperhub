import { describe, expect, it } from "vitest";
import {
  isToolAllowed,
  parseScopeInput,
  scopeSatisfies,
} from "@/lib/mcp/oauth-scopes";

describe("oauth-scopes — prepare_test_pin_data (TESTWF-06)", () => {
  it("mcp:read allows prepare_test_pin_data", () => {
    expect(isToolAllowed("prepare_test_pin_data", "mcp:read")).toBe(true);
  });

  it("mcp:write allows prepare_test_pin_data (write inherits read)", () => {
    expect(isToolAllowed("prepare_test_pin_data", "mcp:write")).toBe(true);
  });

  it("mcp:admin allows prepare_test_pin_data", () => {
    expect(isToolAllowed("prepare_test_pin_data", "mcp:admin")).toBe(true);
  });

  it("empty scope denies prepare_test_pin_data", () => {
    expect(isToolAllowed("prepare_test_pin_data", "")).toBe(false);
  });

  it("unknown scope denies prepare_test_pin_data", () => {
    expect(isToolAllowed("prepare_test_pin_data", "bogus:scope")).toBe(false);
  });
});

describe("oauth-scopes — read-only consent (only the Read box ticked)", () => {
  it("mcp:read allows read tools", () => {
    expect(isToolAllowed("list_workflows", "mcp:read")).toBe(true);
    expect(isToolAllowed("get_workflow", "mcp:read")).toBe(true);
  });

  it("mcp:read denies write/execute tools", () => {
    expect(isToolAllowed("create_workflow", "mcp:read")).toBe(false);
    expect(isToolAllowed("update_workflow", "mcp:read")).toBe(false);
    expect(isToolAllowed("delete_workflow", "mcp:read")).toBe(false);
    expect(isToolAllowed("execute_workflow", "mcp:read")).toBe(false);
    expect(isToolAllowed("deploy_template", "mcp:read")).toBe(false);
  });
});

describe("oauth-scopes — project & tag tools", () => {
  it("mcp:read allows listing projects and tags", () => {
    expect(isToolAllowed("list_projects", "mcp:read")).toBe(true);
    expect(isToolAllowed("list_tags", "mcp:read")).toBe(true);
  });

  it("mcp:read denies creating projects and tags", () => {
    expect(isToolAllowed("create_project", "mcp:read")).toBe(false);
    expect(isToolAllowed("create_tag", "mcp:read")).toBe(false);
  });

  it("mcp:write allows creating projects and tags", () => {
    expect(isToolAllowed("create_project", "mcp:write")).toBe(true);
    expect(isToolAllowed("create_tag", "mcp:write")).toBe(true);
    expect(isToolAllowed("list_projects", "mcp:write")).toBe(true);
    expect(isToolAllowed("list_tags", "mcp:write")).toBe(true);
  });
});

describe("oauth-scopes — scopeSatisfies (A-03)", () => {
  it("undefined granted scope passes every level (unscoped caller)", () => {
    expect(scopeSatisfies(undefined, "mcp:read")).toBe(true);
    expect(scopeSatisfies(undefined, "mcp:write")).toBe(true);
    expect(scopeSatisfies(undefined, "mcp:admin")).toBe(true);
  });

  it("treats a NULL API key scope column as unscoped, not as an empty grant", () => {
    // authenticateApiKey coerces the nullable column with `?? undefined`.
    // The two must not be conflated: null means full access, "" denies all.
    const nullScopeColumn: string | null = null;

    expect(scopeSatisfies(nullScopeColumn ?? undefined, "mcp:write")).toBe(
      true
    );
    expect(scopeSatisfies("", "mcp:write")).toBe(false);
  });

  it("gates an API key scope string exactly like an OAuth scope claim", () => {
    // /api/execute/* now forwards the key's scope to requireScope, so a key
    // minted mcp:read must fail a write sink.
    expect(scopeSatisfies("mcp:read", "mcp:write")).toBe(false);
    expect(scopeSatisfies("mcp:read", "mcp:read")).toBe(true);
    expect(scopeSatisfies("mcp:admin", "mcp:write")).toBe(true);
  });

  it("mcp:read satisfies read but not write or admin", () => {
    expect(scopeSatisfies("mcp:read", "mcp:read")).toBe(true);
    expect(scopeSatisfies("mcp:read", "mcp:write")).toBe(false);
    expect(scopeSatisfies("mcp:read", "mcp:admin")).toBe(false);
  });

  it("mcp:write satisfies read and write but not admin", () => {
    expect(scopeSatisfies("mcp:write", "mcp:read")).toBe(true);
    expect(scopeSatisfies("mcp:write", "mcp:write")).toBe(true);
    expect(scopeSatisfies("mcp:write", "mcp:admin")).toBe(false);
  });

  it("mcp:admin satisfies every level", () => {
    expect(scopeSatisfies("mcp:admin", "mcp:read")).toBe(true);
    expect(scopeSatisfies("mcp:admin", "mcp:write")).toBe(true);
    expect(scopeSatisfies("mcp:admin", "mcp:admin")).toBe(true);
  });

  it("a space-separated grant passes when any token has sufficient rank", () => {
    expect(scopeSatisfies("mcp:read mcp:write", "mcp:write")).toBe(true);
    expect(scopeSatisfies("mcp:read mcp:write", "mcp:admin")).toBe(false);
  });

  it("empty or all-invalid grant fails every level", () => {
    expect(scopeSatisfies("", "mcp:read")).toBe(false);
    expect(scopeSatisfies("bogus:x", "mcp:read")).toBe(false);
    expect(scopeSatisfies("bogus:x", "mcp:write")).toBe(false);
    expect(scopeSatisfies("bogus:x", "mcp:admin")).toBe(false);
  });
});

describe("parseScopeInput — null means unrestricted, so only omission may reach it", () => {
  it("returns null only when the field is absent", () => {
    expect(parseScopeInput(undefined)).toBeNull();
    // JSON clients routinely send null for an absent field.
    expect(parseScopeInput(null)).toBeNull();
  });

  it("floors a supplied but unreadable scopes value at mcp:read", () => {
    // scopes is unvalidated request body. An object is the shape the creation
    // overlay holds internally, and is the likeliest way one reaches the API.
    expect(parseScopeInput({ "mcp:read": true })).toBe("mcp:read");
    expect(parseScopeInput(true)).toBe("mcp:read");
    expect(parseScopeInput(false)).toBe("mcp:read");
    expect(parseScopeInput(0)).toBe("mcp:read");
  });

  it("narrows an explicitly empty scopes array to mcp:read", () => {
    expect(parseScopeInput([])).toBe("mcp:read");
  });

  it("narrows a scopes array with no usable strings to mcp:read", () => {
    expect(parseScopeInput([1, 2])).toBe("mcp:read");
    expect(parseScopeInput(["bogus"])).toBe("mcp:read");
    expect(parseScopeInput([""])).toBe("mcp:read");
  });

  it("narrows an explicitly empty scopes string to mcp:read", () => {
    expect(parseScopeInput("")).toBe("mcp:read");
    expect(parseScopeInput("   ")).toBe("mcp:read");
  });

  it("still normalizes a valid request unchanged", () => {
    expect(parseScopeInput(["mcp:write"])).toBe("mcp:write");
    expect(parseScopeInput("mcp:read mcp:write")).toBe("mcp:read mcp:write");
    expect(parseScopeInput(["mcp:write", "bogus"])).toBe("mcp:write");
  });
});
