import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  orgScope,
  parseRpcSelection,
  platformScope,
  rpcSelectionValue,
} from "@/lib/rpc/engine/scope";
import { PlatformRpcPurpose } from "@/lib/rpc/engine/types";

describe("rpcSelectionValue", () => {
  it.each(["platform", "cfg_archive"])(
    "stores %s so parseRpcSelection reads the same selection back",
    (value) => {
      const scope = orgScope("org_1", parseRpcSelection(value));
      expect(rpcSelectionValue(scope)).toBe(value);
    }
  );

  it("stores nothing for Auto or a scope without a selection", () => {
    expect(rpcSelectionValue(orgScope("org_1"))).toBeNull();
    expect(
      rpcSelectionValue(platformScope(PlatformRpcPurpose.BILLING))
    ).toBeNull();
  });
});
