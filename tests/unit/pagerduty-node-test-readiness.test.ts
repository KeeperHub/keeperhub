import { describe, expect, it } from "vitest";

import { pagerDutyNodeTestReadiness } from "@/plugins/pagerduty/node-test-readiness";

const base = {
  hasConnection: true,
  hasService: true,
  servicesLoading: false,
  servicesError: null as string | null,
  serviceCount: 3,
};

/**
 * What the "Send a test alert" button says when it cannot run.
 *
 * One message covered every case - "Pick a connection and a service above" -
 * and it was wrong in the case somebody actually hits: a connection whose
 * credential PagerDuty rejects lists no services, so there is nothing to pick,
 * and the message reads as though no connection had been set. Somebody then
 * goes looking at the node instead of at the connection.
 */
describe("why a PagerDuty node cannot send a test alert yet", () => {
  it("is ready once a connection and a service are both chosen", () => {
    expect(pagerDutyNodeTestReadiness(base)).toBe("ready");
  });

  it("asks for a connection only when there is none", () => {
    expect(
      pagerDutyNodeTestReadiness({
        ...base,
        hasConnection: false,
        hasService: false,
        serviceCount: 0,
      })
    ).toBe("no-connection");
  });

  /** The case that prompted this: connection set, credential rejected. */
  it("blames the connection when the list could not be read", () => {
    expect(
      pagerDutyNodeTestReadiness({
        ...base,
        hasService: false,
        serviceCount: 0,
        servicesError: "PagerDuty rejected the credential (HTTP 401).",
      })
    ).toBe("connection-unreadable");
  });

  it("does not ask for a service while the list is still loading", () => {
    expect(
      pagerDutyNodeTestReadiness({
        ...base,
        hasService: false,
        servicesLoading: true,
        serviceCount: 0,
      })
    ).toBe("loading-services");
  });

  /** Read fine, genuinely empty: a different problem from a bad credential. */
  it("separates an empty account from an unreadable one", () => {
    expect(
      pagerDutyNodeTestReadiness({
        ...base,
        hasService: false,
        serviceCount: 0,
      })
    ).toBe("no-services");
  });

  it("asks for a service when the list loaded and none is picked", () => {
    expect(pagerDutyNodeTestReadiness({ ...base, hasService: false })).toBe(
      "no-service-selected"
    );
  });

  /**
   * A node that already names a service stays testable while its list is
   * reloading or has just failed. The id is stored on the node, so the test
   * route has everything it needs - and a transient list failure that greyed
   * the button out would look like the node had lost its configuration.
   */
  it("stays ready on a configured node whose list is unavailable", () => {
    expect(
      pagerDutyNodeTestReadiness({
        ...base,
        serviceCount: 0,
        servicesError: "Could not reach KeeperHub to load the service list.",
      })
    ).toBe("ready");
    expect(
      pagerDutyNodeTestReadiness({
        ...base,
        serviceCount: 0,
        servicesLoading: true,
      })
    ).toBe("ready");
  });
});
