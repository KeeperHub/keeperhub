import { describe, expect, it } from "vitest";
import {
  formatDateTime,
  formatDateTimeWithZone,
  formatShortTime,
} from "@/lib/web3/unix-time-display";
import {
  type GroupableRun,
  groupWaitingRuns,
  skippedWhileRunningCount,
  type WaitingGroup,
  waitingChipText,
  waitingDetails,
  waitingRowLine,
  waitingRowTitle,
} from "@/lib/workflow/waiting-run-groups";

const UTC = { timeZone: "UTC" };
// 1 Dec 2026, 12:00:00 UTC.
const UNLOCK = 1_796_126_400;
const NOW = new Date("2026-12-01T12:10:00Z");

function waiting(
  id: string,
  startedAt: string,
  notBefore: number | null = UNLOCK
): GroupableRun {
  return {
    id,
    startedAt,
    skipReason: "bundle-waiting",
    waiting: {
      notBefore,
      firstAllowedBlock: 21_400_421,
      latestBlock: 21_400_159,
      sendAheadBlocks: 2,
    },
  };
}

function plain(id: string, skipReason: GroupableRun["skipReason"] = null) {
  return { id, startedAt: "2026-12-01T11:00:00Z", skipReason, waiting: null };
}

function whileRunning(id: string, refusals: number | null): GroupableRun {
  return {
    id,
    startedAt: "2026-12-01T12:05:00Z",
    skipReason: "while-running",
    waiting: null,
    refusals,
  };
}

function onlyGroup(runs: GroupableRun[], total = runs.length) {
  const [entry] = groupWaitingRuns(runs, total);
  if (entry?.kind !== "waiting") {
    throw new Error("expected a waiting group");
  }
  return entry as WaitingGroup<GroupableRun>;
}

describe("groupWaitingRuns", () => {
  it("joins back-to-back waiting runs with the same Not before, newest first", () => {
    const runs = [
      waiting("w3", "2026-12-01T12:07:48Z"),
      waiting("w2", "2026-12-01T12:04:00Z"),
      waiting("w1", "2026-12-01T12:00:36Z"),
      plain("s1"),
    ];
    const entries = groupWaitingRuns(runs, 40);
    expect(entries.map((entry) => entry.kind)).toEqual(["waiting", "run"]);
    const group = entries[0] as WaitingGroup<GroupableRun>;
    expect(group.runs.map((run) => run.id)).toEqual(["w3", "w2", "w1"]);
    // Nothing newer above the row; numbers count every stored run.
    expect(group.stateKey).toBe(`not-before:${UNLOCK}:after:top`);
    expect(group.newestNumber).toBe(40);
    expect(group.oldestNumber).toBe(38);
    expect(entries[1]).toMatchObject({ kind: "run", number: 37 });
  });

  it("starts a new row at another run or another Not before", () => {
    const runs = [
      waiting("a", "2026-12-01T13:00:00Z", UNLOCK + 3600),
      waiting("b", "2026-12-01T12:05:00Z"),
      plain("skip", "bundle-in-flight"),
      waiting("c", "2026-12-01T12:01:00Z"),
      plain("ok"),
    ];
    const entries = groupWaitingRuns(runs, 5);
    expect(
      entries.map((entry) =>
        entry.kind === "waiting"
          ? entry.runs.map((run) => run.id).join("+")
          : entry.run.id
      )
    ).toEqual(["a", "b", "skip", "c", "ok"]);
    expect(entries.map((entry) => entry.kind)).toEqual([
      "waiting",
      "waiting",
      "run",
      "waiting",
      "run",
    ]);
  });

  it("never joins waiting runs whose Not before is not known", () => {
    const entries = groupWaitingRuns(
      [
        waiting("x", "2026-12-01T12:01:00Z", null),
        waiting("y", "2026-12-01T12:00:00Z", null),
      ],
      2
    );
    expect(entries).toHaveLength(2);
  });

  it("takes in skipped-while-running rows between two waiting runs with the same Not before", () => {
    const runs = [
      waiting("w3", "2026-12-01T12:07:48Z"),
      whileRunning("k2", 12),
      whileRunning("k1", null),
      waiting("w2", "2026-12-01T12:04:00Z"),
      waiting("w1", "2026-12-01T12:00:36Z"),
      whileRunning("k0", 4),
      plain("ok"),
    ];
    const entries = groupWaitingRuns(runs, 37);
    expect(
      entries.map((entry) =>
        entry.kind === "waiting"
          ? entry.runs.map((run) => run.id).join("+")
          : entry.run.id
      )
    ).toEqual(["w3+w2+w1", "k0", "ok"]);
    const group = entries[0] as WaitingGroup<GroupableRun>;
    expect(group.skippedWhileRunning.map((run) => run.id)).toEqual([
      "k2",
      "k1",
    ]);
    expect(skippedWhileRunningCount(group)).toBe(13);
    expect(group.newestNumber).toBe(37);
    expect(group.oldestNumber).toBe(33);
    expect(entries[1]).toMatchObject({ kind: "run", number: 32 });
    expect(waitingChipText(group)).toBe("3 waiting");
    expect(waitingRowTitle(group, { now: NOW, ...UTC })).toContain(
      "3 waiting, 13 skipped while running (2 runs), #33 to #37"
    );
    // One skip per stored run: no count in brackets.
    const single = groupWaitingRuns(
      [
        waiting("w2", "2026-12-01T12:07:48Z"),
        whileRunning("k1", 1),
        waiting("w1", "2026-12-01T12:04:00Z"),
      ],
      3
    )[0] as WaitingGroup<GroupableRun>;
    expect(waitingRowTitle(single, { now: NOW, ...UTC })).toContain(
      "2 waiting, 1 skipped while running, #1 to #3"
    );
  });

  it("keeps skipped-while-running rows apart at a group's end or before another Not before", () => {
    const entries = groupWaitingRuns(
      [
        whileRunning("top", 1),
        waiting("a", "2026-12-01T12:07:48Z"),
        whileRunning("mid", 2),
        waiting("b", "2026-12-01T12:04:00Z", UNLOCK + 3600),
      ],
      4
    );
    expect(
      entries.map((entry) =>
        entry.kind === "waiting" ? `w:${entry.runs[0].id}` : entry.run.id
      )
    ).toEqual(["top", "w:a", "mid", "w:b"]);
  });

  it("keys a row on its Not before and the newer run above it, stable across Load more and a run joining at the top", () => {
    const keysOf = (runs: GroupableRun[]) =>
      groupWaitingRuns(runs, runs.length).map((entry) =>
        entry.kind === "waiting" ? entry.stateKey : entry.run.id
      );
    // Two groups with the same Not before, split by one run.
    const page = [
      waiting("w4", "2026-12-01T12:07:48Z"),
      waiting("w3", "2026-12-01T12:07:36Z"),
      plain("ok"),
      waiting("w2", "2026-12-01T12:04:00Z"),
    ];
    const first = keysOf(page);
    expect(first).toEqual([
      `not-before:${UNLOCK}:after:top`,
      "ok",
      `not-before:${UNLOCK}:after:ok`,
    ]);
    // Load more: an older waiting run joins the lower group.
    expect(keysOf([...page, waiting("w1", "2026-12-01T12:00:36Z")])).toEqual(
      first
    );
    // A new waiting run joins the top group.
    expect(keysOf([waiting("w5", "2026-12-01T12:08:00Z"), ...page])).toEqual(
      first
    );
  });

  it("keeps a row's key while a newer run is still running, then ends waiting", () => {
    const keysOf = (runs: GroupableRun[]) =>
      groupWaitingRuns(runs, runs.length).map((entry) =>
        entry.kind === "waiting" ? entry.stateKey : entry.run.id
      );
    const below = [
      waiting("w2", "2026-12-01T12:07:36Z"),
      waiting("w1", "2026-12-01T12:07:24Z"),
    ];
    const key = `not-before:${UNLOCK}:after:top`;
    for (const status of ["running", "pending"]) {
      const running = { ...plain("r"), status };
      expect(keysOf([running, ...below])).toEqual(["r", key]);
    }
    // The running run ends waiting and joins the row: same key.
    const settled = {
      ...waiting("r", "2026-12-01T12:07:48Z"),
      status: "skipped",
    };
    expect(keysOf([settled, ...below])).toEqual([key]);
    // One that settles as something else still closes the row.
    expect(keysOf([{ ...plain("r"), status: "success" }, ...below])).toEqual([
      "r",
      `not-before:${UNLOCK}:after:r`,
    ]);
  });

  it("keeps a row's key while a same-workflow skip while running waits above it to be folded", () => {
    const keysOf = (runs: GroupableRun[]) =>
      groupWaitingRuns(runs, runs.length).map((entry) =>
        entry.kind === "waiting" ? entry.stateKey : entry.run.id
      );
    const key = `not-before:${UNLOCK}:after:top`;
    const w2 = waiting("w2", "2026-12-01T12:07:36Z");
    const w1 = waiting("w1", "2026-12-01T12:07:24Z");
    expect(keysOf([w2, w1])).toEqual([key]);
    expect(keysOf([whileRunning("k1", 1), w2, w1])).toEqual(["k1", key]);
    expect(
      keysOf([
        waiting("w3", "2026-12-01T12:08:00Z"),
        whileRunning("k1", 1),
        w2,
        w1,
      ])
    ).toEqual([key]);
    // Another workflow's skip while running is settled and anchors the row.
    const other = { ...whileRunning("k2", 1), workflowId: "wf-other" };
    expect(keysOf([other, w2, w1])).toEqual([
      "k2",
      `not-before:${UNLOCK}:after:k2`,
    ]);
  });

  it("anchors a row's key at once on another workflow's or a direct run's active run", () => {
    const keysOf = (runs: GroupableRun[]) =>
      groupWaitingRuns(runs, runs.length).map((entry) =>
        entry.kind === "waiting" ? entry.stateKey : entry.run.id
      );
    const below = [
      { ...waiting("w2", "2026-12-01T12:07:36Z"), workflowId: "wf-a" },
      { ...waiting("w1", "2026-12-01T12:07:24Z"), workflowId: "wf-a" },
    ];
    for (const workflowId of ["wf-b", null]) {
      const running = { ...plain("x"), workflowId, status: "running" };
      const settled = { ...running, status: "success" };
      const key = `not-before:${UNLOCK}:after:x`;
      expect(keysOf([running, ...below])).toEqual(["x", key]);
      expect(keysOf([settled, ...below])).toEqual(["x", key]);
    }
  });

  it("treats a same-workflow phantom run as one that may still join", () => {
    const keysOf = (runs: GroupableRun[]) =>
      groupWaitingRuns(runs, runs.length).map((entry) =>
        entry.kind === "waiting" ? entry.stateKey : entry.run.id
      );
    const below = [
      waiting("w2", "2026-12-01T12:07:36Z"),
      waiting("w1", "2026-12-01T12:07:24Z"),
    ];
    expect(keysOf([{ ...plain("p"), status: "phantom" }, ...below])).toEqual([
      "p",
      `not-before:${UNLOCK}:after:top`,
    ]);
  });

  it("never joins runs of different workflows, and words them without numbers on request", () => {
    const of = (run: GroupableRun, workflowId: string) => ({
      ...run,
      workflowId,
    });
    const entries = groupWaitingRuns(
      [
        of(waiting("a2", "2026-12-01T12:07:48Z"), "wf-a"),
        of(waiting("b1", "2026-12-01T12:05:00Z"), "wf-b"),
        of(waiting("a1", "2026-12-01T12:00:36Z"), "wf-a"),
        of(waiting("a0", "2026-12-01T11:59:00Z"), "wf-a"),
      ],
      4
    );
    expect(
      entries.map((entry) => entry.kind === "waiting" && entry.runs.length)
    ).toEqual([1, 1, 2]);
    const group = entries[2] as WaitingGroup<GroupableRun>;
    expect(group.stateKey).toBe(`not-before:${UNLOCK}:after:b1`);
    expect(waitingRowTitle(group, { now: NOW, ...UTC, numbered: false })).toBe(
      "Skipped, waiting for Not before: 1 Dec 2026, 12:00:00 UTC. 2 waiting, from 11:59:00 to 12:00:36."
    );
  });

  it("leaves a list without waiting runs as it is", () => {
    const entries = groupWaitingRuns([plain("a"), plain("b")], 2);
    expect(entries).toEqual([
      { kind: "run", run: plain("a"), number: 2 },
      { kind: "run", run: plain("b"), number: 1 },
    ]);
  });
});

describe("the waiting row's words", () => {
  const group = onlyGroup(
    [
      waiting("w2", "2026-12-01T12:07:48Z"),
      waiting("w1", "2026-12-01T12:00:36Z"),
    ],
    3159
  );
  const options = { now: NOW, ...UTC };

  it("puts the count first and the time in the viewer's zone, no label", () => {
    expect(waitingChipText(group)).toBe("2 waiting");
    expect(waitingRowLine(group, options)).toBe("not before 12:00");
  });

  it("adds the date only on another day", () => {
    expect(
      waitingRowLine(group, { now: new Date("2026-11-30T10:00:00Z"), ...UTC })
    ).toBe("not before Dec 1, 12:00");
  });

  it("writes a 4-digit count with a separator", () => {
    const many = {
      ...group,
      runs: Array.from({ length: 1284 }, () => group.runs[0]),
    };
    expect(waitingChipText(many)).toBe("1,284 waiting");
  });

  it("gives the full date with its zone and the run range in the tooltip", () => {
    expect(waitingRowTitle(group, options)).toBe(
      "Skipped, waiting for Not before: 1 Dec 2026, 12:00:00 UTC. 2 waiting, #3158 to #3159, from 12:00:36 to 12:07:48."
    );
  });

  it("explains the wait when expanded", () => {
    expect(waitingDetails(group, options)).toEqual([
      "Waiting for Not before: 1 Dec 2026, 12:00:00 UTC. The waiting Write Contract step sent nothing and did not touch the wallet.",
      "2 waiting, #3158 to #3159, from 12:00:36 to 12:07:48, shown as one row. Waiting runs end Skipped and do not count as failures.",
      "A waiting run counts toward your plan's runs like any other run. With a Block trigger at every block, that is about 7,200 runs a day; to run fewer, use a Block Interval of up to Send ahead + 1.",
      "First allowed block 21,400,421, 262 blocks away. The step sends 2 blocks before it (Send ahead).",
    ]);
  });

  it("speaks of one run on its own, and of Send ahead 0", () => {
    const single = onlyGroup([
      {
        ...waiting("w", "2026-12-01T12:00:36Z"),
        waiting: {
          notBefore: UNLOCK,
          firstAllowedBlock: 101,
          latestBlock: 100,
          sendAheadBlocks: 0,
        },
      },
    ]);
    expect(waitingDetails(single, options).slice(1)).toEqual([
      "One run, #1, at 12:00:36. Waiting runs end Skipped and do not count as failures.",
      "A waiting run counts toward your plan's runs like any other run. With a Block trigger at every block, that is about 7,200 runs a day; to run fewer, use a Block Interval of up to Send ahead + 1.",
      "First allowed block 101, 1 block away. The step sends once it is the next block (Send ahead 0).",
    ]);
  });

  it("says a mixed group's other steps sent transactions, from hashes or gas", () => {
    const sent = {
      ...waiting("w2", "2026-12-01T12:07:48Z"),
      transactionHashes: [{ hash: "0x1" }],
    };
    const paid = {
      ...waiting("w2", "2026-12-01T12:07:48Z"),
      gasUsedWei: "21000",
    };
    const zero = {
      ...waiting("w2", "2026-12-01T12:07:48Z"),
      gasUsedWei: "0",
      transactionHashes: [],
    };
    const older = waiting("w1", "2026-12-01T12:00:36Z");
    const mixedLine =
      "The runs' other steps still ran; some sent transactions. Only the latest run's steps are shown.";
    for (const run of [sent, paid]) {
      const lines = waitingDetails(
        onlyGroup([older, run].reverse(), 2),
        options
      );
      expect(lines[1]).toBe(mixedLine);
      expect(lines).toHaveLength(5);
    }
    // An older run's work counts too, and a lone run is worded on its own.
    expect(waitingDetails(onlyGroup([older, sent], 2), options)[1]).toBe(
      mixedLine
    );
    expect(waitingDetails(onlyGroup([sent], 1), options)[1]).toBe(
      "The run's other steps still ran and sent transactions."
    );
    expect(waitingDetails(onlyGroup([zero, older], 2), options)).not.toContain(
      mixedLine
    );
  });

  it("leaves the block line out when the outputs are missing", () => {
    const bare = onlyGroup([
      { ...waiting("w", "2026-12-01T12:00:36Z"), waiting: null },
    ]);
    expect(waitingRowLine(bare, options)).toBe("waiting for Not before");
    expect(waitingDetails(bare, options)).toHaveLength(3);
    expect(waitingDetails(bare, options)[0]).toBe(
      "Waiting for Not before. The waiting Write Contract step sent nothing and did not touch the wallet."
    );
  });
});

describe("unix time display", () => {
  it("formats in the given zone", () => {
    expect(formatDateTime(UNLOCK, UTC)).toBe("1 Dec 2026, 12:00:00");
    expect(formatDateTime(UNLOCK, { timeZone: "Europe/Berlin" })).toBe(
      "1 Dec 2026, 13:00:00"
    );
    expect(formatDateTimeWithZone(UNLOCK, UTC)).toBe(
      "1 Dec 2026, 12:00:00 UTC"
    );
    expect(
      formatShortTime(UNLOCK, { now: NOW, withSeconds: true, ...UTC })
    ).toBe("12:00:00");
  });
});
