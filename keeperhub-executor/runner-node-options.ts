import { spawnSync } from "node:child_process";

// Heap cap every runner pod gets; see the NODE_OPTIONS entry in k8s-job.ts for
// why it is sized against the pod memory limit.
export const RUNNER_BASE_NODE_OPTIONS = "--max-old-space-size=512";

const VALIDATION_TIMEOUT_MS = 10_000;

/**
 * NODE_OPTIONS for runner pods: the fixed base plus RUNNER_EXTRA_NODE_OPTIONS
 * from the executor's env. The executor's own NODE_OPTIONS is never relayed to
 * the runner, so this is the one place a deployment can add a runner Node flag.
 * Without extra options the value is exactly the base.
 */
export function buildRunnerNodeOptions(extra: string): string {
  const trimmed = extra.trim();
  return trimmed
    ? `${RUNNER_BASE_NODE_OPTIONS} ${trimmed}`
    : RUNNER_BASE_NODE_OPTIONS;
}

/**
 * Throw when the runner NODE_OPTIONS would stop Node from starting.
 *
 * Node refuses to boot on an unknown flag or one that NODE_OPTIONS does not
 * allow, so a typo in RUNNER_EXTRA_NODE_OPTIONS would fail every runner pod
 * while the executor itself looks healthy. Checking it at executor startup
 * turns that into a failed rollout instead. The runner and executor images are
 * built from the same Node base image, so this process's Node is the one the
 * runner will use.
 */
export function assertRunnerNodeOptions(extra: string): void {
  if (!extra.trim()) {
    return;
  }
  const nodeOptions = buildRunnerNodeOptions(extra);
  const result = spawnSync(process.execPath, ["-e", ""], {
    env: { ...process.env, NODE_OPTIONS: nodeOptions },
    encoding: "utf8",
    timeout: VALIDATION_TIMEOUT_MS,
  });
  if (result.error || result.status !== 0) {
    const detail =
      result.error?.message ||
      result.stderr?.trim() ||
      `exit status ${result.status}`;
    throw new Error(
      `RUNNER_EXTRA_NODE_OPTIONS is rejected by Node (NODE_OPTIONS="${nodeOptions}"): ${detail}`
    );
  }
}
