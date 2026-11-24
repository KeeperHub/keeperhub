import {
  FactProvenance,
  FactState,
  PolicyConditionKey,
} from "@/lib/policy/constants";
import type { Fact } from "@/lib/policy/types";

const DAYS: readonly string[] = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];

const MINUTE_DIGITS = 2;

function known(value: string): Fact<string> {
  return {
    state: FactState.KNOWN,
    value,
    provenance: FactProvenance.AUTHORITATIVE,
  };
}

/**
 * Facts about when a request is being decided.
 *
 * Read from the server clock at evaluation time rather than carried on the
 * request, for the same reason the actor is: a caller cannot forget to supply
 * them, and a caller cannot claim it is a different hour than it is.
 *
 * UTC throughout. A rule written against a local hour would mean something
 * different depending on which server evaluated it.
 */
export function clockFacts(
  now: Date = new Date()
): Record<string, Fact<string>> {
  const hours = String(now.getUTCHours()).padStart(MINUTE_DIGITS, "0");
  const minutes = String(now.getUTCMinutes()).padStart(MINUTE_DIGITS, "0");
  return {
    [PolicyConditionKey.TIME_WINDOW]: known(`${hours}:${minutes}`),
    [PolicyConditionKey.DAY_OF_WEEK]: known(DAYS[now.getUTCDay()]),
  };
}
