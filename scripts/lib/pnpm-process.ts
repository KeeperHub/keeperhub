import {
  spawn,
  spawnSync,
  type ChildProcess,
  type SpawnOptions,
  type SpawnSyncOptions,
  type SpawnSyncOptionsWithStringEncoding,
  type SpawnSyncReturns,
} from "node:child_process";

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

/**
 * Resolves pnpm without invoking a shell. pnpm exposes its JavaScript entry
 * point as npm_execpath, so Windows can run it with the current Node binary
 * instead of trying to execute the pnpm.cmd shim through child_process.
 */
export function resolvePnpmInvocation(
  args: readonly string[],
  runtime: PnpmRuntime = process
): PnpmInvocation {
  const pnpmCli = runtime.env.npm_execpath;
  if (pnpmCli && isPnpmProcess(runtime.env)) {
    return {
      args: [pnpmCli, ...args],
      command: runtime.execPath,
    };
  }

  if (runtime.platform === "win32") {
    throw new Error(
      "Unable to locate the pnpm CLI on Windows. Run this command through " +
        "pnpm (for example, `pnpm dev:login`) and try again."
    );
  }

  return { args: [...args], command: "pnpm" };
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
