import type { ShowWhen } from "@/lib/workflow/editor/show-when";

/**
 * Batch Read Contract's Input Mode and Calls From values, shared by its
 * fields, its step and workflow validation so the three read a config alike.
 * No runtime imports: the plugin definition loads in the browser.
 */
export const BATCH_READ_CONTRACT_ACTION_TYPE = "web3/batch-read-contract";
export const INPUT_MODE_UNIFORM = "uniform";
export const INPUT_MODE_MIXED = "mixed";
export const CALLS_FROM_ROWS = "rows";
export const CALLS_FROM_ARGS_LIST = "args-list";
export const CALLS_FROM_ADDRESS_LIST = "address-list";

/** Anything but mixed is uniform, an absent Input Mode included. */
export function isUniformInputMode(inputMode: unknown): boolean {
  return inputMode !== INPUT_MODE_MIXED;
}

/** The calls go to every address in Contract Addresses, not to Contract Address. */
export function readsFromAddressList(config: Record<string, unknown>): boolean {
  return (
    isUniformInputMode(config.inputMode) &&
    config.callsFrom === CALLS_FROM_ADDRESS_LIST
  );
}

const UNIFORM_MODE = { field: "inputMode", notEquals: INPUT_MODE_MIXED };

export const SHOW_WHEN_UNIFORM: ShowWhen = UNIFORM_MODE;

export const SHOW_WHEN_CONTRACT_ADDRESS: ShowWhen = {
  all: [
    UNIFORM_MODE,
    { field: "callsFrom", notEquals: CALLS_FROM_ADDRESS_LIST },
  ],
};

export const SHOW_WHEN_ROWS: ShowWhen = {
  all: [
    UNIFORM_MODE,
    { field: "callsFrom", notEquals: CALLS_FROM_ARGS_LIST },
    { field: "callsFrom", notEquals: CALLS_FROM_ADDRESS_LIST },
  ],
};

export const SHOW_WHEN_ARGS_LIST: ShowWhen = {
  all: [UNIFORM_MODE, { field: "callsFrom", equals: CALLS_FROM_ARGS_LIST }],
};

export const SHOW_WHEN_ADDRESS_LIST: ShowWhen = {
  all: [UNIFORM_MODE, { field: "callsFrom", equals: CALLS_FROM_ADDRESS_LIST }],
};
