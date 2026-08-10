import { beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());
const spawnSyncMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
  spawnSync: spawnSyncMock,
}));

import {
  type PnpmRuntime,
  resolvePnpmInvocation,
  spawnPnpm,
  spawnPnpmSync,
} from "@/scripts/lib/pnpm-process";

const WINDOWS_NODE = "C:\\Program Files\\nodejs\\node.exe";
const WINDOWS_PNPM_CLI = "C:\\Users\\dev\\AppData\\Local\\pnpm\\pnpm.cjs";

function runtime(
  platform: NodeJS.Platform,
  env: Partial<NodeJS.ProcessEnv> = {}
): PnpmRuntime {
  return {
    env: { NODE_ENV: "test", ...env },
    execPath: platform === "win32" ? WINDOWS_NODE : "/usr/local/bin/node",
    platform,
  };
}

describe("resolvePnpmInvocation", () => {
  it("uses Node plus npm_execpath on Windows and preserves argument boundaries", () => {
    const args = ["tsx", "script.ts", "value & calc.exe"];
    const invocation = resolvePnpmInvocation(
      args,
      runtime("win32", {
        npm_config_user_agent: "pnpm/9.15.0 npm/? node/v24.0.0 win32 x64",
        npm_execpath: WINDOWS_PNPM_CLI,
      })
    );

    expect(invocation).toEqual({
      args: [WINDOWS_PNPM_CLI, ...args],
      command: WINDOWS_NODE,
    });
  });

  it("uses the same shell-free Node invocation on non-Windows platforms", () => {
    expect(
      resolvePnpmInvocation(
        ["dev"],
        runtime("linux", {
          npm_config_user_agent: "pnpm/9.15.0 npm/? node/v24.0.0 linux x64",
          npm_execpath: "/opt/pnpm/pnpm.cjs",
        })
      )
    ).toEqual({
      args: ["/opt/pnpm/pnpm.cjs", "dev"],
      command: "/usr/local/bin/node",
    });
  });

  it("keeps the existing pnpm PATH fallback on non-Windows platforms", () => {
    expect(resolvePnpmInvocation(["dev"], runtime("darwin"))).toEqual({
      args: ["dev"],
      command: "pnpm",
    });
  });

  it("reports how to recover when Windows has no pnpm CLI context", () => {
    expect(() => resolvePnpmInvocation(["dev"], runtime("win32"))).toThrowError(
      "Run this command through pnpm"
    );
  });
});

describe("pnpm subprocess wrappers", () => {
  const windowsRuntime = runtime("win32", {
    npm_config_user_agent: "pnpm/9.15.0 npm/? node/v24.0.0 win32 x64",
    npm_execpath: WINDOWS_PNPM_CLI,
  });

  beforeEach(() => {
    spawnMock.mockReset();
    spawnSyncMock.mockReset();
  });

  it("returns the real sync result including status, stdout and stderr", () => {
    const result = {
      error: undefined,
      output: [null, "stdout text", "stderr text"],
      pid: 42,
      signal: null,
      status: 17,
      stderr: "stderr text",
      stdout: "stdout text",
    };
    spawnSyncMock.mockReturnValue(result);

    expect(
      spawnPnpmSync(["tsx", "script.ts"], { encoding: "utf8" }, windowsRuntime)
    ).toBe(result);
    expect(spawnSyncMock).toHaveBeenCalledWith(
      WINDOWS_NODE,
      [WINDOWS_PNPM_CLI, "tsx", "script.ts"],
      expect.objectContaining({ encoding: "utf8", shell: false })
    );
  });

  it("forces shell off for async children without changing other options", () => {
    const child = { pid: 42 };
    spawnMock.mockReturnValue(child);

    expect(
      spawnPnpm(
        ["dev"],
        { cwd: "C:\\repo", detached: true, shell: true },
        windowsRuntime
      )
    ).toBe(child);
    expect(spawnMock).toHaveBeenCalledWith(
      WINDOWS_NODE,
      [WINDOWS_PNPM_CLI, "dev"],
      expect.objectContaining({
        cwd: "C:\\repo",
        detached: true,
        shell: false,
      })
    );
  });
});
