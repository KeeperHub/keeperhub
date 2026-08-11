import {
  spawn,
  spawnSync,
  type ChildProcess,
  type SpawnOptions,
  type SpawnSyncOptions,
  type SpawnSyncOptionsWithStringEncoding,
  type SpawnSyncReturns,
} from "node:child_process";
import { extname } from "node:path";

export type PnpmRuntime = Pick<
  NodeJS.Process,
  "env" | "execPath" | "platform"
>;

export type PnpmInvocation = {
  args: string[];
  command: string;
};

function isPnpmProcess(env: NodeJS.ProcessEnv): boolean {
  return env.npm_config_user_agent?.toLowerCase().startsWith("pnpm/") ?? false;
}

const JAVASCRIPT_EXTENSIONS = new Set([".cjs", ".js", ".mjs"]);

/**
 * Resolves pnpm without invoking a shell. On Windows, pnpm may expose either
 * a JavaScript entry point or a standalone executable through npm_execpath.
 * Other platforms retain the existing pnpm-on-PATH behavior.
 */
export function resolvePnpmInvocation(
  args: readonly string[],
  runtime: PnpmRuntime = process
): PnpmInvocation {
  if (runtime.platform !== "win32") {
    return { args: [...args], command: "pnpm" };
  }

  const pnpmCli = runtime.env.npm_execpath;
  if (pnpmCli && isPnpmProcess(runtime.env)) {
    if (!JAVASCRIPT_EXTENSIONS.has(extname(pnpmCli).toLowerCase())) {
      return { args: [...args], command: pnpmCli };
    }
    return {
      args: [pnpmCli, ...args],
      command: runtime.execPath,
    };
  }

  throw new Error(
    "Unable to locate the pnpm CLI on Windows. Run this command through " +
      "pnpm (for example, `pnpm dev:login`) and try again."
  );
}

export function spawnPnpm(
  args: readonly string[],
  options: SpawnOptions = {},
  runtime: PnpmRuntime = process
): ChildProcess {
  const invocation = resolvePnpmInvocation(args, runtime);
  return spawn(invocation.command, invocation.args, {
    ...options,
    shell: false,
  });
}

export function spawnPnpmSync(
  args: readonly string[],
  options: SpawnSyncOptionsWithStringEncoding,
  runtime?: PnpmRuntime
): SpawnSyncReturns<string>;
export function spawnPnpmSync(
  args: readonly string[],
  options?: SpawnSyncOptions,
  runtime?: PnpmRuntime
): SpawnSyncReturns<Buffer>;
export function spawnPnpmSync(
  args: readonly string[],
  options: SpawnSyncOptions = {},
  runtime: PnpmRuntime = process
): SpawnSyncReturns<Buffer | string> {
  const invocation = resolvePnpmInvocation(args, runtime);
  return spawnSync(invocation.command, invocation.args, {
    ...options,
    shell: false,
  });
}
