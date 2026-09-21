import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  mergeSecretConfig,
  removeClearedKeys,
} from "@/lib/integrations/secret-fields";

/**
 * Taking a stored credential away.
 *
 * A blank secret field means "unchanged" on the way in, because the stored
 * value is never sent to the browser and cannot be sent back. That left no
 * way to remove one: filling in a replacement credential and blanking the old
 * field reported success and stored both, and for PagerDuty an API token wins
 * over OAuth, so a leaked token went on authorising every run after what
 * looked like a rotation.
 */
describe("clearing a stored connection value", () => {
  const stored = {
    apiToken: "leaked-token",
    oauthClientId: "PDABC12",
    fromEmail: "oncall@acme.io",
  };

  it("leaves a stored secret alone when nothing asks for it to go", () => {
    const merged = mergeSecretConfig(stored, { apiToken: "" }, "pagerduty");
    expect(removeClearedKeys(merged, [])).toEqual(stored);
  });

  it("removes the key a caller named", () => {
    const merged = mergeSecretConfig(stored, {}, "pagerduty");
    expect(removeClearedKeys(merged, ["apiToken"])).toEqual({
      oauthClientId: "PDABC12",
      fromEmail: "oncall@acme.io",
    });
  });

  /** The rotation the UI could not previously express. */
  it("clears the old credential while storing the new one", () => {
    const merged = mergeSecretConfig(
      stored,
      { oauthClientSecret: "fresh-secret", subdomain: "acme" },
      "pagerduty"
    );
    const result = removeClearedKeys(merged, ["apiToken"], {
      oauthClientSecret: "fresh-secret",
      subdomain: "acme",
    });
    expect(result.apiToken).toBeUndefined();
    expect(result.oauthClientSecret).toBe("fresh-secret");
  });

  /**
   * Clearing and re-entering in one go keeps what was typed - otherwise the
   * clear would silently throw away the replacement.
   */
  it("keeps a value sent for a key that is also named as cleared", () => {
    const merged = mergeSecretConfig(
      stored,
      { apiToken: "replacement" },
      "pagerduty"
    );
    expect(
      removeClearedKeys(merged, ["apiToken"], { apiToken: "replacement" })
        .apiToken
    ).toBe("replacement");
  });

  /**
   * Non-secret values do reach the browser, so a blank one is a value the
   * person emptied. `mergeSecretConfig` already stores it; the bug was that
   * the edit form dropped it before it got here.
   */
  it("stores a non-secret field that was emptied", () => {
    expect(
      mergeSecretConfig(stored, { fromEmail: "" }, "pagerduty").fromEmail
    ).toBe("");
  });

  it("does nothing when the cleared list is empty", () => {
    const config = { ...stored };
    expect(removeClearedKeys(config, [])).toBe(config);
  });
});

/**
 * Cases a review found after the first pass, each of which had a caller
 * quietly covering for the helper.
 */
describe("what counts as a replacement", () => {
  it("keeps a boolean sent for a cleared key", () => {
    expect(
      removeClearedKeys({ euRegion: "true" }, ["euRegion"], {
        euRegion: true as unknown as string,
      }).euRegion
    ).toBe("true");
  });

  it("still clears when the only value sent is empty", () => {
    expect(
      removeClearedKeys({ apiToken: "old" }, ["apiToken"], { apiToken: "" })
    ).toEqual({});
  });

  it("clears a key the caller sent nothing at all for", () => {
    expect(removeClearedKeys({ apiToken: "old" }, ["apiToken"], {})).toEqual(
      {}
    );
  });

  /**
   * Deleting is the only operation, so a key that names a prototype property
   * cannot reach a setter - and the spread makes own data properties.
   */
  it("cannot be steered by a prototype key name", () => {
    const result = removeClearedKeys({ apiToken: "old" }, [
      "__proto__",
      "constructor",
    ]);
    expect(result.apiToken).toBe("old");
    expect(({} as Record<string, unknown>).apiToken).toBeUndefined();
  });
});
