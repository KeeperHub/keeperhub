// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock is hoisted above the file body, so the spy has to be hoisted too.
const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }));
vi.mock("sonner", () => ({ toast: { error: toastError } }));

import { useBeautify } from "@/lib/hooks/use-beautify";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  toastError.mockClear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

type HarnessProps = {
  read: () => string;
  apply: (value: string) => void;
  language: string;
  disabled?: boolean;
};

function Harness({ read, apply, language, disabled }: HarnessProps) {
  const { pending, beautify } = useBeautify({
    apply,
    disabled,
    language,
    read,
  });
  return (
    <button data-pending={pending} onClick={beautify} type="button">
      go
    </button>
  );
}

function button(): HTMLButtonElement {
  const found = container.querySelector("button");
  if (!found) {
    throw new Error("no button");
  }
  return found;
}

async function click(): Promise<void> {
  await act(async () => {
    button().click();
  });
}

describe("useBeautify", () => {
  it("applies the formatted value", async () => {
    const apply = vi.fn();
    act(() => {
      root.render(
        <Harness apply={apply} language="json" read={() => '{"a":1}'} />
      );
    });
    await click();
    expect(apply).toHaveBeenCalledWith('{\n  "a": 1\n}');
  });

  it("does not write back when formatting changed nothing", async () => {
    const apply = vi.fn();
    const already = '{\n  "a": 1\n}';
    act(() => {
      root.render(
        <Harness apply={apply} language="json" read={() => already} />
      );
    });
    await click();
    expect(apply).not.toHaveBeenCalled();
  });

  // The editor stays typable while a format runs, and the first JavaScript
  // format waits on Prettier's chunks. A field that moved in that window must
  // not have the pre-click text written over it.
  it("abandons the write when the field changed while formatting", async () => {
    const apply = vi.fn();
    let current = '{"a":1}';
    act(() => {
      root.render(
        <Harness apply={apply} language="json" read={() => current} />
      );
    });
    await act(async () => {
      button().click();
      current = '{"a":2}';
    });
    expect(apply).not.toHaveBeenCalled();
  });

  it("reports a parse failure and leaves the field alone", async () => {
    const apply = vi.fn();
    act(() => {
      root.render(
        <Harness apply={apply} language="json" read={() => '{"a":}'} />
      );
    });
    await click();
    expect(apply).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledWith(
      "Could not beautify",
      expect.objectContaining({ description: expect.any(String) })
    );
  });

  it("does nothing while disabled", async () => {
    const apply = vi.fn();
    act(() => {
      root.render(
        <Harness
          apply={apply}
          disabled
          language="json"
          read={() => '{"a":1}'}
        />
      );
    });
    await click();
    expect(apply).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
  });

  it("refuses a language with no formatter behind it", async () => {
    const apply = vi.fn();
    act(() => {
      root.render(
        <Harness apply={apply} language="sql" read={() => "select 1"} />
      );
    });
    await click();
    expect(apply).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalled();
  });

  it("clears pending after a run", async () => {
    const apply = vi.fn();
    act(() => {
      root.render(
        <Harness apply={apply} language="json" read={() => '{"a":1}'} />
      );
    });
    await click();
    expect(button().getAttribute("data-pending")).toBe("false");
  });
});
