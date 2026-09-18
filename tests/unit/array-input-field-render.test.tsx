// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/ui/template-badge-input", () => ({
  TemplateBadgeInput: ({ value }: { value: string }) => (
    <input readOnly value={value} />
  ),
}));
vi.mock("@/components/ui/button", () => ({
  Button: ({ children }: { children: ReactNode }) => (
    <button type="button">{children}</button>
  ),
}));
vi.mock("@/components/workflow/config/tuple-input-field", () => ({
  TupleInputField: () => null,
}));

import { ArrayInputField } from "@/components/workflow/config/array-input-field";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
});

describe("ArrayInputField legacy migration", () => {
  it("writes a reopened comma-separated value back as a valid array", async () => {
    const onChange = vi.fn();

    await act(async () =>
      root.render(
        <ArrayInputField
          fieldKey="pools"
          itemType="address"
          onChange={onChange}
          value="0xpool1, 0xpool2"
        />
      )
    );

    expect(
      Array.from(container.querySelectorAll("input"), (input) => input.value)
    ).toEqual(["0xpool1", "0xpool2"]);
    expect(onChange).toHaveBeenCalledWith(["0xpool1", "0xpool2"]);
  });

  it("does not rewrite a legacy value while disabled", async () => {
    const onChange = vi.fn();

    await act(async () =>
      root.render(
        <ArrayInputField
          disabled
          fieldKey="pools"
          itemType="address"
          onChange={onChange}
          value="0xpool1"
        />
      )
    );

    expect(
      Array.from(container.querySelectorAll("input"), (input) => input.value)
    ).toEqual(["0xpool1"]);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("keeps displayed rows aligned when the legacy value changes", async () => {
    const onChange = vi.fn();

    await act(async () =>
      root.render(
        <ArrayInputField
          fieldKey="pools"
          itemType="address"
          onChange={onChange}
          value="0xpool1"
        />
      )
    );
    await act(async () =>
      root.render(
        <ArrayInputField
          fieldKey="pools"
          itemType="address"
          onChange={onChange}
          value="0xpool2, 0xpool3"
        />
      )
    );

    expect(
      Array.from(container.querySelectorAll("input"), (input) => input.value)
    ).toEqual(["0xpool2", "0xpool3"]);
    expect(onChange).toHaveBeenLastCalledWith(["0xpool2", "0xpool3"]);
  });
});
