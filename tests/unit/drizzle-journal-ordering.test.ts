import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

type JournalEntry = {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
};

type Journal = {
  version: string;
  dialect: string;
  entries: JournalEntry[];
};

describe("drizzle journal ordering", () => {
  const raw = readFileSync(
    join(process.cwd(), "drizzle/meta/_journal.json"),
    "utf8"
  );
  const journal = JSON.parse(raw) as Journal;

  it("journal is non-empty", () => {
    expect(journal.entries.length).toBeGreaterThan(0);
  });

  it("every when is strictly greater than the previous", () => {
    for (let i = 1; i < journal.entries.length; i++) {
      const prev = journal.entries[i - 1];
      const curr = journal.entries[i];
      if (curr.when <= prev.when) {
        throw new Error(
          `Journal ordering violation: entry ${i} (tag="${curr.tag}", when=${curr.when}) is not > entry ${i - 1} (tag="${prev.tag}", when=${prev.when}). Manually bump curr.when to ${prev.when + 1}.`
        );
      }
    }
  });

  it("every idx equals its array position", () => {
    for (let i = 0; i < journal.entries.length; i++) {
      expect(journal.entries[i].idx).toBe(i);
    }
  });

  it("every tag begins with its zero-padded idx", () => {
    for (const entry of journal.entries) {
      const prefix = String(entry.idx).padStart(4, "0");
      expect(entry.tag.startsWith(prefix)).toBe(true);
    }
  });

  it("version and dialect are set", () => {
    expect(journal.version).toBe("7");
    expect(journal.dialect).toBe("postgresql");
  });
});
