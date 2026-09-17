"use client";

import {
  ArrowDownToLine,
  Box,
  Boxes,
  Clock,
  Copy,
  ExternalLink,
  Play,
  ScanSearch,
  Webhook,
} from "lucide-react";
import { parseEther } from "ethers";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { CodeEditor } from "@/components/ui/code-editor";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { TimezoneSelect } from "@/components/ui/timezone-select";
import { parseIntervalSeconds } from "@/lib/cron-utils";
import { parseSchemaFields } from "@/lib/schema-fields";
import {
  isValidTraceSelector,
  parseTraceCallTypes,
  TRACE_CALL_TYPES,
  TRACE_SEED_CHAIN_IDS,
  TRACE_STATUS_OPTIONS,
} from "@/lib/workflow/trace-trigger-config";
import type { ActionConfigField } from "@/plugins/registry";
import { ActionConfigRenderer } from "./action-config-renderer";
import { CronScheduleBuilder } from "./cron-schedule-builder";
import { SchemaBuilder } from "./schema-builder";

// Built once rather than spread inline in the field list: ChainSelectField
// refetches whenever this prop's identity changes, so a new array on every
// render leaves it fetching forever and the picker empty.
const TRACE_NETWORK_IDS: string[] = [...TRACE_SEED_CHAIN_IDS];

type TriggerConfigProps = {
  config: Record<string, unknown>;
  onUpdateConfig: (key: string, value: string) => void;
  disabled: boolean;
  workflowId?: string;
};

export function TriggerConfig({
  config,
  onUpdateConfig,
  disabled,
  workflowId,
}: TriggerConfigProps) {
  const webhookUrl = workflowId
    ? `${typeof window !== "undefined" ? window.location.origin : ""}/api/workflows/${workflowId}/webhook`
    : "";

  const handleConfigValue = (key: string, value: unknown): void => {
    let stringValue: string;
    if (typeof value === "string") {
      stringValue = value;
    } else if (typeof value === "object" && value !== null) {
      stringValue = JSON.stringify(value);
    } else {
      stringValue = String(value);
    }
    onUpdateConfig(key, stringValue);
  };

  const handleCopyWebhookUrl = () => {
    if (webhookUrl) {
      navigator.clipboard.writeText(webhookUrl);
      toast.success("Webhook URL copied to clipboard");
    }
  };

  return (
    <>
      <div className="space-y-2">
        <Label className="ml-1" htmlFor="triggerType">
          Trigger Type
        </Label>
        <Select
          disabled={disabled}
          onValueChange={(value) => onUpdateConfig("triggerType", value)}
          value={(config?.triggerType as string) || "Manual"}
        >
          <SelectTrigger className="w-full" id="triggerType">
            <SelectValue placeholder="Select trigger type" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="Manual">
              <div className="flex items-center gap-2">
                <Play className="h-4 w-4" />
                Manual
              </div>
            </SelectItem>
            <SelectItem value="Schedule">
              <div className="flex items-center gap-2">
                <Clock className="h-4 w-4" />
                Schedule
              </div>
            </SelectItem>
            <SelectItem value="Webhook">
              <div className="flex items-center gap-2">
                <Webhook className="h-4 w-4" />
                Webhook
              </div>
            </SelectItem>
            <SelectItem value="Event">
              <div className="flex items-center gap-2">
                <Boxes className="h-4 w-4" />
                Event
              </div>
            </SelectItem>
            <SelectItem value="Block">
              <div className="flex items-center gap-2">
                <Box className="h-4 w-4" />
                Block
              </div>
            </SelectItem>
            <SelectItem value="Transfer">
              <div className="flex items-center gap-2">
                <ArrowDownToLine className="h-4 w-4" />
                Transfer
              </div>
            </SelectItem>
            <SelectItem value="Trace">
              <div className="flex items-center gap-2">
                <ScanSearch className="h-4 w-4" />
                Trace
              </div>
            </SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Webhook fields */}
      {config?.triggerType === "Webhook" && (
        <>
          <div className="space-y-2">
            <Label className="ml-1">Webhook URL</Label>
            <div className="flex gap-2">
              <Input
                className="font-mono text-xs"
                disabled
                value={webhookUrl || "Save workflow to generate webhook URL"}
              />
              <Button
                disabled={!webhookUrl}
                onClick={handleCopyWebhookUrl}
                size="icon"
                variant="outline"
              >
                <Copy className="h-4 w-4" />
              </Button>
            </div>
          </div>
          <div className="space-y-2">
            <Label>Request Schema (Optional)</Label>
            <SchemaBuilder
              disabled={disabled}
              onChange={(schema) =>
                onUpdateConfig("webhookSchema", JSON.stringify(schema))
              }
              schema={parseSchemaFields(config?.webhookSchema)}
            />
            <p className="text-muted-foreground text-xs">
              Define the expected structure of the incoming webhook payload.
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="webhookMockRequest">Mock Request (Optional)</Label>
            <div className="overflow-hidden rounded-md border">
              <CodeEditor
                defaultLanguage="json"
                height="150px"
                onChange={(value) =>
                  onUpdateConfig("webhookMockRequest", value || "")
                }
                options={{
                  minimap: { enabled: false },
                  lineNumbers: "on",
                  scrollBeyondLastLine: false,
                  fontSize: 12,
                  readOnly: disabled,
                  wordWrap: "on",
                }}
                value={(config?.webhookMockRequest as string) || ""}
              />
            </div>
            <p className="text-muted-foreground text-xs">
              Enter a sample JSON payload to test the webhook trigger.
            </p>
          </div>
        </>
      )}

      {/* Schedule fields */}
      {config?.triggerType === "Schedule" && (
        <>
          <CronScheduleBuilder
            disabled={disabled}
            onChange={(value) => {
              // KEEP-575: schedule builder emits either a cron string or a
              // true interval. Interval mode clears scheduleCron so legacy
              // readers don't fall back to a stale cron value.
              if (value.mode === "interval") {
                onUpdateConfig(
                  "scheduleIntervalSeconds",
                  String(value.intervalSeconds)
                );
                onUpdateConfig("scheduleCron", "");
              } else {
                onUpdateConfig("scheduleCron", value.cron);
                onUpdateConfig("scheduleIntervalSeconds", "");
              }
            }}
            value={{
              cron: (config?.scheduleCron as string) || "",
              intervalSeconds: parseIntervalSeconds(
                config?.scheduleIntervalSeconds
              ),
            }}
          />
          <div className="space-y-2">
            <Label className="ml-1" htmlFor="scheduleTimezone">
              Timezone
            </Label>
            <TimezoneSelect
              disabled={disabled}
              id="scheduleTimezone"
              onValueChange={(value) =>
                onUpdateConfig("scheduleTimezone", value)
              }
              value={(config?.scheduleTimezone as string) || "America/New_York"}
            />
          </div>
        </>
      )}

      {/* Event fields */}
      {config?.triggerType === "Event" && (
        <EventTriggerFields
          config={config}
          disabled={disabled}
          onUpdateConfig={handleConfigValue}
        />
      )}
      {/* Block fields */}
      {config?.triggerType === "Block" &&
        (() => {
          const blockFields: ActionConfigField[] = [
            {
              key: "network",
              label: "Network",
              type: "chain-select",
              chainTypeFilter: ["evm", "solana"],
              placeholder: "Select network",
              required: true,
            },
          ];

          return (
            <>
              <ActionConfigRenderer
                config={config}
                disabled={disabled}
                fields={blockFields}
                onUpdateConfig={handleConfigValue}
              />
              <div className="space-y-2">
                <Label className="ml-1" htmlFor="blockInterval">
                  Block Interval <span className="text-red-500">*</span>
                </Label>
                <Input
                  disabled={disabled}
                  id="blockInterval"
                  min={1}
                  onChange={(e) => {
                    const parsed = Number.parseInt(e.target.value, 10);
                    if (e.target.value === "") {
                      onUpdateConfig("blockInterval", "");
                      return;
                    }
                    if (Number.isNaN(parsed) || parsed < 1) {
                      return;
                    }
                    onUpdateConfig("blockInterval", String(parsed));
                  }}
                  placeholder="1 = every block, 10 = every 10th block"
                  type="number"
                  value={(config?.blockInterval as string) || ""}
                />
                <p className="text-muted-foreground text-xs">
                  Fire the workflow every N blocks on the selected network.
                </p>
              </div>
            </>
          );
        })()}
      {/* Transfer fields */}
      {config?.triggerType === "Transfer" && (
        <TransferTriggerFields
          config={config}
          disabled={disabled}
          onUpdateConfig={handleConfigValue}
        />
      )}
      {/* Trace fields */}
      {config?.triggerType === "Trace" && (
        <TraceTriggerFields
          config={config}
          disabled={disabled}
          onUpdateConfig={handleConfigValue}
        />
      )}
    </>
  );
}

type TraceTriggerFieldsProps = {
  config: Record<string, unknown>;
  disabled: boolean;
  onUpdateConfig: (key: string, value: unknown) => void;
};

/** Native-unit amount to a decimal wei string, or null when it does not parse. */
function toWeiString(amount: string): string | null {
  try {
    const wei = parseEther(amount.trim());
    return wei < BigInt(0) ? null : wei.toString();
  } catch {
    return null;
  }
}

// Trace trigger config. Fires once per call frame on the watched contract that
// matches the filter, read from block call traces rather than event logs, so
// it sees reverted calls, internal transfers and unlogged function calls.
function TraceTriggerFields({
  config,
  disabled,
  onUpdateConfig,
}: TraceTriggerFieldsProps): React.ReactElement {
  const selectedCallTypes = useMemo(() => {
    const parsed = parseTraceCallTypes(config.traceCallTypes);
    // Upper-cased for display too: a config written through the API may hold
    // ["call"], which the tracker accepts, and the boxes have to show it as
    // checked or the first toggle silently overwrites the stored filter.
    return Array.isArray(parsed)
      ? parsed
          .filter((type): type is string => typeof type === "string")
          .map((type) => type.trim().toUpperCase())
      : [];
  }, [config.traceCallTypes]);

  // `defaultValue` on the select is display-only: the renderer shows it and
  // never writes it back, so a user who never opens the dropdown saves a
  // config with no traceStatus at all. Persisting it on first render keeps
  // what the panel shows and what the tracker receives in step, rather than
  // relying on both sides defaulting to the same value.
  //
  // Skipped when the panel is read-only: a viewer who cannot edit must not
  // dirty the canvas and trigger an autosave the server will refuse.
  useEffect(() => {
    if (disabled) {
      return;
    }
    if (config.traceStatus === undefined || config.traceStatus === "") {
      onUpdateConfig("traceStatus", "success");
    }
  }, [config.traceStatus, disabled, onUpdateConfig]);

  const selector = (config.traceSelector as string) || "";
  const selectorInvalid = !isValidTraceSelector(selector);
  const minValue = (config.traceMinValue as string) || "";
  const minValueInvalid = minValue.trim() !== "" && toWeiString(minValue) === null;

  const targetFields: ActionConfigField[] = [
    {
      key: "network",
      label: "Network",
      type: "chain-select",
      chainTypeFilter: "evm",
      // The networks whose RPC endpoints are known to serve the block call
      // traces this trigger reads. A trigger offered on a network that does
      // not serve them never fires and reports nothing, which is the worst
      // failure a trigger can have, so the list is a floor rather than every
      // EVM chain.
      //
      // Stated here rather than derived from what the tracker can actually
      // do: the tracker learns a capability per connection, relearns it on
      // reconnect and runs a single replica, so a derived list would be empty
      // after every restart until a drain runs. When capability reporting
      // exists it unions with this seed instead of replacing it.
      allowedChainIds: TRACE_NETWORK_IDS,
      placeholder: "Select network",
      required: true,
    },
    {
      key: "contractAddress",
      label: "Watched Contract",
      type: "template-input",
      placeholder: "0x... calls made to this contract are matched",
      required: true,
      isAddressField: true,
    },
    {
      key: "traceStatus",
      label: "Call Outcome",
      type: "select",
      defaultValue: "success",
      options: TRACE_STATUS_OPTIONS.map((option) => ({ ...option })),
      helpTip:
        "Reverted calls are the signal events cannot give you: a failed drain or a rejected privileged call emits no log.",
    },
  ];

  const functionFields: ActionConfigField[] = [
    {
      key: "contractABI",
      label: "Contract ABI (Optional)",
      type: "abi-with-auto-fetch",
      contractAddressField: "contractAddress",
      networkField: "network",
      rows: 4,
    },
    {
      key: "abiFunction",
      label: "Function (Optional)",
      type: "abi-function-select",
      abiField: "contractABI",
      // State-changing functions are what a trace trigger watches for: a
      // withdrawal, a pause, an ownership change. A view function can still be
      // matched by its raw selector below.
      functionFilter: "write",
      placeholder: "Any function",
    },
  ];

  const selectorFields: ActionConfigField[] = [
    {
      key: "traceCaller",
      label: "Caller (Optional)",
      type: "template-input",
      placeholder: "0x... only match calls from this address",
      isAddressField: true,
    },
  ];

  function toggleCallType(type: string, checked: boolean): void {
    const next = checked
      ? [...selectedCallTypes, type]
      : selectedCallTypes.filter((selected) => selected !== type);
    onUpdateConfig("traceCallTypes", next);
  }

  function handleMinValueChange(value: string): void {
    onUpdateConfig("traceMinValue", value);
    if (value.trim() === "") {
      onUpdateConfig("traceMinValueWei", "");
      return;
    }
    const wei = toWeiString(value);
    // Clearing on a parse failure matters as much as setting on success.
    // traceMinValueWei is what registers; traceMinValue is only what the box
    // shows. Leaving a stale wei value behind after the text stops parsing
    // means the panel reads "0.5x" while the trigger still filters at 0.5,
    // and nothing blocks saving it.
    onUpdateConfig("traceMinValueWei", wei ?? "");
  }

  return (
    <>
      <ActionConfigRenderer
        config={config}
        disabled={disabled}
        fields={targetFields}
        onUpdateConfig={onUpdateConfig}
      />
      <ActionConfigRenderer
        config={config}
        disabled={disabled}
        fields={functionFields}
        onUpdateConfig={onUpdateConfig}
      />
      {typeof config.abiFunction === "string" && config.abiFunction !== "" && (
        <Button
          className="-mt-2 h-auto px-1 py-0 text-xs"
          disabled={disabled}
          onClick={() => onUpdateConfig("abiFunction", "")}
          type="button"
          variant="link"
        >
          Match any function
        </Button>
      )}
      <ActionConfigRenderer
        config={config}
        disabled={disabled}
        fields={selectorFields}
        onUpdateConfig={onUpdateConfig}
      />
      <div className="space-y-2">
        <Label className="ml-1">Call Types (Optional)</Label>
        <div className="grid grid-cols-2 gap-2">
          {TRACE_CALL_TYPES.map((type) => (
            <div className="flex items-center gap-2" key={type}>
              <Checkbox
                checked={selectedCallTypes.includes(type)}
                disabled={disabled}
                id={`trace-call-type-${type}`}
                onCheckedChange={(checked) =>
                  toggleCallType(type, checked === true)
                }
              />
              <Label
                className="font-mono text-xs"
                htmlFor={`trace-call-type-${type}`}
              >
                {type}
              </Label>
            </div>
          ))}
        </div>
        <p className="text-muted-foreground text-xs">
          Leave all unchecked to match every call type.
        </p>
      </div>
      <div className="space-y-2">
        <Label className="ml-1" htmlFor="traceSelector">
          Function Selector (Optional)
        </Label>
        <Input
          aria-invalid={selectorInvalid}
          disabled={disabled}
          id="traceSelector"
          onChange={(e) => onUpdateConfig("traceSelector", e.target.value)}
          placeholder="0x8456cb59"
          value={selector}
        />
        <p className="text-muted-foreground text-xs">
          {selectorInvalid
            ? "A selector is 0x followed by exactly 8 hex characters, for example 0x8456cb59. A value in any other shape matches nothing, so the trigger would register and never fire."
            : "A raw 4-byte selector, which is what narrows the trigger to one function. Choosing a function above does not fill this in yet, so without a selector every function matches."}
        </p>
      </div>
      <div className="space-y-2">
        <Label className="ml-1" htmlFor="traceMinValue">
          Minimum Value (Optional)
        </Label>
        <Input
          aria-invalid={minValueInvalid}
          disabled={disabled}
          id="traceMinValue"
          inputMode="decimal"
          onChange={(e) => handleMinValueChange(e.target.value)}
          placeholder="0.5"
          value={minValue}
        />
        <p className="text-muted-foreground text-xs">
          {minValueInvalid
            ? "Enter a non-negative amount in the network's native token."
            : "Only match calls moving at least this much of the network's native token."}
        </p>
      </div>
      <p className="text-muted-foreground text-xs">
        Trace triggers read block call traces, so the networks listed are the
        ones whose RPC endpoints serve them.
      </p>
    </>
  );
}

const CUSTOM_TOKEN_VALUE = "__custom__";

type TempoStablecoin = {
  tokenAddress: string;
  symbol: string;
  name: string;
  decimals: number;
  isStablecoin: boolean;
  explorerUrl?: string | null;
};

function shortenAddress(address: string): string {
  return address.length > 12
    ? `${address.slice(0, 6)}...${address.slice(-4)}`
    : address;
}

type TransferTriggerFieldsProps = {
  config: Record<string, unknown>;
  disabled: boolean;
  onUpdateConfig: (key: string, value: unknown) => void;
};

// Tempo "Transfer" trigger config. The token watched for payments is a fixed
// on-chain stablecoin, so it renders as a dropdown of the network's supported
// stablecoins (from supported_tokens) instead of the wallet address book, with
// a custom-address escape hatch for tokens not yet in the registry.
function TransferTriggerFields({
  config,
  disabled,
  onUpdateConfig,
}: TransferTriggerFieldsProps): React.ReactElement {
  const network = (config.network as string) || "";
  const contractAddress = (config.contractAddress as string) || "";
  const [tokens, setTokens] = useState<TempoStablecoin[]>([]);
  const [customMode, setCustomMode] = useState(false);

  useEffect(() => {
    if (!network) {
      setTokens([]);
      return;
    }
    let cancelled = false;
    fetch(`/api/supported-tokens?chainId=${encodeURIComponent(network)}`)
      .then((res) => res.json())
      .then((data: { tokens?: TempoStablecoin[] }) => {
        if (!cancelled) {
          setTokens((data.tokens ?? []).filter((t) => t.isStablecoin));
        }
      })
      .catch(() => {
        if (!cancelled) {
          setTokens([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [network]);

  // A stored token that isn't one of the network's known stablecoins is treated
  // as a custom address, so reopening the config keeps the input visible.
  useEffect(() => {
    if (contractAddress && tokens.length > 0) {
      const known = tokens.some(
        (t) => t.tokenAddress.toLowerCase() === contractAddress.toLowerCase()
      );
      if (!known) {
        setCustomMode(true);
      }
    }
  }, [contractAddress, tokens]);

  const matched = tokens.find(
    (t) => t.tokenAddress.toLowerCase() === contractAddress.toLowerCase()
  );
  const selectValue = customMode
    ? CUSTOM_TOKEN_VALUE
    : (matched?.tokenAddress ?? "");

  function handleTokenChange(value: string): void {
    if (value === CUSTOM_TOKEN_VALUE) {
      setCustomMode(true);
      onUpdateConfig("contractAddress", "");
      return;
    }
    setCustomMode(false);
    onUpdateConfig("contractAddress", value);
  }

  const networkField: ActionConfigField[] = [
    {
      key: "network",
      label: "Network",
      type: "chain-select",
      chainTypeFilter: "evm",
      allowedChainIds: ["4217", "42431"],
      placeholder: "Select a Tempo network",
      required: true,
    },
  ];
  const trailingFields: ActionConfigField[] = [
    {
      key: "recipientAddress",
      label: "Deposit Address",
      type: "template-input",
      placeholder: "0x... the address that receives payments",
      required: true,
    },
    {
      key: "memo",
      label: "Memo Filter",
      type: "template-input",
      placeholder: "INV-1042 or 0x... (optional)",
      helpTip:
        "Only fire when the transfer memo matches. A 0x + 64-hex value matches exactly; a shorter string matches as a prefix.",
    },
  ];

  return (
    <>
      <ActionConfigRenderer
        config={config}
        disabled={disabled}
        fields={networkField}
        onUpdateConfig={onUpdateConfig}
      />
      <div className="space-y-2">
        <Label className="ml-1">
          Stablecoin Token <span className="text-red-500">*</span>
        </Label>
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <Select
              disabled={disabled || !network}
              onValueChange={handleTokenChange}
              value={selectValue}
            >
              <SelectTrigger className="w-full">
                <SelectValue
                  placeholder={
                    network ? "Select a stablecoin" : "Select a network first"
                  }
                />
              </SelectTrigger>
              <SelectContent>
                {tokens.map((t) => (
                  <SelectItem key={t.tokenAddress} value={t.tokenAddress}>
                    <span className="flex items-center gap-2">
                      <span>{t.symbol}</span>
                      <span className="font-mono text-muted-foreground text-xs">
                        {shortenAddress(t.tokenAddress)}
                      </span>
                    </span>
                  </SelectItem>
                ))}
                <SelectItem value={CUSTOM_TOKEN_VALUE}>
                  Custom address...
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
          {matched && !customMode && (
            <>
              <button
                aria-label="Copy token address"
                className="rounded p-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                onClick={() => {
                  navigator.clipboard.writeText(matched.tokenAddress);
                  toast.success("Token address copied");
                }}
                title="Copy token address"
                type="button"
              >
                <Copy className="size-4" />
              </button>
              {matched.explorerUrl && (
                <a
                  aria-label="View token on explorer"
                  className="rounded p-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  href={matched.explorerUrl}
                  rel="noopener"
                  target="_blank"
                  title="View token on explorer"
                >
                  <ExternalLink className="size-4" />
                </a>
              )}
            </>
          )}
        </div>
        {customMode && (
          <Input
            disabled={disabled}
            onChange={(e) => onUpdateConfig("contractAddress", e.target.value)}
            placeholder="0x... custom TIP-20 token contract"
            value={contractAddress}
          />
        )}
      </div>
      <ActionConfigRenderer
        config={config}
        disabled={disabled}
        fields={trailingFields}
        onUpdateConfig={onUpdateConfig}
      />
    </>
  );
}

type EventTriggerFieldsProps = {
  config: Record<string, unknown>;
  disabled: boolean;
  onUpdateConfig: (key: string, value: unknown) => void;
};

function EventTriggerFields({
  config,
  disabled,
  onUpdateConfig,
}: EventTriggerFieldsProps): React.ReactElement {
  const [chainTypes, setChainTypes] = useState<Record<string, string>>({});

  useEffect(() => {
    fetch("/api/chains")
      .then((res) => res.json())
      .then((data: { chainId: number; chainType: string }[]) => {
        const map: Record<string, string> = {};
        for (const chain of data) {
          map[String(chain.chainId)] = chain.chainType;
        }
        setChainTypes(map);
      })
      .catch(() => {
        // Fall back to EVM rendering if chains can't be fetched.
      });
  }, []);

  const selectedNetwork = (config.network as string) || "";
  const isSolanaNetwork = chainTypes[selectedNetwork] === "solana";

  const networkField: ActionConfigField[] = [
    {
      key: "network",
      label: "Network",
      type: "chain-select",
      chainTypeFilter: ["evm", "solana"],
      placeholder: "Select network",
      required: true,
    },
  ];

  // EVM contract-event fields (address + ABI + event). Shown when the selected
  // network is EVM; a Solana network swaps in SolanaEventFields below.
  const evmContractFields: ActionConfigField[] = [
    {
      key: "contractAddress",
      label: "Contract Address",
      type: "template-input",
      placeholder: "0x... or {{NodeName.contractAddress}}",
      example: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
      required: true,
    },
    {
      key: "contractABI",
      label: "Contract ABI",
      type: "abi-with-auto-fetch",
      contractAddressField: "contractAddress",
      networkField: "network",
      rows: 6,
      required: true,
    },
    {
      key: "eventName",
      label: "Event Name",
      type: "abi-event-select",
      abiField: "contractABI",
      placeholder: "Select an event",
      required: true,
    },
  ];

  return (
    <>
      <ActionConfigRenderer
        config={config}
        disabled={disabled}
        fields={networkField}
        onUpdateConfig={onUpdateConfig}
      />
      {isSolanaNetwork ? (
        <SolanaEventFields
          config={config}
          disabled={disabled}
          onUpdateConfig={onUpdateConfig}
        />
      ) : (
        <ActionConfigRenderer
          config={config}
          disabled={disabled}
          fields={evmContractFields}
          onUpdateConfig={onUpdateConfig}
        />
      )}
    </>
  );
}

// Solana event-trigger config. A Solana event fires on a decoded Anchor event,
// so programId + IDL + eventName are all required - eventName filters to a
// single event rather than firing on every program transaction.
function SolanaEventFields({
  config,
  disabled,
  onUpdateConfig,
}: EventTriggerFieldsProps): React.ReactElement {
  const programId = (config.programId as string) || "";
  const idl = (config.idl as string) || "";
  const eventName = (config.eventName as string) || "";

  const idlEventNames = useMemo(() => {
    if (!idl.trim()) {
      return [];
    }
    try {
      const parsed = JSON.parse(idl) as { events?: { name?: string }[] };
      return (parsed.events ?? [])
        .map((event) => event.name)
        .filter((name): name is string => Boolean(name));
    } catch {
      return [];
    }
  }, [idl]);

  return (
    <>
      <div className="space-y-2">
        <Label className="ml-1" htmlFor="solana-program-id">
          Program ID <span className="text-red-500">*</span>
        </Label>
        <Input
          disabled={disabled}
          id="solana-program-id"
          onChange={(e) => onUpdateConfig("programId", e.target.value)}
          placeholder="Base58 program address"
          value={programId}
        />
        <p className="text-muted-foreground text-xs">
          The Solana program whose events trigger the workflow.
        </p>
      </div>

      <div className="space-y-2">
        <Label className="ml-1" htmlFor="solana-idl">
          Anchor IDL <span className="text-red-500">*</span>
        </Label>
        <Textarea
          className="font-mono text-xs"
          disabled={disabled}
          id="solana-idl"
          onChange={(e) => onUpdateConfig("idl", e.target.value)}
          placeholder='{ "events": [ { "name": "..." } ], ... }'
          rows={6}
          value={idl}
        />
        <p className="text-muted-foreground text-xs">
          Paste the program's Anchor IDL JSON so events can be decoded and the
          event name can be matched.
        </p>
      </div>

      <div className="space-y-2">
        <Label className="ml-1" htmlFor="solana-event-name">
          Event Name <span className="text-red-500">*</span>
        </Label>
        {idlEventNames.length > 0 ? (
          <Select
            disabled={disabled}
            onValueChange={(value) => onUpdateConfig("eventName", value)}
            value={eventName}
          >
            <SelectTrigger className="w-full" id="solana-event-name">
              <SelectValue placeholder="Select an event" />
            </SelectTrigger>
            <SelectContent>
              {idlEventNames.map((name) => (
                <SelectItem key={name} value={name}>
                  {name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <Input
            disabled={disabled}
            id="solana-event-name"
            onChange={(e) => onUpdateConfig("eventName", e.target.value)}
            placeholder="Add a valid IDL above to pick an event"
            value={eventName}
          />
        )}
        <p className="text-muted-foreground text-xs">
          Required - the workflow fires only on this event, not on every program
          transaction.
        </p>
      </div>
    </>
  );
}
