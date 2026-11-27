import { describe, expect, it } from "vitest";
import {
  isOrgSettingRouteError,
  RpcRouteError,
  RpcRouteErrorCode,
} from "@/lib/rpc/engine/route-error";

describe("isOrgSettingRouteError", () => {
  it("is true for a refusal the organization's RPC settings caused", () => {
    expect(
      isOrgSettingRouteError(
        new RpcRouteError(RpcRouteErrorCode.CONFIG_DISABLED, 1)
      )
    ).toBe(true);
  });

  it.each([
    RpcRouteErrorCode.CHAIN_UNAVAILABLE,
    RpcRouteErrorCode.NO_SUBSCRIBE_ENDPOINT,
    RpcRouteErrorCode.WRONG_CHAIN_FAMILY,
  ])("is false for %s, which KeeperHub's chain setup causes", (code) => {
    expect(isOrgSettingRouteError(new RpcRouteError(code, 1))).toBe(false);
  });

  it("is false for any other error", () => {
    expect(isOrgSettingRouteError(new Error("down"))).toBe(false);
  });

  it("recognises a refusal from another copy of the module", async () => {
    const original = new RpcRouteError(RpcRouteErrorCode.NOT_COVERED, 1);
    const copy = Object.assign(new Error(original.message), {
      code: original.code,
      [Symbol.for("keeperhub.rpc.routeError")]: true,
    });
    expect(isOrgSettingRouteError(copy)).toBe(true);
  });
});
