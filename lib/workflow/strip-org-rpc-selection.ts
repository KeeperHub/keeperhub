import {
  parseRpcSelection,
  RPC_SELECTION_CONFIG_KEY,
} from "@/lib/rpc/engine/scope";
import { RpcSelectionMode } from "@/lib/rpc/engine/types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Nodes copied into a possibly different organization, with every pinned RPC
 * config cleared: config ids belong to the source organization. The keywords
 * auto and KeeperHub mean the same in any organization and are kept.
 */
export function stripOrgRpcSelection<T>(nodes: readonly T[]): T[] {
  return nodes.map((node) => {
    if (!isRecord(node)) {
      return node;
    }
    const { data } = node;
    if (!(isRecord(data) && isRecord(data.config))) {
      return node;
    }
    const { config } = data;
    if (
      !Object.hasOwn(config, RPC_SELECTION_CONFIG_KEY) ||
      parseRpcSelection(config[RPC_SELECTION_CONFIG_KEY]).mode !==
        RpcSelectionMode.CONFIG
    ) {
      return node;
    }
    const { [RPC_SELECTION_CONFIG_KEY]: _pinned, ...rest } = config;
    return { ...node, data: { ...data, config: rest } } as T;
  });
}
