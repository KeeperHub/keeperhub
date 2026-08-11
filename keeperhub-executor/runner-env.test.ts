import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getRunnerSystemEnvVars, RUNNER_SYSTEM_ENV_VARS } from "./runner-env";

describe("runner-env", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("RUNNER_SYSTEM_ENV_VARS", () => {
    it("is sorted alphabetically", () => {
      const sorted = [...RUNNER_SYSTEM_ENV_VARS].sort();
      expect(RUNNER_SYSTEM_ENV_VARS).toEqual(sorted);
    });

    it("contains no duplicates", () => {
      const unique = new Set(RUNNER_SYSTEM_ENV_VARS);
      expect(unique.size).toBe(RUNNER_SYSTEM_ENV_VARS.length);
    });
  });

  describe("getRunnerSystemEnvVars", () => {
    it("returns empty array when no system vars are set", () => {
      for (const name of RUNNER_SYSTEM_ENV_VARS) {
        delete process.env[name];
      }

      const result = getRunnerSystemEnvVars();
      expect(result).toEqual([]);
    });

    it("includes only defined vars", () => {
      for (const name of RUNNER_SYSTEM_ENV_VARS) {
        delete process.env[name];
      }
      process.env.OPENAI_API_KEY = "sk-test";
      process.env.SLACK_API_KEY = "xoxb-test";

      const result = getRunnerSystemEnvVars();
      expect(result).toEqual([
        { name: "OPENAI_API_KEY", value: "sk-test" },
        { name: "SLACK_API_KEY", value: "xoxb-test" },
      ]);
    });

    it("skips vars set to undefined", () => {
      for (const name of RUNNER_SYSTEM_ENV_VARS) {
        delete process.env[name];
      }
      process.env.LINEAR_API_KEY = "lin-test";

      const result = getRunnerSystemEnvVars();
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        name: "LINEAR_API_KEY",
        value: "lin-test",
      });
    });

    it("preserves empty string values (set but empty)", () => {
      for (const name of RUNNER_SYSTEM_ENV_VARS) {
        delete process.env[name];
      }
      process.env.FROM_ADDRESS = "";

      const result = getRunnerSystemEnvVars();
      expect(result).toEqual([{ name: "FROM_ADDRESS", value: "" }]);
    });

    it("returns all vars when all are set", () => {
      for (const name of RUNNER_SYSTEM_ENV_VARS) {
        process.env[name] = `test-${name}`;
      }

      const result = getRunnerSystemEnvVars();
      expect(result).toHaveLength(RUNNER_SYSTEM_ENV_VARS.length);

      for (const entry of result) {
        expect(entry.value).toBe(`test-${entry.name}`);
      }
    });
  });
});
