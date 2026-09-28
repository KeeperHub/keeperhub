import { describe, expect, it } from "vitest";

import {
  remapNodeReferencesInConfig,
  remapTemplateRefsInString,
} from "@/lib/utils/template";

describe("remapTemplateRefsInString", () => {
  it("remaps single template reference to new node ID", () => {
    const idMap = new Map<string, string>([["trigger-1", "new-id-abc"]]);
    const value = "{{@trigger-1:Manual Trigger.value}}";
    expect(remapTemplateRefsInString(value, idMap)).toBe(
      "{{@new-id-abc:Manual Trigger.value}}"
    );
  });

  it("remaps multiple template references in one string", () => {
    const idMap = new Map<string, string>([
      ["node-a", "id-1"],
      ["node-b", "id-2"],
    ]);
    const value = "{{@node-a:Step A.output}} and {{@node-b:Step B.result}}";
    expect(remapTemplateRefsInString(value, idMap)).toBe(
      "{{@id-1:Step A.output}} and {{@id-2:Step B.result}}"
    );
  });

  it("leaves unmapped node IDs unchanged", () => {
    const idMap = new Map<string, string>([["trigger-1", "new-id"]]);
    const value = "{{@other-node:Other.value}}";
    expect(remapTemplateRefsInString(value, idMap)).toBe(
      "{{@other-node:Other.value}}"
    );
  });

  it("returns empty string unchanged", () => {
    const idMap = new Map<string, string>([["a", "b"]]);
    expect(remapTemplateRefsInString("", idMap)).toBe("");
  });

  it("returns string with no template refs unchanged", () => {
    const idMap = new Map<string, string>([["a", "b"]]);
    const value = "plain text and {{ something else }}";
    expect(remapTemplateRefsInString(value, idMap)).toBe(value);
  });

  it("remaps condition-style expression", () => {
    const idMap = new Map<string, string>([["trigger-1", "xyz789"]]);
    const value = "{{@trigger-1:Manual Trigger.value}} > 100";
    expect(remapTemplateRefsInString(value, idMap)).toBe(
      "{{@xyz789:Manual Trigger.value}} > 100"
    );
  });
});

/**
 * Duplicating a workflow gives every node a new id. A field that stores a bare
 * node id rather than a template used to survive that unchanged and go on
 * naming a node in the workflow it was copied from.
 */
describe("remapNodeReferencesInConfig", () => {
  const idMap = new Map<string, string>([
    ["trigger-old", "trigger-new"],
    ["check-old", "check-new"],
  ]);

  const nodeRefKeys = new Set(["dedupKeyFromNodeId"]);

  it("remaps a bare node id under a key that declares it holds one", () => {
    expect(
      remapNodeReferencesInConfig(
        { dedupKeyFromNodeId: "trigger-old" },
        idMap,
        nodeRefKeys
      )
    ).toEqual({ dedupKeyFromNodeId: "trigger-new" });
  });

  /**
   * An imported workflow keeps whatever node ids its JSON carried, and those
   * can be as short as `n-1`. Rewriting any value that happens to match one
   * would silently corrupt another plugin's config, so only a declared node
   * picker's key is rewritten.
   */
  it("leaves a matching value alone under any other key", () => {
    expect(
      remapNodeReferencesInConfig(
        { someOtherField: "trigger-old", dedupKeyFromNodeId: "trigger-old" },
        idMap,
        nodeRefKeys
      )
    ).toEqual({
      someOtherField: "trigger-old",
      dedupKeyFromNodeId: "trigger-new",
    });
  });

  it("rewrites no bare value at all when no keys are declared", () => {
    expect(
      remapNodeReferencesInConfig({ dedupKeyFromNodeId: "trigger-old" }, idMap)
    ).toEqual({ dedupKeyFromNodeId: "trigger-old" });
  });

  it("still remaps template references inside a string, under any key", () => {
    expect(
      remapNodeReferencesInConfig(
        { summary: "Vault {{@check-old:Check.id}} stalled" },
        idMap
      )
    ).toEqual({ summary: "Vault {{@check-new:Check.id}} stalled" });
  });

  it("leaves a value that is not a node id alone", () => {
    expect(
      remapNodeReferencesInConfig(
        { summary: "trigger-older", dedupKey: "keeperhub/wf/trigger-old" },
        idMap
      )
    ).toEqual({
      summary: "trigger-older",
      dedupKey: "keeperhub/wf/trigger-old",
    });
  });

  it("reaches into nested objects for template references", () => {
    expect(
      remapNodeReferencesInConfig(
        { group: { summary: "{{@check-old:Check.id}}" } },
        idMap
      )
    ).toEqual({ group: { summary: "{{@check-new:Check.id}}" } });
  });

  it("passes a missing config straight through", () => {
    expect(remapNodeReferencesInConfig(undefined, idMap)).toBeUndefined();
  });
});
