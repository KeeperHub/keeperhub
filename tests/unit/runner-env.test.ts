import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  getRunnerSystemEnvVars,
  RUNNER_SYSTEM_ENV_VARS,
} from "@/keeperhub-executor/runner-env";

const SNAPSHOT_KEYS = [...RUNNER_SYSTEM_ENV_VARS] as const;
const originalEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of SNAPSHOT_KEYS) {
    originalEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of SNAPSHOT_KEYS) {
    if (originalEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = originalEnv[key];
    }
  }
});

describe("RUNNER_SYSTEM_ENV_VARS", () => {
  it("includes SANDBOX_BACKEND", () => {
    expect(RUNNER_SYSTEM_ENV_VARS).toContain("SANDBOX_BACKEND");
  });

  it("includes SANDBOX_URL", () => {
    expect(RUNNER_SYSTEM_ENV_VARS).toContain("SANDBOX_URL");
  });

  it("is alphabetically sorted", () => {
    const sorted = [...RUNNER_SYSTEM_ENV_VARS].sort();
    expect([...RUNNER_SYSTEM_ENV_VARS]).toEqual(sorted);
  });
});

describe("getRunnerSystemEnvVars", () => {
  it("forwards SANDBOX_BACKEND and SANDBOX_URL when set", () => {
    process.env.SANDBOX_BACKEND = "remote";
    process.env.SANDBOX_URL =
      "http://keeperhub-sandbox-common.keeperhub.svc.cluster.local:8787";

    const vars = getRunnerSystemEnvVars();

    expect(vars).toContainEqual({
      name: "SANDBOX_BACKEND",
      value: "remote",
    });
    expect(vars).toContainEqual({
      name: "SANDBOX_URL",
      value: "http://keeperhub-sandbox-common.keeperhub.svc.cluster.local:8787",
    });
  });

  it("omits SANDBOX_* when unset", () => {
    const vars = getRunnerSystemEnvVars();
    const names = vars.map((v) => v.name);

    expect(names).not.toContain("SANDBOX_BACKEND");
    expect(names).not.toContain("SANDBOX_URL");
  });

  it("only emits entries for env vars that are set", () => {
    process.env.OPENAI_API_KEY = "sk-test";

    const vars = getRunnerSystemEnvVars();

    expect(vars).toEqual([{ name: "OPENAI_API_KEY", value: "sk-test" }]);
  });
});
