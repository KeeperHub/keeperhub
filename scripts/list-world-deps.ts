#!/usr/bin/env tsx

/**
 * list-world-deps.ts
 *
 * Walks the full transitive dependency tree of @workflow/world-postgres
 * and prints the package lists needed for:
 *   - .npmrc          (public-hoist-pattern entries)
 *   - next.config.ts  (serverExternalPackages + outputFileTracingIncludes)
 *
 * Usage: tsx scripts/list-world-deps.ts
 */

import { existsSync, readFileSync } from "node:fs";
import { builtinModules, createRequire } from "node:module";
import { dirname, join } from "node:path";

const ROOT_PKG = "@workflow/world-postgres";
const builtins = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));
const seen = new Set<string>();

/**
 * Find a package's directory by resolving from a given base directory.
 * Works with pnpm's strict node_modules layout -- each package can only
 * resolve its own declared dependencies.
 */
function findPkgDir(name: string, fromDir: string): string | undefined {
  const req = createRequire(join(fromDir, "_resolve.js"));
  // Try direct package.json resolution first
  try {
    return dirname(req.resolve(join(name, "package.json")));
  } catch {
    // package.json may not be in the exports map -- resolve the main
    // entry and walk up to find the package root
  }
  try {
    const main = req.resolve(name);
    let dir = dirname(main);
    while (dir !== dirname(dir)) {
      const pj = join(dir, "package.json");
      if (existsSync(pj)) {
        const data = JSON.parse(readFileSync(pj, "utf8")) as {
          name?: string;
        };
        if (data.name === name) {
          return dir;
        }
      }
      dir = dirname(dir);
    }
  } catch {
    // not resolvable from this location
  }
  return;
}

type PackageJson = {
  name?: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

/**
 * Recursively walk dependencies starting from `pkg`, resolving each
 * dependency from within its parent's directory so pnpm's isolation
 * is respected.
 */
function walk(pkg: string, fromDir: string): void {
  if (seen.has(pkg) || builtins.has(pkg)) {
    return;
  }
  seen.add(pkg);

  const pkgDir = findPkgDir(pkg, fromDir);
  if (!pkgDir) {
    console.error(`  warning: could not resolve ${pkg} from ${fromDir}`);
    return;
  }

  const pjPath = join(pkgDir, "package.json");
  const pj = JSON.parse(readFileSync(pjPath, "utf8")) as PackageJson;

  // Walk hard dependencies and optional dependencies
  const deps = Object.keys({
    ...pj.dependencies,
    ...pj.optionalDependencies,
  });

  for (const dep of deps) {
    walk(dep, pkgDir);
  }
}

// --- main ---

const projectRoot = process.cwd();
walk(ROOT_PKG, projectRoot);

const packages = [...seen].sort();

// Read package.json to find direct deps (these don't need .npmrc hoisting)
const appPj = JSON.parse(
  readFileSync(join(projectRoot, "package.json"), "utf8")
) as PackageJson;
const directDeps = new Set(
  Object.keys({
    ...appPj.dependencies,
    ...appPj.devDependencies,
  })
);

const transitiveDeps = packages.filter((p) => !directDeps.has(p));

console.log(`Found ${packages.length} packages in ${ROOT_PKG} dependency tree`);
const transitiveCount =
  directDeps.size > 0 ? transitiveDeps.length : packages.length;
console.log(`  ${transitiveCount} transitive (need .npmrc hoisting)`);
console.log(
  `  ${packages.length - transitiveDeps.length} direct (already hoisted)\n`
);

// .npmrc output
console.log("# -- .npmrc public-hoist-pattern entries --");
console.log(
  "# Only transitive deps need hoisting (direct deps are already at top level)"
);
for (const pkg of transitiveDeps) {
  console.log(`public-hoist-pattern[]=${pkg}`);
}

// serverExternalPackages output
console.log("\n# -- next.config.ts serverExternalPackages --");
console.log("serverExternalPackages: [");
for (const pkg of packages) {
  console.log(`  "${pkg}",`);
}
console.log("]");

// outputFileTracingIncludes output
console.log("\n# -- next.config.ts outputFileTracingIncludes --");
console.log('outputFileTracingIncludes: {\n  "/*": [');
for (const pkg of packages) {
  console.log(`    "./node_modules/${pkg}/**/*",`);
}
console.log("  ],\n}");
