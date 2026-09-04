import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CONTROL_PLANE_ROUTES,
  type HttpMutation,
  matchControlPlaneRoute,
} from "@/lib/policy/control-plane-routes";

const API_ROOT = join(process.cwd(), "app", "api");
const MUTATIONS: readonly HttpMutation[] = ["POST", "PATCH", "PUT", "DELETE"];

function routeFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      found.push(...routeFiles(path));
    } else if (entry === "route.ts") {
      found.push(path);
    }
  }
  return found;
}

/** The route pattern a file serves, in the same form the manifest is keyed by. */
function patternOf(file: string): string {
  return `/api${file.slice(API_ROOT.length).replace(/\/route\.ts$/, "")}`;
}

function mutationsExportedBy(file: string): HttpMutation[] {
  const source = readFileSync(file, "utf8");
  return MUTATIONS.filter((method) =>
    new RegExp(`export\\s+(async\\s+)?function\\s+${method}\\b`).test(source)
  );
}

const discovered = routeFiles(API_ROOT)
  .map((file) => ({
    pattern: patternOf(file),
    methods: mutationsExportedBy(file),
  }))
  .filter((route) => route.methods.length > 0);

describe("control-plane route coverage", () => {
  it("finds the mutating routes to classify", () => {
    expect(discovered.length).toBeGreaterThan(100);
  });

  it("classifies every mutating route and method", () => {
    const missing: string[] = [];
    for (const route of discovered) {
      const entry = CONTROL_PLANE_ROUTES[route.pattern];
      for (const method of route.methods) {
        if (entry?.[method] === undefined) {
          missing.push(`${method} ${route.pattern}`);
        }
      }
    }

    // A new mutating route lands here until someone says what policy makes of
    // it. That is the whole point: the answer may well be "ungoverned", but it
    // has to be written down rather than assumed.
    expect(
      missing,
      `Add these to CONTROL_PLANE_ROUTES in lib/policy/control-plane-routes.ts:\n  ${missing.join("\n  ")}`
    ).toEqual([]);
  });

  it("lists no route the manifest covers but the app does not serve", () => {
    const served = new Set(discovered.map((route) => route.pattern));
    const stale = Object.keys(CONTROL_PLANE_ROUTES).filter(
      (pattern) => !served.has(pattern)
    );
    expect(stale, `Stale manifest entries:\n  ${stale.join("\n  ")}`).toEqual(
      []
    );
  });

  it("runs the check on every route it claims to govern", () => {
    // The manifest saying a route is governed is a claim about the running
    // system, not a label. A route whose auth does not pass through a resolver
    // that calls the gate is one policy never sees, and the manifest asserting
    // otherwise is worse than it saying nothing: it reads as covered.
    const gatedResolvers = [
      "getDualAuthContext",
      "resolveOrganizationId",
      "resolveCreatorContext",
      "validateSafeAdmin",
      // resolveCaller resolves through getDualAuthContext, so it inherits it.
      "resolveCaller",
      "validateSafeOwner",
      // A route whose auth is its own calls the check itself.
      "enforceControlPlane",
    ];

    const ungated: string[] = [];
    for (const [pattern, methods] of Object.entries(CONTROL_PLANE_ROUTES)) {
      const governed = Object.entries(methods).filter(
        ([, governance]) => governance?.kind === "governed"
      );
      if (governed.length === 0) {
        continue;
      }
      const file = join(API_ROOT, `${pattern.replace("/api", "")}/route.ts`);
      if (!existsSync(file)) {
        continue;
      }
      const source = readFileSync(file, "utf8");
      if (!gatedResolvers.some((resolver) => source.includes(resolver))) {
        ungated.push(pattern);
      }
    }

    expect(
      ungated,
      `These routes are declared governed but nothing checks them:\n  ${ungated.join("\n  ")}`
    ).toEqual([]);
  });

  it("resolves a concrete path to its capability", () => {
    const match = matchControlPlaneRoute("POST", "/api/workflows/create");
    expect(match?.governance).toMatchObject({
      kind: "governed",
      capability: "workflow.create",
      creates: "workflow",
    });
  });

  it("reads the resource id out of a dynamic segment", () => {
    const match = matchControlPlaneRoute("DELETE", "/api/workflows/wf_123");
    expect(match?.params.workflowId).toBe("wf_123");
    expect(match?.governance).toMatchObject({ capability: "workflow.delete" });
  });

  it("prefers an exact pattern over a catch-all", () => {
    const match = matchControlPlaneRoute("POST", "/api/execute/transfer");
    expect(match?.pattern).toBe("/api/execute/transfer");
  });

  it("returns nothing for a path no pattern covers", () => {
    expect(matchControlPlaneRoute("POST", "/api/not/a/real/route")).toBeNull();
  });

  it("ignores methods that mutate nothing", () => {
    expect(matchControlPlaneRoute("GET", "/api/workflows/create")).toBeNull();
  });
});
