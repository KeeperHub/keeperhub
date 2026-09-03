import { describe, expect, it } from "vitest";
import { buildHealthStatus } from "../../block-dispatcher/health.js";

const alive = { alive: true };
const dead = { alive: false };

describe("buildHealthStatus", () => {
  it("is ok before any monitor is registered", () => {
    expect(buildHealthStatus([])).toEqual({ healthy: true, status: "ok" });
  });

  it("is ok when every monitor is alive", () => {
    expect(buildHealthStatus([alive, alive, alive])).toEqual({
      healthy: true,
      status: "ok",
    });
  });

  it("stays serving when a single chain of many is dead", () => {
    // The regression this guards: `every` here returned 503, and because
    // /health backs the liveness probe that killed a process still monitoring
    // seventeen other chains.
    const monitors = [dead, ...Array.from({ length: 17 }, () => alive)];
    expect(buildHealthStatus(monitors)).toEqual({
      healthy: true,
      status: "degraded",
    });
  });

  it("still reports degraded when only one chain survives", () => {
    const monitors = [alive, ...Array.from({ length: 17 }, () => dead)];
    expect(buildHealthStatus(monitors)).toEqual({
      healthy: true,
      status: "degraded",
    });
  });

  it("fails only on a total outage", () => {
    expect(buildHealthStatus([dead, dead])).toEqual({
      healthy: false,
      status: "down",
    });
  });
});
