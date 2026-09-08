/**
 * Protocol node coverage yardstick.
 *
 * Joins the protocol registry with each protocol's co-located testData
 * (skipped/expectations maps) and the on-disk coverage suites to report,
 * per protocol x chain: total actions, runnable, skipped, value-asserted,
 * and suite status. Optionally joins a vitest JSON results file to show
 * what actually executed.
 *
 * Usage:
 *   pnpm coverage:report                          # human table
 *   pnpm coverage:report --json                   # machine output
 *   pnpm coverage:report --results <vitest.json>  # join executed results
 *     (produce with: vitest run tests/e2e/vitest/protocol-coverage \
 *        --reporter=json --outputFile=<vitest.json>)
 *
 * The runnable/skipped numbers come from the same planPhaseFixtures the
 * suite runner uses, so this report cannot drift from what the runner
 * registers. The simulation tier (tests/e2e/vitest/protocol-simulation)
 * does not yet feed this report; it will contribute a `simulated`
 * column via its own results file.
 */

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import "../protocols";
import { getRegisteredProtocols } from "../lib/protocol-registry";
import { type FixtureCase, planPhaseFixtures } from "../lib/test-data/plan";
import {
  countAssertions,
  type VitestAssertionCounts,
  type VitestJsonResults,
} from "./vitest-assertion-counts";

const COVERAGE_DIR = "tests/e2e/vitest/protocol-coverage";

type SuiteInfo = {
  path: string;
  protocol: string;
  chainId: string;
  hardSkipped: boolean;
  /** Scraped `const PROTOCOL` value when it disagrees with the suite's
   *  directory name; surfaced as a loud mismatch instead of dropping or
   *  silently trusting either side. */
  scrapedProtocol?: string;
};

type SuiteResult = VitestAssertionCounts & {
  durationMs: number;
};

type ChainRow = {
  protocol: string;
  chainId: string;
  actions: number;
  runnable: number;
  skipped: number;
  asserted: number;
  suite: "yes" | "hard-skip" | "none";
  skipReasons: Record<string, string>;
  result?: SuiteResult;
};

function discoverSuites(): SuiteInfo[] {
  const suites: SuiteInfo[] = [];
  for (const proto of readdirSync(COVERAGE_DIR, { withFileTypes: true })) {
    if (!proto.isDirectory() || proto.name.startsWith("_")) {
      continue;
    }
    const protoDir = join(COVERAGE_DIR, proto.name);
    for (const chain of readdirSync(protoDir, { withFileTypes: true })) {
      if (!chain.isDirectory()) {
        continue;
      }
      const file = join(protoDir, chain.name, "coverage.test.ts");
      if (!existsSync(file)) {
        continue;
      }
      const src = readFileSync(file, "utf8");
      // The directory name is the protocol: the layout is
      // protocol-coverage/<protocol>/<chain-name>/coverage.test.ts. The
      // source is still scraped for CHAIN_ID (chain directories are
      // names, not ids) and for the PROTOCOL const so a suite whose
      // const drifted from its directory is reported, not dropped.
      const scraped = src.match(/const PROTOCOL = "([^"]+)"/)?.[1];
      const chainId = src.match(/const CHAIN_ID = "([^"]+)"/)?.[1];
      suites.push({
        path: file,
        protocol: proto.name,
        // A suite with no scrapeable CHAIN_ID joins no registry chain
        // row, so it surfaces in orphanSuites instead of silently
        // vanishing from the report.
        chainId: chainId ?? "unparsed",
        // describe.skip( is an unconditional disable; describe.skipIf( is
        // the normal infra gate and does not count as hard-skipped.
        hardSkipped: /describe\.skip\(/.test(src),
        ...(scraped && scraped !== proto.name
          ? { scrapedProtocol: scraped }
          : {}),
      });
    }
  }
  return suites;
}

function parseResults(file: string): Map<string, SuiteResult> {
  const raw = JSON.parse(readFileSync(file, "utf8")) as VitestJsonResults;
  const bySuite = new Map<string, SuiteResult>();
  for (const tr of raw.testResults ?? []) {
    const name = tr.name ?? "";
    const rel = name.includes(COVERAGE_DIR)
      ? name.slice(name.indexOf(COVERAGE_DIR))
      : name;
    bySuite.set(rel, {
      ...countAssertions(tr.assertionResults),
      durationMs:
        tr.endTime && tr.startTime ? Math.round(tr.endTime - tr.startTime) : 0,
    });
  }
  return bySuite;
}

type ProtocolMismatch = {
  path: string;
  protocol: string;
  scrapedProtocol: string;
};

function buildRows(results?: Map<string, SuiteResult>): {
  rows: ChainRow[];
  noHarness: Array<{ protocol: string; actions: number }>;
  orphanSuites: Array<{ path: string; protocol: string; chainId: string }>;
  protocolMismatches: ProtocolMismatch[];
} {
  const suites = discoverSuites();
  const protocolMismatches: ProtocolMismatch[] = [];
  for (const s of suites) {
    if (s.scrapedProtocol) {
      protocolMismatches.push({
        path: s.path,
        protocol: s.protocol,
        scrapedProtocol: s.scrapedProtocol,
      });
    }
  }
  const rows: ChainRow[] = [];
  const noHarness: Array<{ protocol: string; actions: number }> = [];
  // Suites consumed by a (registered protocol, testData chain) row. Any
  // suite left over is orphaned - its protocol lost its testData (or was
  // never registered), so it would otherwise vanish from the report:
  // zero rows AND no noHarness entry, silently understating the gap.
  const consumed = new Set<string>();

  for (const def of getRegisteredProtocols()) {
    const chainIds = Object.keys(def.testData ?? {});
    const protoSuites = suites.filter((s) => s.protocol === def.slug);
    // An unparseable suite (no scrapeable CHAIN_ID) joins no chain row,
    // so it cannot stand in for a harness: only parseable suites keep a
    // no-testData protocol out of the no-harness list. The unparseable
    // suite itself still surfaces in orphanSuites.
    const parseable = protoSuites.filter((s) => s.chainId !== "unparsed");
    if (chainIds.length === 0 && parseable.length === 0) {
      noHarness.push({ protocol: def.slug, actions: def.actions.length });
      continue;
    }
    for (const chainId of chainIds) {
      // Tier-2 view: skippedCoverage actions run in the fork tier but are
      // skipped by the app coverage suite, so the report counts them as
      // skipped to match what this suite executes.
      const coverageSkips = def.testData?.[chainId]?.skippedCoverage ?? {};
      const rawPlan = [
        ...planPhaseFixtures(def, def.slug, chainId, "read"),
        ...planPhaseFixtures(def, def.slug, chainId, "write"),
      ];
      const plan: FixtureCase[] = rawPlan.map((c) =>
        c.kind === "run" && coverageSkips[c.action.slug] !== undefined
          ? {
              kind: "skip",
              action: c.action,
              reason: coverageSkips[c.action.slug],
            }
          : c
      );
      const runnable = plan.filter((c) => c.kind === "run").length;
      const skippedCases = plan.filter((c) => c.kind === "skip");
      const expectations = def.testData?.[chainId]?.expectations ?? {};
      // Join by directory name first, then fall back to the scraped
      // const PROTOCOL: a suite whose directory was renamed while the
      // const kept the registered slug still runs under vitest as this
      // protocol, so it must keep its row (and its executed counts)
      // instead of splitting into none + orphan. The mismatch itself is
      // still reported loudly via protocolMismatches.
      const suite =
        protoSuites.find((s) => s.chainId === chainId) ??
        suites.find(
          (s) => s.scrapedProtocol === def.slug && s.chainId === chainId
        );
      if (suite) {
        consumed.add(suite.path);
      }
      const skipReasons: Record<string, string> = {};
      for (const c of skippedCases) {
        if (c.kind === "skip") {
          skipReasons[c.action.slug] = c.reason;
        }
      }
      const row: ChainRow = {
        protocol: def.slug,
        chainId,
        actions: def.actions.length,
        runnable,
        skipped: skippedCases.length,
        asserted: Object.keys(expectations).length,
        suite: suite ? (suite.hardSkipped ? "hard-skip" : "yes") : "none",
        skipReasons,
      };
      if (suite && results) {
        row.result = results.get(suite.path);
      }
      rows.push(row);
    }
  }
  const orphanSuites = suites
    .filter((s) => !consumed.has(s.path))
    .map((s) => ({ path: s.path, protocol: s.protocol, chainId: s.chainId }));
  return { rows, noHarness, orphanSuites, protocolMismatches };
}

/**
 * Event-trigger coverage, counted from the registry + each protocol's
 * testData[chain].events opt-in (the same source the Tier 1 event harness
 * reads, so this cannot drift from what executes). A protocol opts into event
 * simulation on one chain by declaring an `events` block; events listed under
 * its `skipped` map are documented, reasoned skips. A protocol with events but
 * no opt-in on any chain has none of its events simulated.
 */
type EventProtocolCoverage = {
  protocol: string;
  total: number;
  covered: number;
  skipped: number;
  optInChain: string | undefined;
  noOptIn: boolean;
  skipReasons: Record<string, string>;
};

type EventCoverage = {
  totalEvents: number;
  coveredEvents: number;
  skippedEvents: number;
  perProtocol: EventProtocolCoverage[];
};

const NO_OPT_IN_REASON =
  "no Tier 1 event simulation opt-in (protocol has no testData.events on a simulated chain)";

function computeEventCoverage(): EventCoverage {
  const perProtocol: EventProtocolCoverage[] = [];
  let totalEvents = 0;
  let coveredEvents = 0;
  let skippedEvents = 0;

  for (const def of getRegisteredProtocols()) {
    const events = def.events ?? [];
    if (events.length === 0) {
      continue;
    }
    const optIn = Object.entries(def.testData ?? {}).find(([, td]) => td.events);
    const skipMap = optIn?.[1].events?.skipped ?? {};
    const skipReasons: Record<string, string> = {};
    let skipped = 0;
    for (const event of events) {
      const reason = optIn ? skipMap[event.slug] : NO_OPT_IN_REASON;
      if (reason) {
        skipReasons[event.slug] = reason;
        skipped += 1;
      }
    }
    const covered = events.length - skipped;
    totalEvents += events.length;
    coveredEvents += covered;
    skippedEvents += skipped;
    perProtocol.push({
      protocol: def.slug,
      total: events.length,
      covered,
      skipped,
      optInChain: optIn?.[0],
      noOptIn: !optIn,
      skipReasons,
    });
  }

  return { totalEvents, coveredEvents, skippedEvents, perProtocol };
}

function pad(value: string | number, width: number): string {
  return String(value).padEnd(width);
}

function main(): void {
  const args = process.argv.slice(2);
  const asJson = args.includes("--json");
  const resultsIdx = args.indexOf("--results");
  const results =
    resultsIdx >= 0 && args[resultsIdx + 1]
      ? parseResults(args[resultsIdx + 1])
      : undefined;

  const { rows, noHarness, orphanSuites, protocolMismatches } =
    buildRows(results);
  const eventCoverage = computeEventCoverage();
  const registryTotal = getRegisteredProtocols().reduce(
    (n, d) => n + d.actions.length,
    0
  );
  const totals = {
    registryProtocols: getRegisteredProtocols().length,
    registryActions: registryTotal,
    harnessedChains: rows.length,
    runnable: rows.reduce((n, r) => n + r.runnable, 0),
    skipped: rows.reduce((n, r) => n + r.skipped, 0),
    asserted: rows.reduce((n, r) => n + r.asserted, 0),
    suitesHardSkipped: rows.filter((r) => r.suite === "hard-skip").length,
    suitesMissing: rows.filter((r) => r.suite === "none").length,
    protocolsWithoutHarness: noHarness,
    orphanSuites,
    protocolMismatches,
    executed: results
      ? rows.reduce((n, r) => n + (r.result?.executed ?? 0), 0)
      : undefined,
    passed: results
      ? rows.reduce((n, r) => n + (r.result?.passed ?? 0), 0)
      : undefined,
    failed: results
      ? rows.reduce((n, r) => n + (r.result?.failed ?? 0), 0)
      : undefined,
  };

  if (asJson) {
    process.stdout.write(
      `${JSON.stringify({ rows, totals, events: eventCoverage }, null, 2)}\n`
    );
    return;
  }

  const header = `${pad("protocol", 15)}${pad("chain", 10)}${pad("actions", 9)}${pad("runnable", 10)}${pad("skipped", 9)}${pad("asserted", 10)}${pad("suite", 11)}${results ? pad("exec/pass/fail", 16) : ""}${results ? "duration" : ""}`;
  const lines: string[] = [header, "-".repeat(header.length)];
  for (const r of rows.sort(
    (a, b) =>
      a.protocol.localeCompare(b.protocol) || a.chainId.localeCompare(b.chainId)
  )) {
    const resultCol = r.result
      ? `${pad(`${r.result.executed}/${r.result.passed}/${r.result.failed}`, 16)}${Math.round(r.result.durationMs / 1000)}s`
      : results
        ? pad("-", 16)
        : "";
    lines.push(
      `${pad(r.protocol, 15)}${pad(r.chainId, 10)}${pad(r.actions, 9)}${pad(r.runnable, 10)}${pad(r.skipped, 9)}${pad(r.asserted, 10)}${pad(r.suite, 11)}${resultCol}`
    );
  }
  lines.push("");
  lines.push(
    `registry: ${totals.registryProtocols} protocols, ${totals.registryActions} actions | harnessed protocol-chains: ${totals.harnessedChains} | runnable: ${totals.runnable} | skipped: ${totals.skipped} | value-asserted actions: ${totals.asserted}`
  );
  lines.push(
    `suites hard-skipped: ${totals.suitesHardSkipped} | testData chains without a suite: ${totals.suitesMissing} | protocols with no harness at all: ${noHarness.map((p) => `${p.protocol}(${p.actions})`).join(", ") || "none"}`
  );
  if (orphanSuites.length > 0) {
    lines.push(
      `ORPHANED suites (on disk but no registry testData chain matches them): ${orphanSuites.map((s) => `${s.protocol}/${s.chainId}`).join(", ")}`
    );
  }
  if (protocolMismatches.length > 0) {
    lines.push(
      `PROTOCOL MISMATCH (const PROTOCOL disagrees with the suite's directory): ${protocolMismatches.map((m) => `${m.path} (dir "${m.protocol}" vs const "${m.scrapedProtocol}")`).join(", ")}`
    );
  }
  if (results) {
    lines.push(
      `executed: ${totals.executed} | passed: ${totals.passed} | failed: ${totals.failed}`
    );
  }
  lines.push("");
  lines.push(
    `events: ${eventCoverage.coveredEvents} covered / ${eventCoverage.totalEvents} total | skipped: ${eventCoverage.skippedEvents}`
  );
  for (const p of eventCoverage.perProtocol) {
    const optIn = p.noOptIn ? "no opt-in" : `chain ${p.optInChain}`;
    lines.push(
      `  ${pad(p.protocol, 13)} ${p.covered}/${p.total} covered, ${p.skipped} skipped (${optIn})`
    );
  }
  process.stdout.write(`${lines.join("\n")}\n`);
}

main();
