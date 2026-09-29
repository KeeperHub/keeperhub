// @vitest-environment jsdom
//
// Beautifying turns a one-line field into a multi-line one, and the value then
// has to survive everything downstream of the editor: the badge editor that
// stores line breaks as <br>, the export envelope, and the import schema that
// reads it back. A formatted field that cannot be exported and re-imported is
// no better than one that was never formatted.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

import { TemplateBadgeTextarea } from "@/components/ui/template-badge-textarea";
import { beautifyJson } from "@/lib/utils/beautify";
import { workflowExportV1Schema } from "@/lib/workflow/export-schema";

const MINIFIED =
  '{"Authorization":"Bearer {{@n1:Set constants.result.KH_API_KEY}}","retries":3,"amount":12345678901234567890}';

function beautified(): string {
  const outcome = beautifyJson(MINIFIED);
  if (!outcome.ok) {
    throw new Error(`fixture did not format: ${outcome.error}`);
  }
  return outcome.value;
}

describe("a beautified value survives the badge editor", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("renders every line, and keeps the reference as one unit", () => {
    const value = beautified();
    act(() => {
      root.render(
        <TemplateBadgeTextarea
          onChange={() => {
            // not exercised here
          }}
          value={value}
        />
      );
    });

    const editable = container.querySelector('[contenteditable="true"]');
    expect(editable).not.toBeNull();

    // One <br> per line break in the formatted value.
    expect(container.querySelectorAll("br").length).toBe(
      value.split("\n").length - 1
    );

    // The reference is carried as a single badge holding its stored form,
    // rather than as loose text that a re-serialisation could split.
    const badge = container.querySelector("[data-template]");
    expect(badge?.getAttribute("data-template")).toBe(
      "{{@n1:Set constants.result.KH_API_KEY}}"
    );
  });
});

describe("a beautified value survives export and import", () => {
  function exportDocument(fieldValue: string): unknown {
    return {
      version: 1,
      exportedAt: new Date().toISOString(),
      integrationBindings: [],
      workflow: { name: "Round trip", description: "" },
      nodes: [
        {
          id: "n2",
          type: "action",
          position: { x: 0, y: 0 },
          data: {
            label: "HTTP Request",
            type: "action",
            config: {
              actionType: "HTTP Request",
              httpHeaders: fieldValue,
            },
          },
        },
      ],
      edges: [],
    };
  }

  it("comes back byte for byte through the import schema", () => {
    const value = beautified();
    // Serialise and re-parse the way an exported file is written and read.
    const onDisk = JSON.stringify(exportDocument(value));
    const parsed = workflowExportV1Schema.safeParse(JSON.parse(onDisk));

    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      return;
    }
    const config = parsed.data.nodes[0].data.config as Record<string, unknown>;
    expect(config.httpHeaders).toBe(value);
  });

  it("keeps the line breaks, the reference and a wei-scale integer", () => {
    const value = beautified();
    const parsed = workflowExportV1Schema.safeParse(
      JSON.parse(JSON.stringify(exportDocument(value)))
    );
    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      return;
    }
    const config = parsed.data.nodes[0].data.config as Record<string, unknown>;
    const back = String(config.httpHeaders);

    expect(back.split("\n").length).toBeGreaterThan(1);
    expect(back).toContain("{{@n1:Set constants.result.KH_API_KEY}}");
    expect(back).toContain("12345678901234567890");
  });

  it("is still stable: formatting the imported value changes nothing", () => {
    const value = beautified();
    const parsed = workflowExportV1Schema.safeParse(
      JSON.parse(JSON.stringify(exportDocument(value)))
    );
    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      return;
    }
    const config = parsed.data.nodes[0].data.config as Record<string, unknown>;
    const again = beautifyJson(String(config.httpHeaders));
    expect(again.ok).toBe(true);
    if (again.ok) {
      expect(again.value).toBe(value);
    }
  });

  it("an unformatted and a formatted field import to the same meaning", () => {
    const minified = workflowExportV1Schema.safeParse(
      JSON.parse(JSON.stringify(exportDocument(MINIFIED)))
    );
    const pretty = workflowExportV1Schema.safeParse(
      JSON.parse(JSON.stringify(exportDocument(beautified())))
    );
    expect(minified.success && pretty.success).toBe(true);
    if (!(minified.success && pretty.success)) {
      return;
    }
    const readValue = (result: typeof minified): string => {
      if (!result.success) {
        return "";
      }
      const config = result.data.nodes[0].data.config as Record<
        string,
        unknown
      >;
      return String(config.httpHeaders).replace(/[ \n]/g, "");
    };
    expect(readValue(pretty)).toBe(readValue(minified));
  });
});
