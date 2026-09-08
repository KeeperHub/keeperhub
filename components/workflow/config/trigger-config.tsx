"use client";

import {
  ArrowDownToLine,
  Box,
  Boxes,
  Clock,
  Copy,
  ExternalLink,
  Play,
  Webhook,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
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
import type { ActionConfigField } from "@/plugins/registry";
import { ActionConfigRenderer } from "./action-config-renderer";
import { CronScheduleBuilder } from "./cron-schedule-builder";
import { SchemaBuilder } from "./schema-builder";

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
