import {
  availableSendModes,
  isLooseLegacyFlag,
  SEND_MODE,
  SEND_MODE_KEY,
  type SendMode,
  sendModeOption,
  sendModeUpdates,
  unsupportedSendMode,
} from "@/lib/web3/send-mode";
import { resolveSponsorGas } from "@/lib/web3/sponsorship-feature-flag";
import {
  isConfigValueSet,
  UNSPONSORED_ONLY_FIELD_KEYS,
} from "@/lib/web3/unsponsored-only-fields";
import {
  type EditorChain,
  editorChainOf,
  editorSendModeOn,
} from "@/lib/workflow/editor/send-mode-chains";
import {
  type ActionConfigFieldBase,
  findActionById,
  flattenConfigFields,
  isFieldShown,
} from "@/plugins/registry";

/** Config writes, applied in order in one tick. */
export type ConfigWrites = [string, unknown][];

/** What one editor choice writes, how to take it back, and what to tell the user. */
export type SendModeChange = {
  writes: ConfigWrites;
  undo: ConfigWrites;
  /** Values that must still hold for the notice to show; `writes` when unset. */
  wrote?: ConfigWrites;
  /** Fees to put back on Undo when the change made the node clear them. */
  restoreIfCleared?: ConfigWrites;
  notice?: string;
};

const SPONSOR_GAS_KEY = "sponsorGas";

export const SPONSOR_ON_NOTICE =
  "Send as changed to Normal transaction (public mempool): only normal sends can be sponsored.";

/** Why Sponsor gas shows off while Send as is `mode`. */
export function sponsorOffHint(mode: SendMode): string {
  return `Off because Send as is ${sendModeOption(mode).shortLabel}. Turning it on sets Send as to Normal transaction.`;
}

export function networkChangeNotice(chainName = "this network"): string {
  return `Send as changed to Normal transaction (public mempool): ${chainName} has no private relay.`;
}

function actionFields(config: Record<string, unknown>) {
  const action =
    typeof config.actionType === "string"
      ? findActionById(config.actionType)
      : undefined;
  return action ? flattenConfigFields(action.configFields) : [];
}

function sendModeFieldOf(
  config: Record<string, unknown>
): ActionConfigFieldBase | undefined {
  return actionFields(config).find((field) => field.key === SEND_MODE_KEY);
}

export function hasSendModeField(config: Record<string, unknown>): boolean {
  return sendModeFieldOf(config) !== undefined;
}

/** The network field a Send as field follows. */
export function networkKeyOf(
  field: Pick<ActionConfigFieldBase, "networkField">
): string {
  return field.networkField ?? "network";
}

/** The network field Send as follows, when the node has Send as. */
export function sendModeNetworkField(
  config: Record<string, unknown>
): string | undefined {
  const field = sendModeFieldOf(config);
  return field ? networkKeyOf(field) : undefined;
}

/** The chain the node's Send as network names, once the chain list is known. */
export function sendModeChainOf(
  config: Record<string, unknown>
): EditorChain | undefined {
  const networkField = sendModeNetworkField(config);
  return networkField ? editorChainOf(config[networkField]) : undefined;
}

/** Send as as the editor shows it (see editorSendModeOn); Normal without the field. */
export function editorSendMode(config: Record<string, unknown>): SendMode {
  const networkField = sendModeNetworkField(config);
  return networkField
    ? editorSendModeOn(config, networkField)
    : SEND_MODE.TRANSACTION;
}

function notNormal(config: Record<string, unknown>): boolean {
  return editorSendMode(config) !== SEND_MODE.TRANSACTION;
}

/** Sponsor gas as the form shows it: off whenever Send as is not Normal. */
export function shownSponsorGas(
  config: Record<string, unknown>,
  key = SPONSOR_GAS_KEY
): unknown {
  return notNormal(config) ? false : config[key];
}

function sponsorGasField(
  config: Record<string, unknown>
): ActionConfigFieldBase | undefined {
  return actionFields(config).find((field) => field.key === SPONSOR_GAS_KEY);
}

/** Sponsor gas is shown on this node and on. */
function sponsorGasOn(config: Record<string, unknown>): boolean {
  const field = sponsorGasField(config);
  return (
    field !== undefined &&
    isFieldShown(field, config) &&
    resolveSponsorGas(config[SPONSOR_GAS_KEY])
  );
}

/** The change, with Undo taking back every written key and any cleared fee. */
function changeOf(
  config: Record<string, unknown>,
  writes: ConfigWrites,
  notice?: string
): SendModeChange {
  return {
    writes,
    undo: writes.map(([key]) => [key, config[key]]),
    restoreIfCleared: UNSPONSORED_ONLY_FIELD_KEYS.filter((fee) =>
      isConfigValueSet(config[fee])
    ).map((fee) => [fee, config[fee]]),
    notice,
  };
}

/**
 * Back to Normal from another mode. Sponsor gas that was never set showed off,
 * so it stays off rather than turning sponsorship on unseen.
 */
function toNormalWrites(config: Record<string, unknown>): ConfigWrites {
  const writes = sendModeUpdates(SEND_MODE.TRANSACTION);
  if (
    notNormal(config) &&
    sponsorGasField(config) !== undefined &&
    (config[SPONSOR_GAS_KEY] === undefined || config[SPONSOR_GAS_KEY] === null)
  ) {
    writes.push([SPONSOR_GAS_KEY, false]);
  }
  return writes;
}

/** Picking a Send as choice. Anything but Normal turns Sponsor gas off. */
export function pickSendMode(
  config: Record<string, unknown>,
  mode: SendMode
): SendModeChange {
  if (mode === SEND_MODE.TRANSACTION) {
    return changeOf(config, toNormalWrites(config));
  }
  const writes = sendModeUpdates(mode);
  let notice: string | undefined;
  if (sponsorGasOn(config)) {
    writes.push([SPONSOR_GAS_KEY, false]);
    notice = sendModeOption(mode).sponsorOffNotice;
  }
  return changeOf(config, writes, notice);
}

/** Turning Sponsor gas on sets Send as back to Normal; other settings stay. */
export function switchSponsorGas(
  config: Record<string, unknown>,
  next: boolean | undefined,
  key = SPONSOR_GAS_KEY
): SendModeChange {
  const writes: ConfigWrites = [[key, next]];
  if (!(resolveSponsorGas(next) && notNormal(config))) {
    return changeOf(config, writes);
  }
  writes.push(...sendModeUpdates(SEND_MODE.TRANSACTION));
  return changeOf(config, writes, SPONSOR_ON_NOTICE);
}

/**
 * A network pick: Send as the new chain lacks falls back to Normal, with a notice;
 * an old non-boolean flag is pinned to what it showed, never turning the relay on.
 */
export function chooseNetwork(
  config: Record<string, unknown>,
  chain: EditorChain,
  networkKey: string
): SendModeChange {
  const network: ConfigWrites = [[networkKey, String(chain.chainId)]];
  const none: SendModeChange = { writes: [], undo: [], wrote: network };
  if (sendModeNetworkField(config) !== networkKey) {
    return none;
  }
  const shown = editorSendMode(config);
  const kept =
    shown === SEND_MODE.TRANSACTION ||
    availableSendModes(chain).some((option) => option.value === shown);
  if (kept && !isLooseLegacyFlag(config)) {
    return none;
  }
  const writes = kept ? sendModeUpdates(shown) : toNormalWrites(config);
  const change = changeOf(
    config,
    writes,
    kept ? undefined : networkChangeNotice(chain.name)
  );
  return {
    ...change,
    // Undo puts the network back too; the notice goes once it changes again.
    undo: [[networkKey, config[networkKey]], ...change.undo],
    wrote: [...network, ...writes],
  };
}

export type SendModeWarning = {
  text: string;
  unsupported: boolean;
  /** The step stops before sending (not a strict: false public send). */
  fails: boolean;
};

/** Why the node will not send as its Send as says: the step or chain lacks it. */
export function sendModeWarning(
  config: Record<string, unknown>
): SendModeWarning | undefined {
  const mode = editorSendMode(config);
  const unsupported = unsupportedSendMode(config.actionType, mode);
  if (unsupported) {
    return { text: unsupported, unsupported: true, fails: true };
  }
  const chain = sendModeChainOf(config);
  const option = sendModeOption(mode);
  if (chain === undefined || option.availableOn(chain)) {
    return;
  }
  const fallsBack = config.strict === false;
  const text = option.unavailableNotice?.(
    chain.name ?? "This network",
    fallsBack
  );
  return text ? { text, unsupported: false, fails: !fallsBack } : undefined;
}

/** A node that will run privately: Send as is not Normal and nothing stops it. */
export function sendsPrivately(config: Record<string, unknown>): boolean {
  return (
    editorSendMode(config) !== SEND_MODE.TRANSACTION &&
    sendModeWarning(config) === undefined
  );
}
