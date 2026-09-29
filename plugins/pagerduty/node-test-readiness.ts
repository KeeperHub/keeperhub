/**
 * Whether the "Send a test alert" button on a PagerDuty node can run yet, and
 * if not, which thing is missing.
 *
 * The button used to show one message for every not-ready case: "Pick a
 * connection and a service above". That is wrong in the case that actually
 * sends somebody looking - a connection whose credential PagerDuty rejects
 * loads no services, so there is no service to pick, and being told to pick
 * one reads as though the connection had not been set at all.
 *
 * The decision lives here rather than in the component so it can be tested
 * without a DOM, the way the rest of this plugin's logic is. It imports
 * nothing.
 */
export type PagerDutyNodeTestReadiness =
  | "ready"
  | "no-connection"
  | "loading-services"
  | "connection-unreadable"
  | "no-services"
  | "no-service-selected";

export function pagerDutyNodeTestReadiness(state: {
  hasConnection: boolean;
  hasService: boolean;
  servicesLoading: boolean;
  servicesError: string | null;
  serviceCount: number;
}): PagerDutyNodeTestReadiness {
  // A service already chosen is enough to test with, whatever the list is
  // doing now. The node stores the id, so a list still loading - or one that
  // failed on this render - does not make a configured node untestable.
  if (state.hasConnection && state.hasService) {
    return "ready";
  }
  if (!state.hasConnection) {
    return "no-connection";
  }
  if (state.servicesLoading) {
    return "loading-services";
  }
  if (state.servicesError) {
    return "connection-unreadable";
  }
  if (state.serviceCount === 0) {
    return "no-services";
  }
  return "no-service-selected";
}
