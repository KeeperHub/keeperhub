import { describe, expect, it } from "vitest";

import { RPC_SELECTION_CONFIG_KEY } from "@/lib/rpc/engine/scope";
import { RpcSelectionMode } from "@/lib/rpc/engine/types";
import { stripOrgRpcSelection } from "@/lib/workflow/strip-org-rpc-selection";

function node(config: Record<string, unknown>) {
  return { id: "n1", data: { type: "action", label: "Read", config } };
}

describe("stripOrgRpcSelection", () => {
  it("clears a pinned config id", () => {
    const [copied] = stripOrgRpcSelection([
      node({ network: "1", [RPC_SELECTION_CONFIG_KEY]: "cfg_123" }),
    ]);
    expect(copied.data.config).toEqual({ network: "1" });
  });

  it.each([RpcSelectionMode.AUTO, RpcSelectionMode.PLATFORM])(
    "keeps %s",
    (value) => {
      const original = node({
        network: "1",
        [RPC_SELECTION_CONFIG_KEY]: value,
      });
      const [copied] = stripOrgRpcSelection([original]);
      expect(copied).toBe(original);
    }
  );

  it("leaves nodes without a selection or config untouched", () => {
    const bare = { id: "n2", data: { type: "trigger" } };
    const plain = node({ network: "1" });
    expect(stripOrgRpcSelection([bare, plain])).toEqual([bare, plain]);
  });

  it("does not change the source nodes", () => {
    const original = node({ [RPC_SELECTION_CONFIG_KEY]: "cfg_123" });
    stripOrgRpcSelection([original]);
    expect(original.data.config[RPC_SELECTION_CONFIG_KEY]).toBe("cfg_123");
  });
});
