/**
 * Unit tests for KEEP-458 decideSeedAction.
 *
 * The seeder's gating logic for "should I insert / refresh / skip this
 * deterministic-ID row?" lives in a pure function extracted from upsertOne.
 * Locking it down here means a regression in the user-edit detection (the
 * difference between protecting a UI edit and clobbering it) fails in
 * `pnpm test:unit`, not after someone notices their dashboard tweaks
 * disappeared.
 */

import { describe, expect, it } from "vitest";
import {
  decideSeedAction,
  USER_EDIT_EPSILON_MS,
} from "@/scripts/seed/seed-protocol-workflows";

const SEED_AT = new Date("2026-05-12T14:00:00.000Z");
const afterSeed = (ms: number): Date => new Date(SEED_AT.getTime() + ms);

describe("decideSeedAction", () => {
  it("returns insert when no existing row", () => {
    expect(decideSeedAction(undefined, USER_EDIT_EPSILON_MS)).toEqual({
      kind: "insert",
    });
  });

  it("returns skip(user-created) when seededAt is null", () => {
    expect(
      decideSeedAction(
        { updatedAt: SEED_AT, seededAt: null },
        USER_EDIT_EPSILON_MS
      )
    ).toEqual({ kind: "skip", reason: "user-created" });
  });

  it("returns refresh when updatedAt == seededAt (the just-inserted case)", () => {
    expect(
      decideSeedAction(
        { updatedAt: SEED_AT, seededAt: SEED_AT },
        USER_EDIT_EPSILON_MS
      )
    ).toEqual({ kind: "refresh" });
  });

  it("returns refresh when gapMs is just below epsilon", () => {
    expect(
      decideSeedAction(
        { updatedAt: afterSeed(USER_EDIT_EPSILON_MS - 1), seededAt: SEED_AT },
        USER_EDIT_EPSILON_MS
      )
    ).toEqual({ kind: "refresh" });
  });

  it("returns refresh when gapMs equals epsilon (boundary inclusive)", () => {
    // gapMs > epsilon means strict >, so equality is still a refresh. This
    // is the load-bearing boundary: the seeder's own INSERT + UPDATE on a
    // single row can produce gaps up to a few ms; epsilon must accommodate
    // them without false-positive "user-edited" classifications.
    expect(
      decideSeedAction(
        { updatedAt: afterSeed(USER_EDIT_EPSILON_MS), seededAt: SEED_AT },
        USER_EDIT_EPSILON_MS
      )
    ).toEqual({ kind: "refresh" });
  });

  it("returns skip(user-edited) when gapMs exceeds epsilon", () => {
    expect(
      decideSeedAction(
        { updatedAt: afterSeed(USER_EDIT_EPSILON_MS + 1), seededAt: SEED_AT },
        USER_EDIT_EPSILON_MS
      )
    ).toEqual({
      kind: "skip",
      reason: "user-edited",
      gapMs: USER_EDIT_EPSILON_MS + 1,
    });
  });

  it("returns refresh when seededAt is after updatedAt (negative gap)", () => {
    // Defensive: clock skew or microsecond rounding could produce a
    // seededAt strictly after the corresponding updatedAt on the same
    // statement. A negative gap can never indicate a user edit, so we
    // treat it as the seeder's own touch.
    expect(
      decideSeedAction(
        { updatedAt: SEED_AT, seededAt: afterSeed(10) },
        USER_EDIT_EPSILON_MS
      )
    ).toEqual({ kind: "refresh" });
  });

  it("honours a custom epsilon", () => {
    // The seeder hardcodes 5000ms, but the function is parameterised. A
    // future caller (e.g. an integration test wanting tighter detection)
    // can pass a smaller value without forking the logic.
    const small = 100;
    expect(
      decideSeedAction(
        { updatedAt: afterSeed(small + 1), seededAt: SEED_AT },
        small
      )
    ).toEqual({ kind: "skip", reason: "user-edited", gapMs: small + 1 });
  });
});
