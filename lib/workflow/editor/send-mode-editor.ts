import { isToggleValue } from "@/lib/utils";
import {
  availableSendModes,
  isLegacyPrivateRelayConfig,
  LEGACY_PRIVATE_MEMPOOL_KEY,
  resolveSendMode,
  SEND_MODE,
  SEND_MODE_KEY,
  type SendMode,
  sendModeConflict,
  sendModeOption,
  sendModeUpdates,
  unknownSendModeIssue,
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

const SPONSOR_ON_NOTICE =
  "Send as changed to Normal transaction (public mempool): only normal sends can be sponsored.";

/** Why Sponsor gas shows off while Send as is `mode`. */
export function sponsorOffHint(mode: SendMode): string {
  return `Off because Send as is ${sendModeOption(mode).shortLabel}. Turning it on sets Send as to Normal transaction.`;
}

const LEGACY_UNRESOLVED_NOTICE =
  "This step uses the private relay where its network has one, otherwise the public mempool.";

function networkChangeNotice(chainName = "this network"): string {
  return `Send as changed to Normal transaction (public mempool): ${chainName} has no private relay.`;
}

function actionLabel(config: Record<string, unknown>): string {
  return typeof config.actionType === "string"
    ? (findActionById(config.actionType)?.label ?? "This action")
    : "This action";
}

/** An old flag on an action without the relay option: it runs as before, on the relay where there is one. */
function legacyUnsupportedNotice(
  config: Record<string, unknown>,
  chainName: string | undefined
): string {
  const saved = `This step was saved with the old "(Flashbots)" network, so it still sends through`;
  const fix =
    "Set Send as to Normal transaction to send publicly, or split the calls into Write Contract steps to keep them private.";
  if (chainName !== undefined) {
    return `${saved} ${chainName}'s private relay. ${actionLabel(config)} checks its calls with eth_call first, which the private relay (Flashbots Protect) refuses, so every run fails before sending. ${fix}`;
  }
  return `${saved} the private relay where its network has one, otherwise the public mempool. ${actionLabel(config)} checks its calls with eth_call, which a relay such as Flashbots Protect refuses, so on such a relay it fails before sending. ${fix}`;
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
function sendModeChainOf(
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

/**
 * Sponsor gas as the form shows it: off whenever Send as is not Normal. A
 * value that is neither on nor off shows as stored, so it can be reset.
 */
export function shownSponsorGas(
  config: Record<string, unknown>,
  key = SPONSOR_GAS_KEY
): unknown {
  return notNormal(config) && isToggleValue(config[key]) ? false : config[key];
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

/**
 * A stored value as Undo can write it back: the editor's adapter turns null and
 * numbers into strings ("null", "0"), so those are cleared or read as booleans.
 */
function undoValue(key: string, value: unknown): unknown {
  if (value === null) {
    return;
  }
  if (typeof value === "number" && key === LEGACY_PRIVATE_MEMPOOL_KEY) {
    return Boolean(value);
  }
  return typeof value === "number" && key === SPONSOR_GAS_KEY
    ? undefined
    : value;
}

/** The change, with Undo taking back every written key and any cleared fee. */
function changeOf(
  config: Record<string, unknown>,
  writes: ConfigWrites,
  notice?: string
): SendModeChange {
  return {
    writes,
    undo: writes.map(([key]) => [key, undoValue(key, config[key])]),
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

/**
 * Turning Sponsor gas on sets Send as back to Normal; other settings stay.
 * Reset (`undefined`) only clears the key: it shows off while Send as is not Normal.
 */
export function switchSponsorGas(
  config: Record<string, unknown>,
  next: boolean | undefined,
  key = SPONSOR_GAS_KEY
): SendModeChange {
  const writes: ConfigWrites = [[key, next]];
  if (next !== true || !notNormal(config)) {
    return changeOf(config, writes);
  }
  writes.push(...sendModeUpdates(SEND_MODE.TRANSACTION));
  return changeOf(config, writes, SPONSOR_ON_NOTICE);
}

/** A network pick: Send as the new chain lacks falls back to Normal, with a notice. */
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
  // The old flag alone uses a relay only where there is one: it stays as saved.
  if (kept || isLegacyPrivateRelayConfig(config)) {
    return none;
  }
  const writes = toNormalWrites(config);
  const change = changeOf(config, writes, networkChangeNotice(chain.name));
  return {
    ...change,
    // Undo puts the network back too; the notice goes once it changes again.
    undo: [[networkKey, config[networkKey]], ...change.undo],
    wrote: [...network, ...writes],
  };
}

type SendModeWarning = {
  text: string;
  unsupported: boolean;
  /** The step stops before sending (not a public send). */
  fails: boolean;
  /** The keys disagree or name no mode: fixed by the warning's buttons. */
  keys?: boolean;
};

/** "Keep <mode>" is offered on a keys warning: the step and chain offer the shown mode. */
export function keepsShownMode(config: Record<string, unknown>): boolean {
  const mode = editorSendMode(config);
  return (
    mode !== SEND_MODE.TRANSACTION &&
    sendModeOption(mode).availableOn(sendModeChainOf(config)) &&
    !unsupportedSendMode(config.actionType, mode)
  );
}

/** Names the buttons under a keys warning: the Send as select does not fire for its shown value. */
function keysFixHint(config: Record<string, unknown>): string {
  return keepsShownMode(config)
    ? `Pick Use Normal transaction or Keep ${sendModeOption(editorSendMode(config)).shortLabel} to fix it.`
    : "Pick Use Normal transaction to fix it.";
}

const CONFLICT_PREFIX = "This step's saved Send as settings disagree.";

/** A stored conflict runs as `sendMode` and a save keeps it; the rest is checked on aligned keys. */
function conflictWarning(config: Record<string, unknown>): SendModeWarning {
  const mode = resolveSendMode(config);
  const aligned = sendModeWarning({
    ...config,
    [LEGACY_PRIVATE_MEMPOOL_KEY]: mode === SEND_MODE.PRIVATE_RELAY,
  });
  if (aligned) {
    // The unsupported text already names Normal transaction.
    const hint = aligned.unsupported ? "" : ` ${keysFixHint(config)}`;
    return {
      ...aligned,
      text: `${CONFLICT_PREFIX} ${aligned.text}${hint}`,
      keys: true,
    };
  }
  return {
    text: `${CONFLICT_PREFIX} It runs as ${sendModeOption(mode).shortLabel}; saving keeps them as they are, but a new network or action needs the fix first. ${keysFixHint(config)}`,
    unsupported: false,
    fails: false,
    keys: true,
  };
}

/** Keys to fix: an unknown `sendMode`, or both keys set and in conflict. */
function keysIssue(config: Record<string, unknown>): string | undefined {
  return (
    unknownSendModeIssue(config[SEND_MODE_KEY]) ?? sendModeConflict(config)
  );
}

/**
 * Why the node will not send as its Send as says (the step or chain lacks it),
 * or why its keys need fixing. A step that sends publicly instead does not fail.
 */
export function sendModeWarning(
  config: Record<string, unknown>
): SendModeWarning | undefined {
  if (unknownSendModeIssue(config[SEND_MODE_KEY])) {
    // Refused when the step runs.
    return {
      text: `This step's saved Send as value is not a known choice, so the step fails before sending. ${keysFixHint(config)}`,
      unsupported: false,
      fails: true,
      keys: true,
    };
  }
  if (sendModeConflict(config)) {
    return conflictWarning(config);
  }
  const mode = editorSendMode(config);
  const chain = sendModeChainOf(config);
  const option = sendModeOption(mode);
  const noRelay = chain !== undefined && !option.availableOn(chain);
  // The old flag alone uses a relay only where there is one: elsewhere it sends
  // publicly, on any action, as it always did.
  const legacy = isLegacyPrivateRelayConfig(config);
  const unsupported = unsupportedSendMode(config.actionType, mode);
  if (unsupported && !legacy) {
    return { text: unsupported, unsupported: true, fails: true };
  }
  // The old flag runs its eth_call check on the relay; a public fallback with strict: false is not proven.
  if (unsupported && !noRelay) {
    return {
      text: legacyUnsupportedNotice(
        config,
        chain && (chain.name ?? "this network")
      ),
      unsupported: true,
      fails: true,
    };
  }
  if (!noRelay) {
    // Shown once the list loaded (or failed) and the network still does not resolve.
    return legacy && chain === undefined && mode !== SEND_MODE.TRANSACTION
      ? { text: LEGACY_UNRESOLVED_NOTICE, unsupported: false, fails: false }
      : undefined;
  }
  const fallsBack = config.strict === false || legacy;
  const text = option.unavailableNotice?.(
    chain?.name ?? "This network",
    fallsBack
  );
  return text ? { text, unsupported: false, fails: !fallsBack } : undefined;
}

/** Whether picking `mode` changes anything: another mode, or keys to fix. */
export function pickChanges(
  config: Record<string, unknown>,
  mode: SendMode
): boolean {
  return mode !== editorSendMode(config) || keysIssue(config) !== undefined;
}

/**
 * Every value the new action's form holds, so the notice (and its Undo of the
 * whole switch) goes once the user changes any of them. The integration is picked later.
 */
function untouchedAfterSwitch(after: Record<string, unknown>): ConfigWrites {
  const keys = new Set([
    ...Object.keys(after),
    ...actionFields(after).map((field) => field.key),
  ]);
  keys.delete("integrationId");
  return [...keys].map((key) => [key, after[key]]);
}

/** A form's own fill: no text typed or picked (empty rows, off flags, empty lists). */
function holdsNoInput(value: unknown, nested = false): boolean {
  if (value === undefined || value === null || value === "") {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every((item) => holdsNoInput(item, true));
  }
  if (typeof value === "object") {
    return Object.values(value).every((item) => holdsNoInput(item, true));
  }
  if (typeof value !== "string") {
    return nested && value === false;
  }
  if (nested && value === "false") {
    return true;
  }
  const text = value.trim();
  if (!(text.startsWith("[") || text.startsWith("{"))) {
    return text === "";
  }
  try {
    return holdsNoInput(JSON.parse(text), true);
  } catch {
    return false;
  }
}

/**
 * Whether the step is as the action switch left it, so its Undo loses nothing
 * the user did. Send as, the action and the network must match exactly; a key
 * the switch left unset may since hold a field's mount fill or default.
 */
export function untouchedSinceSwitch(
  config: Record<string, unknown>,
  wrote: ConfigWrites
): boolean {
  const exact = new Set([
    "actionType",
    SEND_MODE_KEY,
    LEGACY_PRIVATE_MEMPOOL_KEY,
    sendModeNetworkField(config) ?? "network",
  ]);
  const defaults = new Map(
    actionFields(config).map((field) => [field.key, field.defaultValue])
  );
  return wrote.every(([key, recorded]) => {
    const value = config[key];
    if (Object.is(value, recorded)) {
      return true;
    }
    if (exact.has(key) || isConfigValueSet(recorded)) {
      return false;
    }
    const fallback = defaults.get(key);
    return (
      holdsNoInput(value) ||
      (fallback !== undefined && String(fallback) === String(value))
    );
  });
}

/**
 * The notice when an action switch set Send as back to Normal because the new
 * action cannot send privately. The caller's Undo puts back the whole config.
 */
export function actionSwitchNotice(
  before: Record<string, unknown>,
  after: Record<string, unknown>
): SendModeChange | undefined {
  // The stored mode: the editor shows an old flag as Normal while chains load.
  const was = hasSendModeField(before)
    ? resolveSendMode(before)
    : SEND_MODE.TRANSACTION;
  if (
    was === SEND_MODE.TRANSACTION ||
    editorSendMode(after) !== SEND_MODE.TRANSACTION ||
    !unsupportedSendMode(after.actionType, was)
  ) {
    return;
  }
  const label = actionLabel(after);
  const chain = sendModeChainOf(before);
  const legacy = isLegacyPrivateRelayConfig(before);
  let notice = `Send as changed to Normal transaction (public mempool): ${label} can't send through the private relay yet.`;
  if (legacy && chain === undefined) {
    // Network not known yet: the old flag may have sent publicly already.
    notice = `Send as changed to Normal transaction: this step now sends to the public mempool on every network (${label} has no private relay option yet).`;
  } else if (legacy && chain && !sendModeOption(was).availableOn(chain)) {
    notice = `Send as changed to Normal transaction: ${chain.name ?? "this network"} has no private relay, so this step already sent to the public mempool.`;
  }
  return { writes: [], undo: [], wrote: untouchedAfterSwitch(after), notice };
}

/** A node that will run privately: Send as is not Normal and nothing stops it. */
export function sendsPrivately(config: Record<string, unknown>): boolean {
  if (editorSendMode(config) === SEND_MODE.TRANSACTION) {
    return false;
  }
  const warning = sendModeWarning(config);
  if (warning === undefined) {
    return true;
  }
  if (!(warning.keys && sendModeConflict(config))) {
    return false;
  }
  // A stored conflict runs as `sendMode`: judge it on the aligned keys.
  return (
    sendModeWarning({
      ...config,
      [LEGACY_PRIVATE_MEMPOOL_KEY]:
        resolveSendMode(config) === SEND_MODE.PRIVATE_RELAY,
    }) === undefined
  );
}
