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
const WINDOWS_PNPM_EXE = "C:\\Users\\dev\\AppData\\Local\\pnpm\\pnpm.exe";

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
  it.each([".js", ".cjs", ".mjs"])(
    "uses Node for a Windows pnpm %s entry point",
    (extension) => {
      const pnpmCli = `C:\\Users\\dev\\AppData\\Local\\pnpm\\pnpm${extension}`;
      const args = ["tsx", "script.ts", "value & calc.exe"];
      const invocation = resolvePnpmInvocation(
        args,
        runtime("win32", {
          npm_config_user_agent: "pnpm/9.15.0 npm/? node/v24.0.0 win32 x64",
          npm_execpath: pnpmCli,
        })
      );

      expect(invocation).toEqual({
        args: [pnpmCli, ...args],
        command: WINDOWS_NODE,
      });
    }
  );

  it("runs a standalone pnpm executable directly on Windows", () => {
    const args = ["tsx", "script.ts", "value & calc.exe"];
    expect(
      resolvePnpmInvocation(
        args,
        runtime("win32", {
          npm_config_user_agent: "pnpm/10.15.0 node/v24.0.0 win32 x64",
          npm_execpath: WINDOWS_PNPM_EXE,
        })
      )
    ).toEqual({
      args,
      command: WINDOWS_PNPM_EXE,
    });
  });

  it("keeps the existing pnpm PATH behavior on Linux", () => {
    expect(
      resolvePnpmInvocation(
        ["dev"],
        runtime("linux", {
          npm_config_user_agent: "pnpm/9.15.0 npm/? node/v24.0.0 linux x64",
          npm_execpath: "/opt/pnpm/pnpm.cjs",
        })
      )
    ).toEqual({
      args: ["dev"],
      command: "pnpm",
    });
  });

  it("keeps the existing pnpm PATH behavior on macOS with a native npm_execpath", () => {
    expect(
      resolvePnpmInvocation(
        ["dev"],
        runtime("darwin", {
          npm_config_user_agent: "pnpm/10.15.0 node/v24.0.0 darwin arm64",
          npm_execpath: "/opt/pnpm/pnpm",
        })
      )
    ).toEqual({
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
