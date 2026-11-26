"use client";

import { atom, useAtom, useAtomValue, useSetAtom } from "jotai";
import { AlertTriangle, Info, X } from "lucide-react";
import {
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SponsorGasField } from "@/components/workflow/config/sponsor-gas-field";
import { useSendModeChains } from "@/lib/hooks/use-send-mode-chains";
import { cn } from "@/lib/utils";
import {
  availableSendModes,
  isLegacyPrivateRelayConfig,
  isSendMode,
  SEND_MODE,
  sendModeOption,
  unsupportedSendMode,
} from "@/lib/web3/send-mode";
import { isConfigValueSet } from "@/lib/web3/unsponsored-only-fields";
import {
  editorChainOf,
  editorSendModeOn,
} from "@/lib/workflow/editor/send-mode-chains";
import {
  actionSwitchNotice,
  type ConfigWrites,
  editorSendMode,
  networkKeyOf,
  pickChanges,
  pickSendMode,
  type SendModeChange,
  sendModeNetworkField,
  keepsShownMode,
  sendModeWarning,
  shownSponsorGas,
  sponsorOffHint,
  switchSponsorGas,
  untouchedSinceSwitch,
} from "@/lib/workflow/editor/send-mode-editor";
import {
  currentWorkflowIdAtom,
  selectedNodeAtom,
  updateNodeDataAtom,
} from "@/lib/workflow/store";
import type { ActionConfigFieldBase } from "@/plugins/registry";

/** Names the chain as the old network list did, e.g. "Ethereum Mainnet (Flashbots)". */
function legacyRelayNotice(chainName = "Ethereum", sameNetwork = true): string {
  const note = `${chainName} (Flashbots) is now ${chainName} with "Send as" set to Private relay.`;
  // After a network change the step no longer sends as it did.
  return sameNetwork ? `${note} This step sends exactly as before.` : note;
}

const LEGACY_NOTICE_KEY_PREFIX = "kh:send-as-legacy-notice:";

/** Focus a control once the change it follows has rendered, then run `then`. */
function focusLater(id: string, then?: () => void): void {
  setTimeout(() => {
    document.getElementById(id)?.focus();
    // Next tick, so a screen reader reads the newly focused control first.
    if (then) {
      setTimeout(then, 0);
    }
  }, 0);
}

function applyWrites(
  onUpdateConfig: (key: string, value: unknown) => void,
  writes: ConfigWrites
): void {
  for (const [key, value] of writes) {
    onUpdateConfig(key, value);
  }
}

type NoticeAction = {
  label: string;
  onClick: () => void;
  /** Read after the label by screen readers, to tell same-named buttons apart. */
  srSuffix?: string;
};

type NoticeProps = {
  text: string;
  testId: string;
  /** Lets a control point aria-describedby at the text. */
  textId?: string;
  tone?: "info" | "warning";
  action?: NoticeAction | NoticeAction[];
  onClose?: () => void;
};

/** A change the editor made for the user, or a setting that needs one. */
export function EditorChangeNotice({
  text,
  testId,
  textId,
  tone = "info",
  action,
  onClose,
}: NoticeProps) {
  const Icon = tone === "warning" ? AlertTriangle : Info;
  const actions = action === undefined ? [] : [action].flat();
  return (
    <div
      className={cn(
        "flex items-start gap-2 rounded-md border p-2 text-xs",
        tone === "warning"
          ? "border-destructive/40 bg-destructive/5 text-foreground"
          : "border-border bg-muted/50 text-muted-foreground"
      )}
      data-testid={testId}
    >
      <Icon
        aria-hidden="true"
        className={cn(
          "mt-0.5 size-3.5 shrink-0",
          tone === "warning" && "text-destructive"
        )}
      />
      {/* The action wraps under the text when the panel is narrow. */}
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
        <span className="min-w-0 grow basis-48 break-words" id={textId}>
          {text}
        </span>
        {actions.map((item) => (
          <Button
            className="h-8 shrink-0 touch-ui:h-11 px-2 text-foreground text-xs"
            key={item.label}
            onClick={item.onClick}
            size="sm"
            type="button"
            variant="outline"
          >
            {item.label}
            {item.srSuffix && (
              <span className="sr-only"> {item.srSuffix}</span>
            )}
          </Button>
        ))}
      </div>
      {onClose && (
        <button
          aria-label="Dismiss"
          className="inline-flex size-6 shrink-0 touch-ui:size-11 items-center justify-center rounded-sm hover:text-foreground"
          onClick={onClose}
          type="button"
        >
          <X aria-hidden="true" className="size-3.5" />
        </button>
      )}
    </div>
  );
}

type NoticeOrigin = "send-mode" | "sponsor-gas" | "network";

type SlotNotice = {
  nodeId: string | null;
  origin: NoticeOrigin;
  text: string;
  wrote: ConfigWrites;
  undo: ConfigWrites;
  restoreIfCleared: ConfigWrites;
  // The control Undo puts focus back on.
  focusId: string;
  // Undo that replaces the node's config itself, instead of writing `undo`.
  restore?: () => void;
};

// One slot for the editor, shown only on the node that set it.
const editorNoticeAtom = atom<SlotNotice | null>(null);

type ConfigWrite = {
  nodeId: string;
  key: string;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  /** Runs before Undo puts back `before` (e.g. cancel a pending auto-select). */
  onUndo?: () => void;
};

/**
 * Call after each field write in the side panel or the overlay. An action
 * switch that reset Send as shows its notice under Network, with Undo putting
 * back the whole config; a manual integration pick drops it, so Undo never
 * reverts that pick.
 */
export function useActionSwitchNotice(): (write: ConfigWrite) => void {
  const setSlot = useSetAtom(editorNoticeAtom);
  const updateNodeData = useSetAtom(updateNodeDataAtom);
  return useCallback(
    ({ nodeId, key, before, after, onUndo }: ConfigWrite): void => {
      if (key === "integrationId") {
        setSlot((slot) => (slot?.restore && slot.nodeId === nodeId ? null : slot));
        return;
      }
      const change =
        key === "actionType" ? actionSwitchNotice(before, after) : undefined;
      if (!change?.notice) {
        return;
      }
      setSlot({
        nodeId,
        origin: "network",
        text: change.notice,
        wrote: change.wrote ?? change.writes,
        undo: change.undo,
        restoreIfCleared: change.restoreIfCleared ?? [],
        focusId: sendModeNetworkField(before) ?? "network",
        restore: () => {
          onUndo?.();
          updateNodeData({ id: nodeId, data: { config: before } });
        },
      });
    },
    [setSlot, updateNodeData]
  );
}

/**
 * The editor's notice slot, as seen by one field. A notice shows only while its
 * keys still hold what it wrote (an action switch also allows form fills), so
 * its Undo never writes stale values.
 */
export function useEditorNotice(
  origin: NoticeOrigin,
  config: Record<string, unknown>,
  onUpdateConfig: (key: string, value: unknown) => void,
  focusId: string
) {
  const nodeId = useAtomValue(selectedNodeAtom);
  const [slot, setSlot] = useAtom(editorNoticeAtom);
  const notice =
    slot?.origin === origin &&
    slot.nodeId === nodeId &&
    (slot.restore
      ? untouchedSinceSwitch(config, slot.wrote)
      : slot.wrote.every(([key, value]) => Object.is(config[key], value)))
      ? slot
      : null;
  return {
    notice,
    apply(change: SendModeChange): void {
      applyWrites(onUpdateConfig, change.writes);
      setSlot(
        change.notice
          ? {
              nodeId,
              origin,
              text: change.notice,
              wrote: change.wrote ?? change.writes,
              undo: change.undo,
              restoreIfCleared: change.restoreIfCleared ?? [],
              focusId,
            }
          : null
      );
    },
    /** Undo is offered only when there is something to take back. */
    canUndo: notice !== null && (notice.undo.length > 0 || !!notice.restore),
    close(): void {
      // The close button goes with the notice; focus its control instead.
      if (notice) {
        focusLater(notice.focusId);
      }
      setSlot(null);
    },
    undo(): void {
      if (notice?.restore) {
        notice.restore();
        focusLater(notice.focusId);
      } else if (notice) {
        applyWrites(onUpdateConfig, notice.undo);
        applyWrites(
          onUpdateConfig,
          notice.restoreIfCleared.filter(
            ([key]) => !isConfigValueSet(config[key])
          )
        );
        focusLater(notice.focusId);
      }
      setSlot(null);
    },
  };
}

function readSeen(key: string): boolean {
  try {
    return window.localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function markSeen(key: string): void {
  try {
    window.localStorage.setItem(key, "1");
  } catch {
    // Storage blocked: the notice may show again, which is harmless.
  }
}

/**
 * The one-time notice on a node saved with the old "(Flashbots)" network, once
 * its chain is known and has the relay. Remembered per browser, never in the workflow.
 */
function useLegacyNotice(
  config: Record<string, unknown>,
  ready: boolean
): {
  show: boolean;
  close: () => void;
  ref: RefObject<HTMLDivElement | null>;
} {
  const workflowId = useAtomValue(currentWorkflowIdAtom);
  const nodeId = useAtomValue(selectedNodeAtom);
  const legacy = isLegacyPrivateRelayConfig(config);
  const key =
    legacy && ready && workflowId && nodeId
      ? `${LEGACY_NOTICE_KEY_PREFIX}${workflowId}:${nodeId}`
      : null;
  const [shownFor, setShownFor] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const showing = useRef<string | null>(null);
  const show = key !== null && shownFor === key;

  useEffect(() => {
    if (key && !readSeen(key)) {
      setShownFor(key);
    }
  }, [key]);

  // Seen once it goes away after being on screen; a hidden copy does not count.
  useEffect(() => {
    if (!(show && key) || ref.current?.getClientRects().length === 0) {
      return;
    }
    showing.current = key;
    return () => {
      showing.current = null;
      // A remount right away (React's dev double run) is not a close.
      setTimeout(() => {
        if (showing.current !== key) {
          markSeen(key);
        }
      }, 0);
    };
  }, [show, key]);

  return {
    show,
    close: () => {
      if (key) {
        markSeen(key);
      }
      setShownFor(null);
    },
    ref,
  };
}

type SendModeFieldProps = {
  field: ActionConfigFieldBase;
  config: Record<string, unknown>;
  onUpdateConfig: (key: string, value: unknown) => void;
  disabled?: boolean;
};

/** "Send as": how a write step's transaction goes out. */
export function SendModeField({
  field,
  config,
  onUpdateConfig,
  disabled,
}: SendModeFieldProps) {
  const chains = useSendModeChains();
  const { notice, apply, undo } = useEditorNotice(
    "send-mode",
    config,
    onUpdateConfig,
    field.key
  );
  const descriptionId = useId();
  const warningId = useId();
  // Stays mounted after the field hides, so the change is still announced.
  const [announcement, setAnnouncement] = useState("");

  const networkField = networkKeyOf(field);
  // The network the step opened with, to tell whether it changed since.
  const openedNetwork = useRef(config[networkField]);
  const chain = editorChainOf(config[networkField]);
  const mode = editorSendModeOn(config, networkField);
  const option = sendModeOption(mode);
  const warning = sendModeWarning(config);
  const legacyNotice = useLegacyNotice(
    config,
    chain !== undefined && warning === undefined && mode !== SEND_MODE.TRANSACTION
  );
  const offered = availableSendModes(chain).filter(
    (candidate) => !unsupportedSendMode(config.actionType, candidate.value)
  );
  // A mode the chain or step does not offer stays listed, so it can be changed.
  const options = offered.some((candidate) => candidate.value === mode)
    ? offered
    : [...offered, option];
  // Shown while there is something to fix or say, even with only Normal left.
  const hidden =
    options.length < 2 &&
    mode === SEND_MODE.TRANSACTION &&
    !warning &&
    !chains.failed;

  const onChange = (value: string): void => {
    if (isSendMode(value) && pickChanges(config, value)) {
      setAnnouncement("");
      apply(pickSendMode(config, value));
    }
  };
  const chooseNormal = (): void => {
    apply(pickSendMode(config, SEND_MODE.TRANSACTION));
    // The field hides once only Normal is left; Network is next to it.
    const staysShown = offered.length > 1 || chains.failed;
    focusLater(staysShown ? field.key : networkField, () =>
      setAnnouncement("Send as set to Normal transaction.")
    );
  };
  // Writes both keys, in agreement, for the mode the field shows.
  const keepShown = (): void => {
    apply(pickSendMode(config, mode));
    focusLater(field.key, () =>
      setAnnouncement(`Send as set to ${option.shortLabel}.`)
    );
  };
  const warningActions: NoticeAction[] = [
    { label: "Use Normal transaction", onClick: chooseNormal },
  ];
  // Keep only a mode this chain and step offer; keeping another would just fail.
  if (warning?.keys && keepsShownMode(config)) {
    warningActions.push({
      label: `Keep ${option.shortLabel}`,
      onClick: keepShown,
    });
  }
  const dismissLegacyNotice = (): void => {
    legacyNotice.close();
    focusLater(field.key);
  };

  return (
    <div
      className={hidden ? "contents" : "space-y-2"}
      data-testid={hidden ? undefined : "send-mode-field"}
      ref={legacyNotice.ref}
    >
      {!hidden && (
        <>
          <Label className="ml-1" htmlFor={field.key}>
            {field.label}
          </Label>
          <Select disabled={disabled} onValueChange={onChange} value={mode}>
            <SelectTrigger
              aria-describedby={warning ? warningId : descriptionId}
              className="w-full"
              id={field.key}
            >
              <SelectValue>{option.shortLabel}</SelectValue>
            </SelectTrigger>
            <SelectContent className="w-(--radix-select-trigger-width)">
              {options.map((candidate) => (
                <SelectItem
                  description={candidate.description}
                  key={candidate.value}
                  value={candidate.value}
                >
                  {candidate.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {!warning && (
            <p className="ml-1 text-muted-foreground text-xs" id={descriptionId}>
              {option.hint ?? option.description}
            </p>
          )}
        </>
      )}
      <div
        aria-atomic="false"
        aria-live="polite"
        className={hidden ? "sr-only" : "space-y-2"}
        role="status"
      >
        {chains.failed && (
          <EditorChangeNotice
            // Retry only reloads the list, so viewers get it too.
            action={{
              label: "Retry",
              srSuffix: `loading networks for ${field.label}`,
              onClick: () => chains.retry(networkField),
            }}
            testId="send-mode-chains-error"
            text="The network list did not load, so Private relay is not offered."
            tone="warning"
          />
        )}
        {warning && (
          <EditorChangeNotice
            action={disabled ? undefined : warningActions}
            testId={
              warning.unsupported
                ? "send-mode-unsupported-notice"
                : "send-mode-unavailable-notice"
            }
            text={warning.text}
            textId={warningId}
            tone={warning.fails || warning.keys ? "warning" : "info"}
          />
        )}
        {notice && (
          <EditorChangeNotice
            action={disabled ? undefined : { label: "Undo", onClick: undo }}
            testId="send-mode-notice"
            text={notice.text}
          />
        )}
        {legacyNotice.show && (
          <EditorChangeNotice
            onClose={dismissLegacyNotice}
            testId="send-mode-legacy-notice"
            text={legacyRelayNotice(
              chain?.name,
              Object.is(openedNetwork.current, config[networkField])
            )}
          />
        )}
        {announcement && <span className="sr-only">{announcement}</span>}
      </div>
    </div>
  );
}

type SponsorGasSendModeFieldProps = {
  field: ActionConfigFieldBase;
  config: Record<string, unknown>;
  onUpdateConfig: (key: string, value: unknown) => void;
  disabled?: boolean;
  resetOnly: boolean;
};

/**
 * Sponsor gas. Shown off while Send as is not Normal (never written), and
 * turning it on sets Send as back to Normal, with a notice.
 */
export function SponsorGasSendModeField({
  field,
  config,
  onUpdateConfig,
  disabled,
  resetOnly,
}: SponsorGasSendModeFieldProps) {
  useSendModeChains();
  const { notice, apply, undo } = useEditorNotice(
    "sponsor-gas",
    config,
    onUpdateConfig,
    field.key
  );
  const mode = editorSendMode(config);
  const offForSendAs = mode !== SEND_MODE.TRANSACTION;
  const shown = shownSponsorGas(config, field.key);

  return (
    <div className="space-y-2">
      <SponsorGasField
        description={field.helpTip ?? field.helpText}
        disabled={disabled}
        id={field.key}
        label={field.label}
        onChange={(next) => apply(switchSponsorGas(config, next, field.key))}
        resetOnly={resetOnly}
        shownAfterReset={offForSendAs ? false : undefined}
        value={shown}
      />
      {/* Only under a switch that shows off; a stray value shows Reset instead. */}
      {offForSendAs && shown === false && (
        <p
          className="ml-1 text-muted-foreground text-xs"
          data-testid="sponsor-gas-send-as-hint"
        >
          {sponsorOffHint(mode)}
        </p>
      )}
      <div aria-atomic="false" aria-live="polite" role="status">
        {notice && (
          <EditorChangeNotice
            action={disabled ? undefined : { label: "Undo", onClick: undo }}
            testId="sponsor-gas-send-mode-notice"
            text={notice.text}
          />
        )}
      </div>
    </div>
  );
}
