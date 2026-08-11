import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: [
      "**/*.test.ts",
      "**/*.test.tsx",
      // The sandbox-escape suite intentionally uses `*.spec.ts` so it
      // never runs as part of the default `pnpm test` (which would point
      // at staging without the planted canary). The dedicated workflow
      // `sandbox-escape-matrix.yaml` invokes `vitest run <path>` against
      // these files explicitly with the staging env wired in - that
      // positional filter only resolves when the include glob below
      // matches.
      "tests/e2e/sandbox-escape/**/*.spec.ts",
    ],
    exclude: [
      "node_modules",
      ".next",
      "tests/e2e/playwright",
      ".pnpm-store",
      ".worktrees",
      "**/.worktrees/**",
      // .claude/worktrees/ holds ephemeral agent worktrees created by
      // gsd-executor and other isolated-worktree workflows. These
      // contain stale snapshots of test files that drift from main as
      // agents commit; including them means a single Phase commit
      // surfaces duplicate failures from every still-existing agent
      // worktree. CI doesn't see these dirs; locally they pollute the
      // signal so the matrix must match CI.
      ".claude/worktrees/**",
      // keeperhub-events is a separate pnpm workspace with its own
      // vitest config and dependencies. Without this exclude,
      // `pnpm test:integration tests/integration` from the main app
      // picks up keeperhub-events/event-tracker/tests/integration via
      // positional path filter and fails on missing deps.
      "keeperhub-events/**",
      // keeperhub-scheduler has its own package, vitest config, and
      // pnpm-lock. Tests there are run by pr-checks-scheduler.yml; the
      // main app's vitest must not pick them up (the chain-monitor test
      // imports from ../../block-dispatcher/* which only resolves when
      // run from within keeperhub-scheduler/).
      "keeperhub-scheduler/**",
      // .planning/ contains hackathon archives with frozen forks of the
      // codebase + their stale test snapshots. Including them in vitest
      // means any change to a baseline (like BASELINE_POLICIES) breaks
      // archived test files that no longer match the live source.
      ".planning/**",
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      include: ["lib/**/*.ts", "app/api/**/*.ts", "scripts/**/*.ts"],
      exclude: ["**/*.test.ts", "**/*.d.ts"],
    },
    setupFiles: ["./tests/setup.ts"],
    testTimeout: 10_000,
    fileParallelism: false,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./"),
    },
  },
});
