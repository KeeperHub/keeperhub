import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { getDevkitRetentionConfig } from "@/lib/retention/devkit-config";

const VARS = [
  "DEVKIT_RETENTION_ENABLED",
  "DEVKIT_RETENTION_DRY_RUN",
  "DEVKIT_RETENTION_DAYS",
  "DEVKIT_RETENTION_BATCH_SIZE",
  "DEVKIT_RETENTION_MAX_RUNTIME_SECONDS",
];

function clearVars(): void {
  for (const name of VARS) {
    vi.stubEnv(name, "");
  }
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("getDevkitRetentionConfig", () => {
  it("is off, deletes for real and keeps 30 days when nothing is set", () => {
    clearVars();

    expect(getDevkitRetentionConfig()).toEqual({
      enabled: false,
      dryRun: false,
      retentionDays: 30,
      batchSize: 500,
      maxRuntimeMs: 240_000,
    });
  });

  it("reads every variable", () => {
    vi.stubEnv("DEVKIT_RETENTION_ENABLED", "true");
    vi.stubEnv("DEVKIT_RETENTION_DRY_RUN", "1");
    vi.stubEnv("DEVKIT_RETENTION_DAYS", "90");
    vi.stubEnv("DEVKIT_RETENTION_BATCH_SIZE", "250");
    vi.stubEnv("DEVKIT_RETENTION_MAX_RUNTIME_SECONDS", "60");

    expect(getDevkitRetentionConfig()).toEqual({
      enabled: true,
      dryRun: true,
      retentionDays: 90,
      batchSize: 250,
      maxRuntimeMs: 60_000,
    });
  });

  it("raises a window below 7 days to 7", () => {
    clearVars();
    vi.stubEnv("DEVKIT_RETENTION_DAYS", "3");

    expect(getDevkitRetentionConfig().retentionDays).toBe(7);
  });

  it.each(["0", "-5", "thirty"])(
    "falls back to the defaults for %j instead of to 0",
    (raw) => {
      clearVars();
      vi.stubEnv("DEVKIT_RETENTION_DAYS", raw);
      vi.stubEnv("DEVKIT_RETENTION_BATCH_SIZE", raw);
      vi.stubEnv("DEVKIT_RETENTION_MAX_RUNTIME_SECONDS", raw);

      expect(getDevkitRetentionConfig()).toMatchObject({
        retentionDays: 30,
        batchSize: 500,
        maxRuntimeMs: 240_000,
      });
    }
  );

  it("treats anything but true or 1 as off", () => {
    clearVars();
    vi.stubEnv("DEVKIT_RETENTION_ENABLED", "yes");

    expect(getDevkitRetentionConfig().enabled).toBe(false);
  });
});
