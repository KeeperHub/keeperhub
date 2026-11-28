import { describe, expect, it } from "vitest";
import {
  SLOT_CLOCK_GENESIS,
  msUntilSlotCheck,
  nextSlotToCheck,
  slotAt,
  slotStartSeconds,
} from "../../lib/slot-clock.js";

const GENESIS = SLOT_CLOCK_GENESIS[1];
const startMs = (slot: number): number =>
  slotStartSeconds(GENESIS, slot) * 1000;

describe("slot clock", () => {
  it("knows Ethereum mainnet, Sepolia and Hoodi genesis only", () => {
    expect(SLOT_CLOCK_GENESIS).toEqual({
      1: 1_606_824_023,
      11155111: 1_655_733_600,
      560048: 1_742_213_400,
    });
  });

  it("starts slot n at genesis + 12n seconds", () => {
    expect(slotStartSeconds(GENESIS, 0)).toBe(GENESIS);
    expect(slotStartSeconds(GENESIS, 10)).toBe(GENESIS + 120);
  });

  it("puts a block in the slot its timestamp falls in", () => {
    expect(slotAt(GENESIS, GENESIS + 120)).toBe(10);
    expect(slotAt(GENESIS, GENESIS + 131)).toBe(10);
  });

  it("checks a slot 4 s after it starts, and only once that is in the future", () => {
    expect(nextSlotToCheck(GENESIS, startMs(10))).toBe(10);
    expect(nextSlotToCheck(GENESIS, startMs(10) + 3999)).toBe(10);
    expect(nextSlotToCheck(GENESIS, startMs(10) + 4000)).toBe(11);
    expect(nextSlotToCheck(GENESIS, startMs(10) + 11_999)).toBe(11);
  });

  it("waits until the check time, never a negative delay", () => {
    expect(msUntilSlotCheck(GENESIS, 10, startMs(10))).toBe(4000);
    expect(msUntilSlotCheck(GENESIS, 10, startMs(10) + 5000)).toBe(0);
  });
});
