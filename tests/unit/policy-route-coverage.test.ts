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

/**
 * Resolvers that reach the policy gate, and so stand for it being asked.
 *
 * Named one by one rather than by their module, because the modules that hold
 * them export plenty that authenticates nothing.
 */
const GATE_REACHING_RESOLVERS = [
  "getDualAuthContext",
  "resolveOrganizationId",
  "resolveCreatorContext",
  "validateSafeAdmin",
  "validateSafeOwner",
  // resolveCaller resolves through getDualAuthContext, so it inherits it.
  "resolveCaller",
  // A route whose auth is its own asks the gate directly.
  "policyRefusalFor",
  "enforceControlPlane",
];

/**
 * Resolvers whose names are too ordinary to accept on sight.
 *
 * "authenticate" names a gate-reaching resolver in one module and something
 * that never sees the gate in plenty of others, so it counts only when the
 * route imported it from the module that reaches the gate.
 */
const GATE_REACHING_IMPORTS: Readonly<Record<string, readonly string[]>> = {
  "notifications/failure-alerts/route-auth": [
    "authenticate",
    "resolveOrgAccess",
  ],
};

/** Every local binding in this file that stands for the gate being asked. */
function gateReachingNames(source: string): string[] {
  const names = [...GATE_REACHING_RESOLVERS];
  for (const statement of source.matchAll(
    /import\s*\{([^}]*)\}\s*from\s*"([^"]+)"/g
  )) {
    const [, specifiers, module] = statement;
    const exported = Object.entries(GATE_REACHING_IMPORTS).find(([path]) =>
      module.includes(path)
    )?.[1];
    if (!exported) {
      continue;
    }
    for (const specifier of specifiers.split(",")) {
      const [imported, alias] = specifier.trim().split(/\s+as\s+/);
      if (exported.includes(imported.trim())) {
        names.push((alias ?? imported).trim());
      }
    }
  }
  return names;
}

/** Whether `text` calls `name`, rather than merely containing its letters. */
function mentions(text: string, name: string): boolean {
  return new RegExp(`\\b${name}\\b`).test(text);
}

/** The index of the character closing the pair that opens at or after `from`. */
function closingOf(
  source: string,
  from: number,
  open: string,
  close: string
): number {
  const start = source.indexOf(open, from);
  if (start === -1) {
    return -1;
  }
  let depth = 0;
  for (let index = start; index < source.length; index++) {
    const character = source[index];
    if (character === open) {
      depth++;
    } else if (character === close) {
      depth--;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
}

function blockAfter(source: string, from: number): string | null {
  const end = closingOf(source, from, "{", "}");
  return end === -1 ? null : source.slice(source.indexOf("{", from), end + 1);
}

/**
 * The body of `name`, skipping its parameter list.
 *
 * Skipping it matters: a handler destructures `{ params }`, and reading from the
 * first brace would take the parameter type for the body and find nothing in it.
 */
function declaredBody(source: string, name: string): string | null {
  const declared = new RegExp(`function\\s+${name}\\s*\\(`).exec(source);
  if (declared) {
    const params = closingOf(source, declared.index, "(", ")");
    return params === -1 ? null : blockAfter(source, params);
  }
  const assigned = new RegExp(`const\\s+${name}\\s*[:=]`).exec(source);
  return assigned ? blockAfter(source, assigned.index) : null;
}

function localNames(source: string): string[] {
  return [...source.matchAll(/(?:function\s+(\w+)|const\s+(\w+)\s*[:=])/g)]
    .map((match) => match[1] ?? match[2])
    .filter((name): name is string => Boolean(name));
}

/** Whether the handler asks the gate, itself or through a helper in its file. */
function handlerReachesGate(
  source: string,
  method: string,
  reaching: readonly string[]
): boolean {
  const body = declaredBody(source, method);
  if (body === null) {
    return false;
  }
  if (reaching.some((name) => mentions(body, name))) {
    return true;
  }
  return localNames(source).some((local) => {
    if (!mentions(body, local)) {
      return false;
    }
    const helper = declaredBody(source, local);
    return helper !== null && reaching.some((name) => mentions(helper, name));
  });
}

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

  it("runs the check on every route it claims to govern", async () => {
    // The manifest saying a route is governed is a claim about the running
    // system, not a label. A route whose auth does not pass through a resolver
    // that calls the gate is one policy never sees, and the manifest asserting
    // otherwise is worse than it saying nothing: it reads as covered.
    //
    // The claim is checked against the handler that mutates, not against the
    // file. A file-wide search passes a route whose GET resolves through the
    // gate while its POST authenticates on its own, which is how a real gap on
    // POST /api/user/wallet stayed invisible.
    const ungated: string[] = [];
    for (const [pattern, methods] of Object.entries(CONTROL_PLANE_ROUTES)) {
      const file = join(API_ROOT, `${pattern.replace("/api", "")}/route.ts`);
      if (!existsSync(file)) {
        continue;
      }
      const source = readFileSync(file, "utf8");
      const reaching = gateReachingNames(source);
      for (const [method, governance] of Object.entries(methods)) {
        if (governance?.kind !== "governed") {
          continue;
        }
        if (!handlerReachesGate(source, method, reaching)) {
          ungated.push(`${method} ${pattern}`);
        }
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
