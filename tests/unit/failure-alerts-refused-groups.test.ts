import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { isQuietMember, listedWith } = await import(
  "@/lib/notifications/failure-alerts/refused-groups"
);

const hour = 60 * 60 * 1000;
const base = new Date("2026-11-04T12:00:00Z").getTime();
const member = (id: string, hoursIn: number) => ({
  id,
  workflowId: `wf_${id}`,
  openedAt: new Date(base + hoursIn * hour),
  lastFailedAt: new Date(base + hoursIn * hour),
});

describe("refused groups", () => {
  const a = member("a", 0);
  const b = member("b", 1);
  const c = member("c", 2);
  const late = member("d", 30);

  it("the first refused incident speaks; later ones within a day are quiet", () => {
    const group = [a, b, c];
    expect(isQuietMember(a, group)).toBe(false);
    expect(isQuietMember(b, group)).toBe(true);
    expect(listedWith(a, group).map((m) => m.id)).toEqual(["a", "b", "c"]);
    expect(listedWith(b, group)).toEqual([]);
  });

  it("once the first closes, the oldest left takes over its messages", () => {
    const group = [b, c];
    expect(isQuietMember(b, group)).toBe(false);
    expect(listedWith(b, group).map((m) => m.id)).toEqual(["b", "c"]);
  });

  it("one opened over a day after the others speaks for itself", () => {
    const group = [a, late];
    expect(isQuietMember(late, group)).toBe(false);
    expect(listedWith(a, group).map((m) => m.id)).toEqual(["a"]);
  });

  it("a closed incident lists only itself", () => {
    expect(listedWith(a, [b, c]).map((m) => m.id)).toEqual(["a"]);
  });
});
