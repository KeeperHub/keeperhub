/**
 * cgroup v2 Memory Readings
 *
 * Reads the kernel's own memory accounting for this container. This is the
 * number the OOM killer compares against the limit, so it is what decides
 * whether the process lives, and it is strictly more authoritative than
 * process.memoryUsage().rss - RSS excludes page cache that still counts toward
 * the cgroup.
 *
 * memory.peak is the important one. It is a high-water mark maintained by the
 * kernel continuously, so unlike any sampled value it cannot miss a spike that
 * opens and closes between two reads. cadvisor samples once per 60s and
 * container_memory_max_usage_bytes is not shipped to our Mimir tenant, which is
 * why a container has crossed its limit and died leaving nothing behind.
 *
 * Everything here degrades to null rather than throwing. The files are absent
 * on macOS, on cgroup v1 hosts, and in most local dev setups, and none of that
 * is worth an error.
 */

import "server-only";

import { readFileSync } from "node:fs";

const CGROUP_ROOT = "/sys/fs/cgroup";

// Anchored to the line start so it cannot match oom_group_kill, which sits on
// its own line in memory.events and carries a different meaning.
const OOM_KILL_REGEX = /^oom_kill (\d+)$/m;

export type CgroupMemory = {
  /** Current charge against the cgroup, in bytes. */
  current: number;
  /** Kernel high-water mark since the container started, in bytes. */
  peak: number | null;
  /** The limit, in bytes. null when the cgroup is unlimited ("max"). */
  limit: number | null;
};

function readBytes(file: string): number | null {
  try {
    const raw = readFileSync(`${CGROUP_ROOT}/${file}`, "utf8").trim();
    // memory.max reads the literal string "max" when no limit is set.
    if (raw === "max" || raw === "") {
      return null;
    }
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * Read the cgroup memory triple. Returns null when this process is not in a
 * readable cgroup v2, which is the normal case off-cluster.
 */
export function readCgroupMemory(): CgroupMemory | null {
  const current = readBytes("memory.current");
  if (current === null) {
    return null;
  }
  return {
    current,
    peak: readBytes("memory.peak"),
    limit: readBytes("memory.max"),
  };
}

/**
 * Count of OOM kills the kernel has performed in this cgroup.
 *
 * Resets with the cgroup, so it counts kills of the *current* container rather
 * than restarts of the pod. A non-zero value means this container survived a
 * kill of one of its child processes.
 */
export function readCgroupOomKills(): number | null {
  try {
    const raw = readFileSync(`${CGROUP_ROOT}/memory.events`, "utf8");
    const match = raw.match(OOM_KILL_REGEX);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}
