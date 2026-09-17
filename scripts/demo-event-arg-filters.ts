/**
 * Demo for issue #2489: filter Query Contract Events by indexed event arguments.
 *
 * Offline demo (no RPC, no credentials, no network): it runs the exact
 * normalization the step uses (`parseIndexedEventArgs` +
 * `expandIndexedArgsToEventPositions`) and then builds the
 * real DeferredTopicFilter the batch path builds
 * (`contract.filters[eventName](...fullArgs)`), printing the resulting
 * eth_getLogs topics for each case.
 *
 * Run: pnpm tsx scripts/demo-event-arg-filters.ts
 */
import { ethers } from "ethers";
import {
  expandIndexedArgsToEventPositions,
  parseIndexedEventArgs,
} from "@/plugins/web3/steps/query-events-core";

const ERC20_ABI = [
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "event FlagSet(address indexed setter, bool indexed active, string note)",
];

const CONTRACT_ADDRESS = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

const FROM = "0x1111111111111111111111111111111111111111";
const TO = "0x2222222222222222222222222222222222222222";

const iface = new ethers.Interface(ERC20_ABI);

function showTopics(
  eventName: string,
  eventArgs: string | unknown[] | undefined
): void {
  const label =
    eventArgs === undefined ? "undefined" : JSON.stringify(eventArgs);
  const fragment = iface.getEvent(eventName);
  if (!fragment) {
    throw new Error(`event ${eventName} not found`);
  }
  try {
    const indexedArgs = parseIndexedEventArgs(fragment, eventArgs);
    // Eager validation, same as the step handler does before any RPC work.
    // The args are expanded to full event positions first, exactly like
    // the step and the batch path do.
    const fullArgs = expandIndexedArgsToEventPositions(fragment, indexedArgs);
    iface.encodeFilterTopics(fragment, [...fullArgs]);
    // The exact filter construction fetchFixedBatch/fetchTipBatch use.
    const contract = new ethers.Contract(CONTRACT_ADDRESS, ERC20_ABI);
    const filter = (
      contract.filters as unknown as Record<
        string,
        (...args: unknown[]) => { topics: unknown }
      >
    )[eventName]?.(...fullArgs);
    console.log(`eventArgs=${label}`);
    console.log(`  indexedArgs=${JSON.stringify(indexedArgs)}`);
    console.log(`  topics=${JSON.stringify(filter?.topics)}`);
  } catch (error) {
    console.log(`eventArgs=${label}`);
    console.log(
      `  ERROR: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

console.log("== Transfer(address indexed from, address indexed to, uint256 value) ==");
showTopics("Transfer", undefined);
showTopics("Transfer", "");
showTopics("Transfer", "[]");
showTopics("Transfer", `["${FROM}"]`);
showTopics("Transfer", `["", "${TO}"]`);
showTopics("Transfer", `["${FROM}", "${TO}"]`);
showTopics("Transfer", "not-json");
showTopics("Transfer", `["${FROM}", "${TO}", "extra"]`);
showTopics("Transfer", `["0xbad"]`);

console.log("");
console.log("== FlagSet(address indexed setter, bool indexed active, string note) ==");
// Bool string coercion ("true" -> true) via coerceArgsForAbi; the non-indexed
// `note` parameter has no position in the array.
showTopics("FlagSet", `["${FROM}", "true"]`);
showTopics("FlagSet", `["${FROM}"]`);
