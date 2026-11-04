// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunSource } from "@/lib/analytics/types";

const alerts = vi.hoisted(() => ({ enabled: null as boolean | null }));
vi.mock("@/lib/hooks/use-notifications", () => ({
  useAlertsEnabled: () => alerts.enabled,
}));
vi.mock("@/lib/hooks/use-organization", () => ({
  useOrganization: () => ({ organization: { id: "org-1" } }),
}));

import { useRunSources } from "@/components/analytics/use-run-sources";

let container: HTMLDivElement;
let root: Root;
let result: RunSource[] | null | undefined;
const NONE: RunSource[] = [];

function Probe(): null {
  result = useRunSources(NONE);
  return null;
}

beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
});

describe("useRunSources", () => {
  it("is null until alerts are known, so fetches wait instead of running twice", () => {
    alerts.enabled = null;
    act(() => root.render(<Probe />));
    expect(result).toBeNull();
  });

  it("asks for every source where alerts are on", () => {
    alerts.enabled = true;
    act(() => root.render(<Probe />));
    expect(result).toEqual([]);
  });

  it("leaves alert rows out where alerts are off", () => {
    alerts.enabled = false;
    act(() => root.render(<Probe />));
    expect(result).toEqual(["workflow", "direct"]);
  });
});
