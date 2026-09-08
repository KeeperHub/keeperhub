import { describe, expect, it } from "vitest";

import { remapTemplateRefsInString } from "@/lib/utils/template";

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
