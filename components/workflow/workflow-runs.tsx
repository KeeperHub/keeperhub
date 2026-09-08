"use client";

import { useAtom, useAtomValue, useSetAtom } from "jotai";
import {
  Ban,
  Check,
  ChevronDown,
  ChevronRight,
  Clock,
  Copy,
  ExternalLink,
  GitBranch,
  Loader2,
  Play,
  SkipForward,
  TriangleAlert,
  X,
} from "lucide-react";
import Image from "next/image";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { JSX } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toChecksumAddress } from "@/lib/address-utils";
import { getCustomerRunErrorMessage } from "@/lib/errors/customer-message";
import type { ExecutionErrorType } from "@/lib/errors/execution-error-type";
import type {
  NodeExecutionStatus,
  WorkflowExecutionStatus,
} from "@/lib/errors/execution-status";
import {
  FOR_EACH_GROUP_TYPE,
  buildChildLogsLookup,
  groupLogsByIteration,
  type ChildLogsLookup,
  type IterationGroup,
} from "@/lib/workflow/nodes/for-each/iteration-grouping";
import { api } from "@/lib/api-client";
import {
  OUTPUT_DISPLAY_CONFIGS,
  type OutputDisplayConfig,
} from "@/lib/output-display-configs";
import { cn } from "@/lib/utils";
import { getRelativeTime } from "@/lib/utils/time";
import {
  currentWorkflowIdAtom,
  executionLogsAtom,
  propertiesPanelActiveTabAtom,
  runsRefreshTriggerAtom,
  selectedExecutionIdAtom,
} from "@/lib/workflow/store";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";

type ExecutionLog = {
  id: string;
  nodeId: string;
  nodeName: string;
  nodeType: string;
  status: NodeExecutionStatus;
  startedAt: Date;
  completedAt: Date | null;
  duration: string | null;
  input?: unknown;
  output?: unknown;
  error: string | null;
  iterationIndex: number | null;
  forEachNodeId: string | null;
};

type WorkflowExecution = {
  id: string;
  workflowId: string;
  status: WorkflowExecutionStatus;
  startedAt: Date;
  completedAt: Date | null;
  duration: string | null;
  error: string | null;
  errorType: ExecutionErrorType | null;
  errorCategory: string | null;
  errorCode: string | null;
  // Progress tracking fields
  totalSteps: number | null;
  completedSteps: number | null;
  currentNodeId: string | null;
  currentNodeName: string | null;
  lastSuccessfulNodeId: string | null;
  lastSuccessfulNodeName: string | null;
  executionTrace: string[] | null;
  // The workflow_history version this run executed (resolved server-side from
  // the run's content hash); null when no matching version exists.
  ranVersion: number | null;
};

type WorkflowRunsProps = {
  isActive?: boolean;
  onRefreshRef?: React.MutableRefObject<(() => Promise<void>) | null>;
  onStartRun?: (executionId: string) => void;
};

// Helper to get the output display config for a node type
function getOutputConfig(nodeType: string): OutputDisplayConfig | undefined {
  return OUTPUT_DISPLAY_CONFIGS[nodeType];
}

// Helper to extract the displayable value from output based on config
function getOutputDisplayValue(
  output: unknown,
  config: OutputDisplayConfig
): string | undefined {
  if (typeof output !== "object" || output === null) {
    return;
  }
  const value = (output as Record<string, unknown>)[config.field];
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  return;
}

// Fallback: detect if output is a base64 image (for legacy support)
function isBase64ImageOutput(output: unknown): output is { base64: string } {
  return (
    typeof output === "object" &&
    output !== null &&
    "base64" in output &&
    typeof (output as { base64: unknown }).base64 === "string" &&
    (output as { base64: string }).base64.length > 100 // Base64 images are large
  );
}

// A sponsored on-chain step carries `sponsored: true` in its output (set by the
// web3 step cores when Turnkey's gas station covered the gas).
function isSponsoredOutput(output: unknown): boolean {
  return (
    typeof output === "object" &&
    output !== null &&
    "sponsored" in output &&
    (output as { sponsored?: unknown }).sponsored === true
  );
}

// Helper to convert execution logs to a map by nodeId for the global atom.
// For nodes that appear multiple times (e.g., For Each body nodes),
// this intentionally keeps only the last entry -- used by template
// autocomplete which only needs the most recent output.
function createExecutionLogsMap(logs: ExecutionLog[]): Record<
  string,
  {
    nodeId: string;
    nodeName: string;
    nodeType: string;
    status: NodeExecutionStatus;
    output?: unknown;
  }
> {
  const logsMap: Record<
    string,
    {
      nodeId: string;
      nodeName: string;
      nodeType: string;
      status: NodeExecutionStatus;
      output?: unknown;
    }
  > = {};
  for (const log of logs) {
    logsMap[log.nodeId] = {
      nodeId: log.nodeId,
      nodeName: log.nodeName,
      nodeType: log.nodeType,
      status: log.status,
      output: log.output,
    };
  }
  return logsMap;
}

// Regex for Ethereum addresses (40 hex chars) and tx hashes (64 hex chars)
const ETH_HEX_REGEX = /^0x[a-fA-F0-9]{40,}$/;

// Solana base58 addresses (32-44 chars) and tx signatures (86-88 chars).
// Restricted to those two length bands (a 45-85 char base58 string is neither)
// to narrow false positives; base58 excludes 0/O/I/l so it never collides with
// 0x-prefixed hex. This is only a format gate — the copy/link treatment is
// additionally restricted to values that appear in linkMap (see below), so
// arbitrary base58-shaped strings render as plain text.
const SOLANA_BASE58_REGEX =
  /^(?:[1-9A-HJ-NP-Za-km-z]{32,44}|[1-9A-HJ-NP-Za-km-z]{86,88})$/;

// Helper to check if a string is a URL
function isUrl(str: string): boolean {
  try {
    const url = new URL(str);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

// Inline copy button for use inside JSON output
function InlineCopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      className="ml-1 inline-flex align-middle text-muted-foreground hover:text-foreground"
      onClick={async (e) => {
        e.stopPropagation();
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }}
      title="Copy"
      type="button"
    >
      {copied ? (
        <Check className="h-3 w-3 text-green-600" />
      ) : (
        <Copy className="h-3 w-3" />
      )}
    </button>
  );
}

// Known link field to value field pairings.
// When both fields exist, the link field is hidden from display
// and its URL is shown as an icon next to the value field.
const LINK_FIELD_PAIRS: Record<string, string> = {
  transactionLink: "transactionHash",
  addressLink: "address",
  contractAddressLink: "contractAddress",
  recipientAddressLink: "recipientAddress",
};

// Pre-process output data: strip link fields and build a value-to-URL map
function processDataForDisplay(data: unknown): {
  displayData: unknown;
  linkMap: Map<string, string>;
} {
  const linkMap = new Map<string, string>();

  if (typeof data !== "object" || data === null) {
    return { displayData: data, linkMap };
  }

  const obj = data as Record<string, unknown>;

  // Collect link URLs for paired fields
  for (const [linkField, valueField] of Object.entries(LINK_FIELD_PAIRS)) {
    const linkValue = obj[linkField];
    const fieldValue = obj[valueField];
    if (typeof linkValue === "string" && typeof fieldValue === "string") {
      linkMap.set(fieldValue, linkValue);
    }
  }

  // Build filtered data: always strip known link fields from display
  const filtered: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (key in LINK_FIELD_PAIRS) {
      continue;
    }
    filtered[key] = value;
  }

  return { displayData: filtered, linkMap };
}

// Component to render JSON with clickable links and inline action icons
function JsonWithLinks({ data }: { data: unknown }) {
  const { displayData, linkMap } = processDataForDisplay(data);
  const jsonString = JSON.stringify(displayData, null, 2);

  // Split by quoted strings to preserve structure
  // Capture URLs, hex hashes/addresses (0x + 40+ hex chars), and other quoted strings
  // Uses (?:[^"\\]|\\.)* to correctly skip escaped quotes inside JSON values
  const parts = jsonString.split(
    /("https?:\/\/(?:[^"\\]|\\.)+"|"0x[a-fA-F0-9]{40,}"|"(?:[^"\\]|\\.)*")/g
  );

  return (
    <>
      {parts.map((part, partIndex) => {
        if (part.startsWith('"') && part.endsWith('"')) {
          const innerValue = part.slice(1, -1);

          // URL values: clickable link + copy + external link icons
          if (isUrl(innerValue)) {
            return (
              <span
                className="inline-flex items-center"
                key={`u-${innerValue}`}
              >
                <a
                  className="text-blue-500 underline hover:text-blue-400"
                  href={innerValue}
                  rel="noopener noreferrer"
                  target="_blank"
                >
                  {part}
                </a>
                <InlineCopyButton text={innerValue} />
                <a
                  className="ml-1 inline-flex align-middle text-muted-foreground hover:text-foreground"
                  href={innerValue}
                  rel="noopener noreferrer"
                  target="_blank"
                  title="View on explorer"
                >
                  <ExternalLink className="h-3 w-3" />
                </a>
              </span>
            );
          }

          // Ethereum addresses (40 hex) or tx hashes (64 hex): copy + optional link icons
          if (ETH_HEX_REGEX.test(innerValue)) {
            const looksLikeAddress = innerValue.length === 42;
            const displayValue = looksLikeAddress
              ? toChecksumAddress(innerValue)
              : innerValue;
            const explorerUrl = linkMap.get(innerValue);
            // Truncate: 0x + first 6 hex chars + ... + last 6 hex chars
            const truncated = `${displayValue.slice(0, 8)}...${displayValue.slice(-6)}`;
            return (
              <span
                className="inline-flex items-center"
                key={`h-${innerValue}-${partIndex}`}
              >
                {`"${truncated}"`}
                <InlineCopyButton text={displayValue} />
                {explorerUrl && (
                  <a
                    className="ml-1 inline-flex align-middle text-muted-foreground hover:text-foreground"
                    href={explorerUrl}
                    rel="noopener noreferrer"
                    target="_blank"
                    title="View on explorer"
                  >
                    <ExternalLink className="h-3 w-3" />
                  </a>
                )}
              </span>
            );
          }

          // Solana addresses / tx signatures (base58): copy + explorer link.
          // Only decorate values that appear in linkMap (a known address/tx
          // field), so arbitrary base58-shaped strings render as plain text.
          if (SOLANA_BASE58_REGEX.test(innerValue) && linkMap.has(innerValue)) {
            const explorerUrl = linkMap.get(innerValue);
            const truncated = `${innerValue.slice(0, 6)}...${innerValue.slice(-6)}`;
            return (
              <span
                className="inline-flex items-center"
                key={`s-${innerValue}-${partIndex}`}
              >
                {`"${truncated}"`}
                <InlineCopyButton text={innerValue} />
                {explorerUrl && (
                  <a
                    className="ml-1 inline-flex align-middle text-muted-foreground hover:text-foreground"
                    href={explorerUrl}
                    rel="noopener noreferrer"
                    target="_blank"
                    title="View on explorer"
                  >
                    <ExternalLink className="h-3 w-3" />
                  </a>
                )}
              </span>
            );
          }
        }
        return part;
      })}
    </>
  );
}

// Reusable copy button component
function CopyButton({
  data,
  isError = false,
}: {
  data: unknown;
  isError?: boolean;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      const text = isError ? String(data) : JSON.stringify(data, null, 2);
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (error) {
      console.error("Failed to copy:", error);
    }
  };

  return (
    <Button
      className="h-7 px-2"
      onClick={handleCopy}
      size="sm"
      type="button"
      variant="ghost"
    >
      {copied ? (
        <Check className="h-3 w-3 text-green-600" />
      ) : (
        <Copy className="h-3 w-3" />
      )}
    </Button>
  );
}

// Collapsible section component
function CollapsibleSection({
  title,
  children,
  defaultExpanded = false,
  copyData,
  isError = false,
  externalLink,
}: {
  title: string;
  children: React.ReactNode;
  defaultExpanded?: boolean;
  copyData?: unknown;
  isError?: boolean;
  externalLink?: string;
}) {
  const [isOpen, setIsOpen] = useState(defaultExpanded);

  return (
    <div>
      <div className="mb-2 flex w-full items-center justify-between">
        <button
          className="flex items-center gap-1.5"
          onClick={() => setIsOpen(!isOpen)}
          type="button"
        >
          {isOpen ? (
            <ChevronDown className="h-3 w-3 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-3 w-3 text-muted-foreground" />
          )}
          <span className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
            {title}
          </span>
        </button>
        <div className="flex items-center gap-1">
          {externalLink && (
            <Button asChild className="h-7 px-2" size="sm" variant="ghost">
              <a href={externalLink} rel="noopener noreferrer" target="_blank">
                <ExternalLink className="h-3 w-3" />
              </a>
            </Button>
          )}
          {copyData !== undefined && (
            <CopyButton data={copyData} isError={isError} />
          )}
        </div>
      </div>
      {isOpen && children}
    </div>
  );
}

// Component for rendering output with rich display support
function OutputDisplay({
  output,
  input,
}: {
  output: unknown;
  input?: unknown;
}) {
  // Get actionType from input to look up the output config
  const actionType =
    typeof input === "object" && input !== null
      ? (input as Record<string, unknown>).actionType
      : undefined;
  const config =
    typeof actionType === "string" ? getOutputConfig(actionType) : undefined;
  const displayValue = config
    ? getOutputDisplayValue(output, config)
    : undefined;

  // Check for legacy base64 image
  const isLegacyBase64 = !config && isBase64ImageOutput(output);

  const renderRichResult = () => {
    if (config && displayValue) {
      switch (config.type) {
        case "image": {
          // Handle base64 images by adding data URI prefix if needed
          const imageSrc =
            config.field === "base64" && !displayValue.startsWith("data:")
              ? `data:image/png;base64,${displayValue}`
              : displayValue;
          return (
            <div className="overflow-hidden rounded-lg border bg-muted/50 p-3">
              <Image
                alt="Generated image"
                className="max-h-96 w-auto rounded"
                height={384}
                src={imageSrc}
                unoptimized
                width={384}
              />
            </div>
          );
        }
        case "video":
          return (
            <div className="overflow-hidden rounded-lg border bg-muted/50 p-3">
              <video
                className="max-h-96 w-auto rounded"
                controls
                src={displayValue}
              >
                <track kind="captions" />
              </video>
            </div>
          );
        case "url":
          return (
            <div className="overflow-hidden rounded-lg border bg-muted/50">
              <iframe
                className="h-96 w-full rounded"
                sandbox="allow-scripts allow-same-origin"
                src={displayValue}
                title="Output preview"
              />
            </div>
          );
        default:
          return null;
      }
    }

    // Fallback: legacy base64 image detection
    if (isLegacyBase64) {
      return (
        <div className="overflow-hidden rounded-lg border bg-muted/50 p-3">
          <Image
            alt="AI generated output"
            className="max-h-96 w-auto rounded"
            height={384}
            src={`data:image/png;base64,${(output as { base64: string }).base64}`}
            unoptimized
            width={384}
          />
        </div>
      );
    }

    return null;
  };

  const richResult = renderRichResult();
  const hasRichResult = richResult !== null;

  return (
    <>
      {/* Always show JSON output */}
      <CollapsibleSection copyData={output} title="Output">
        <pre className="overflow-auto rounded-lg border bg-muted/50 p-3 font-mono text-xs leading-relaxed">
          <JsonWithLinks data={output} />
        </pre>
      </CollapsibleSection>

      {/* Show rich result if available */}
      {hasRichResult && (
        <CollapsibleSection
          defaultExpanded
          externalLink={config?.type === "url" ? displayValue : undefined}
          title="Result"
        >
          {richResult}
        </CollapsibleSection>
      )}
    </>
  );
}


// Types and functions (ExecutionLog, IterationGroup, GroupedLogEntry,
// buildIterationGroups, groupLogsByIteration) imported from
// @/lib/workflow/nodes/for-each/iteration-grouping

/** Sum the duration (ms) of all logs in an iteration. */
function computeIterationDuration(
  logs: Array<{ duration: string | null }>
): number {
  let total = 0;
  for (const log of logs) {
    if (log.duration) {
      total += Number.parseInt(log.duration, 10);
    }
  }
  return total;
}

/** Expand/collapse button for a single iteration with duration and error indicator. */
function IterationHeader({
  iterationIndex,
  isExpanded,
  hasError,
  durationMs,
  onToggle,
}: {
  iterationIndex: number;
  isExpanded: boolean;
  hasError: boolean;
  durationMs: number;
  onToggle: () => void;
}) {
  return (
    <button
      className="group flex w-full items-center gap-2 rounded-lg py-1.5 text-left transition-colors hover:bg-muted/50"
      onClick={onToggle}
      type="button"
    >
      {isExpanded ? (
        <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
      ) : (
        <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
      )}
      <span className="font-medium text-muted-foreground text-xs">
        Iteration {iterationIndex + 1}
      </span>
      {hasError && (
        <span className="h-1.5 w-1.5 rounded-full bg-red-500" />
      )}
      {durationMs > 0 && (
        <span className="ml-auto shrink-0 font-mono text-muted-foreground text-xs tabular-nums">
          {durationMs < 1000
            ? `${durationMs}ms`
            : `${(durationMs / 1000).toFixed(2)}s`}
        </span>
      )}
    </button>
  );
}

/**
 * Render a For Each node with its iterations grouped and collapsible.
 */
function ForEachLogGroup({
  forEachLog,
  iterations,
  collectLog,
  lookup,
  expandedLogs,
  onToggleLog,
  getStatusIcon,
  getStatusDotClass,
  isFirst,
  isLast,
}: {
  forEachLog: ExecutionLog;
  iterations: IterationGroup<ExecutionLog>[];
  collectLog: ExecutionLog | null;
  lookup: ChildLogsLookup<ExecutionLog>;
  expandedLogs: Set<string>;
  onToggleLog: (id: string) => void;
  getStatusIcon: (status: string) => JSX.Element;
  getStatusDotClass: (status: string) => string;
  isFirst: boolean;
  isLast: boolean;
}) {
  const [expandedIterations, setExpandedIterations] = useState<Set<number>>(
    new Set()
  );

  const toggleIteration = useCallback((index: number) => {
    setExpandedIterations((prev) => {
      const next = new Set(prev);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return next;
    });
  }, []);

  const hasContent = iterations.length > 0 || collectLog !== null;

  const hasAnyIterationError = iterations.some((iteration) =>
    iteration.logs.some((l) => l.status === "error")
  );
  const displayLog: ExecutionLog =
    hasAnyIterationError && forEachLog.status !== "error"
      ? { ...forEachLog, status: "error" as const }
      : forEachLog;

  const iterationsContent =
    iterations.length > 0 ? (
      <div className="space-y-1">
        {iterations.map((iteration) => {
          const isIterExpanded = expandedIterations.has(iteration.iterationIndex);
          return (
            <div key={iteration.iterationIndex}>
              <IterationHeader
                durationMs={computeIterationDuration(iteration.logs)}
                hasError={iteration.logs.some((l) => l.status === "error")}
                isExpanded={isIterExpanded}
                iterationIndex={iteration.iterationIndex}
                onToggle={() => toggleIteration(iteration.iterationIndex)}
              />
              {isIterExpanded && (
                <div className="ml-4 border-border border-l pl-2">
                  {groupLogsByIteration(iteration.logs, lookup).map(
                    (subEntry, subIdx, subEntries) => {
                      if (subEntry.type === FOR_EACH_GROUP_TYPE) {
                        return (
                          <ForEachLogGroup
                            collectLog={subEntry.collectLog}
                            expandedLogs={expandedLogs}
                            forEachLog={subEntry.forEachLog}
                            getStatusDotClass={getStatusDotClass}
                            getStatusIcon={getStatusIcon}
                            isFirst={subIdx === 0}
                            isLast={subIdx === subEntries.length - 1}
                            iterations={subEntry.iterations}
                            key={subEntry.forEachLog.id}
                            lookup={lookup}
                            onToggleLog={onToggleLog}
                          />
                        );
                      }
                      return (
                        <ExecutionLogEntry
                          getStatusDotClass={getStatusDotClass}
                          getStatusIcon={getStatusIcon}
                          isExpanded={expandedLogs.has(subEntry.log.id)}
                          isFirst={subIdx === 0}
                          isLast={subIdx === subEntries.length - 1}
                          key={subEntry.log.id}
                          log={subEntry.log}
                          onToggle={() => onToggleLog(subEntry.log.id)}
                        />
                      );
                    }
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    ) : null;

  return (
    <div className="relative">
      {collectLog !== null && (
        <div
          className="absolute w-px bg-border"
          style={{ left: "9px", top: "calc(0.5rem + 1.25rem)", bottom: 0 }}
        />
      )}
      <ExecutionLogEntry
        getStatusDotClass={getStatusDotClass}
        getStatusIcon={getStatusIcon}
        isExpanded={expandedLogs.has(forEachLog.id)}
        isFirst={isFirst}
        isLast={isLast && collectLog === null}
        log={displayLog}
        middleContent={iterationsContent}
        onToggle={() => onToggleLog(forEachLog.id)}
      />

      {collectLog && (
        <ExecutionLogEntry
          getStatusDotClass={getStatusDotClass}
          getStatusIcon={getStatusIcon}
          isExpanded={expandedLogs.has(collectLog.id)}
          isFirst={false}
          isLast={isLast}
          log={collectLog}
          onToggle={() => onToggleLog(collectLog.id)}
        />
      )}
    </div>
  );
}
// Human-readable explanation for each run/step status, surfaced as a tooltip
// so a grey or non-success dot isn't ambiguous about why a step is in that state.
function getStatusLabel(status: string): string {
  switch (status) {
    case "success":
      return "Completed successfully";
    case "error":
      return "Failed - expand for the error";
    case "system_error":
      return "System error - a platform issue, expand for details";
    case "running":
      return "Running";
    case "cancelled":
      return "Cancelled before it finished";
    case "skipped":
      return "Skipped - expand for why it did not run";
    default:
      return "Pending - has not run yet";
  }
}

// Component for rendering individual execution log entries
function ExecutionLogEntry({
  log,
  isExpanded,
  onToggle,
  getStatusIcon,
  getStatusDotClass,
  isFirst,
  isLast,
  middleContent,
}: {
  log: ExecutionLog;
  isExpanded: boolean;
  onToggle: () => void;
  getStatusIcon: (status: string) => JSX.Element;
  getStatusDotClass: (status: string) => string;
  isFirst: boolean;
  isLast: boolean;
  middleContent?: React.ReactNode;
}) {
  return (
    <div className="relative flex gap-3" key={log.id}>
      {/* Timeline connector */}
      <div className="-ml-px relative flex flex-col items-center pt-2">
        {!isFirst && (
          <div className="absolute bottom-full h-2 w-px bg-border" />
        )}
        <div
          className={cn(
            "z-10 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-0",
            getStatusDotClass(log.status)
          )}
          title={getStatusLabel(log.status)}
        >
          {getStatusIcon(log.status)}
        </div>
        {!isLast && (
          <div className="absolute top-[calc(0.5rem+1.25rem)] bottom-0 w-px bg-border" />
        )}
      </div>

      {/* Step content */}
      <div className="min-w-0 flex-1">
        <button
          className="group w-full rounded-lg py-2 text-left transition-colors hover:bg-muted/50"
          onClick={onToggle}
          type="button"
        >
          <div className="flex items-center gap-3">
            {/* Step content */}
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                {isExpanded ? (
                  <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                ) : (
                  <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                )}
                <span className="truncate font-medium text-sm transition-colors group-hover:text-foreground">
                  {log.nodeName || log.nodeType}
                </span>
                {isSponsoredOutput(log.output) && (
                  <span className="shrink-0 rounded-full border border-primary/20 bg-primary/10 px-2 py-0.5 font-medium text-primary text-xs">
                    Gas sponsored
                  </span>
                )}
              </div>
            </div>

            {log.duration && (
              <span className="shrink-0 font-mono text-muted-foreground text-xs tabular-nums">
                {Number.parseInt(log.duration, 10) < 1000
                  ? `${log.duration}ms`
                  : `${(Number.parseInt(log.duration, 10) / 1000).toFixed(2)}s`}
              </span>
            )}
          </div>
        </button>

        {isExpanded && (
          <div className="mt-2 mb-2 space-y-3 px-3">
            {log.input !== null && log.input !== undefined && (
              <CollapsibleSection copyData={log.input} title="Input">
                <pre className="overflow-auto rounded-lg border bg-muted/50 p-3 font-mono text-xs leading-relaxed">
                  <JsonWithLinks data={log.input} />
                </pre>
              </CollapsibleSection>
            )}
            {middleContent}
            {log.output !== null && log.output !== undefined && (
              <OutputDisplay input={log.input} output={log.output} />
            )}
            {log.error && (
              <CollapsibleSection
                copyData={log.error}
                defaultExpanded
                isError
                title="Error"
              >
                <pre className="overflow-auto rounded-lg border border-red-500/20 bg-red-500/5 p-3 font-mono text-red-600 text-xs leading-relaxed">
                  {log.error}
                </pre>
              </CollapsibleSection>
            )}
            {!(log.input || log.output || log.error || middleContent) && (
              <div className="rounded-lg border bg-muted/30 py-4 text-center text-muted-foreground text-xs">
                No data recorded
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export function WorkflowRuns({
  isActive = false,
  onRefreshRef,
  onStartRun,
}: WorkflowRunsProps) {
  const [currentWorkflowId] = useAtom(currentWorkflowIdAtom);
  const [selectedExecutionId, setSelectedExecutionId] = useAtom(
    selectedExecutionIdAtom
  );
  const [, setExecutionLogs] = useAtom(executionLogsAtom);
  const runsRefreshTrigger = useAtomValue(runsRefreshTriggerAtom);
  const setActiveTab = useSetAtom(propertiesPanelActiveTabAtom);
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // Open the History tab on the version a run executed, highlighting it there
  // (the History tab reads ?version=N and rings/expands/scrolls to it).
  const openRanVersion = useCallback(
    (version: number) => {
      const params = new URLSearchParams(searchParams?.toString() ?? "");
      params.set("tab", "history");
      params.set("version", String(version));
      router.replace(`${pathname}?${params.toString()}`, { scroll: false });
      setActiveTab("history");
    },
    [router, pathname, searchParams, setActiveTab]
  );
  const [executions, setExecutions] = useState<WorkflowExecution[]>([]);
  const [logs, setLogs] = useState<Record<string, ExecutionLog[]>>({});
  const [expandedRuns, setExpandedRuns] = useState<Set<string>>(new Set());
  const [expandedLogs, setExpandedLogs] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);

  // Track which execution we've already auto-expanded to prevent loops
  const autoExpandedExecutionRef = useRef<string | null>(null);

  // Track terminal executions that have had their final log refresh
  const finalizedExecutionsRef = useRef<Set<string>>(new Set());

  const loadExecutions = useCallback(
    async (showLoading = true) => {
      if (!currentWorkflowId) {
        setLoading(false);
        return;
      }

      try {
        if (showLoading) {
          setLoading(true);
        }
        const data = await api.workflow.getExecutions(currentWorkflowId);
        setExecutions(data as WorkflowExecution[]);
      } catch (error) {
        console.error("Failed to load executions:", error);
        setExecutions([]);
      } finally {
        if (showLoading) {
          setLoading(false);
        }
      }
    },
    [currentWorkflowId]
  );

  // Expose refresh function via ref
  useEffect(() => {
    if (onRefreshRef) {
      onRefreshRef.current = () => loadExecutions(false);
    }
  }, [loadExecutions, onRefreshRef]);

  useEffect(() => {
    loadExecutions();
  }, [loadExecutions]);

  // Immediate refresh when toolbar signals a new execution started
  useEffect(() => {
    if (runsRefreshTrigger > 0) {
      loadExecutions(false);
    }
  }, [runsRefreshTrigger, loadExecutions]);

  // Clear expanded runs when workflow changes to prevent stale state
  useEffect(() => {
    setExpandedRuns(new Set());
    setExpandedLogs(new Set());
  }, []);

  // Helper function to map node IDs to labels
  const mapNodeLabels = useCallback(
    (
      logEntries: Array<{
        id: string;
        executionId: string;
        nodeId: string;
        nodeName: string;
        nodeType: string;
        status: NodeExecutionStatus;
        input: unknown;
        output: unknown;
        error: string | null;
        startedAt: Date;
        completedAt: Date | null;
        duration: string | null;
        iterationIndex?: number | null;
        forEachNodeId?: string | null;
      }>,
      _workflow?: {
        nodes: unknown;
      }
    ): ExecutionLog[] =>
      logEntries.map((log) => ({
        id: log.id,
        nodeId: log.nodeId,
        nodeName: log.nodeName,
        nodeType: log.nodeType,
        status: log.status,
        startedAt: new Date(log.startedAt),
        completedAt: log.completedAt ? new Date(log.completedAt) : null,
        duration: log.duration,
        input: log.input,
        output: log.output,
        error: log.error,
        iterationIndex: log.iterationIndex ?? null,
        forEachNodeId: log.forEachNodeId ?? null,
      })),
    []
  );

  const loadExecutionLogs = useCallback(
    async (executionId: string) => {
      try {
        const data = await api.workflow.getExecutionLogs(executionId);
        const mappedLogs = mapNodeLabels(data.logs, data.execution.workflow);
        setLogs((prev) => ({
          ...prev,
          [executionId]: mappedLogs,
        }));

        // Update global execution logs atom if this is the selected execution
        if (executionId === selectedExecutionId) {
          setExecutionLogs(createExecutionLogsMap(mappedLogs));
        }
      } catch (error) {
        console.error("Failed to load execution logs:", error);
        setLogs((prev) => ({ ...prev, [executionId]: [] }));
      }
    },
    [mapNodeLabels, selectedExecutionId, setExecutionLogs]
  );

  // Notify parent when a new execution starts and auto-expand it
  useEffect(() => {
    if (executions.length === 0) {
      return;
    }

    const latestExecution = executions[0];

    // Check if this is a new running execution that we haven't auto-expanded yet
    if (
      latestExecution.status === "running" &&
      latestExecution.id !== autoExpandedExecutionRef.current
    ) {
      // Mark this execution as auto-expanded
      autoExpandedExecutionRef.current = latestExecution.id;

      // Auto-select the new running execution
      setSelectedExecutionId(latestExecution.id);

      // Auto-expand the run
      setExpandedRuns((prev) => {
        const newExpanded = new Set(prev);
        newExpanded.add(latestExecution.id);
        return newExpanded;
      });

      // Load logs for the new execution
      loadExecutionLogs(latestExecution.id);

      // Notify parent
      if (onStartRun) {
        onStartRun(latestExecution.id);
      }
    }
  }, [executions, setSelectedExecutionId, loadExecutionLogs, onStartRun]);

  // Helper to refresh logs for a single execution
  const refreshExecutionLogs = useCallback(
    async (executionId: string) => {
      try {
        const logsData = await api.workflow.getExecutionLogs(executionId);
        const mappedLogs = mapNodeLabels(
          logsData.logs,
          logsData.execution.workflow
        );
        setLogs((prev) => ({
          ...prev,
          [executionId]: mappedLogs,
        }));

        // Update global execution logs atom if this is the selected execution
        if (executionId === selectedExecutionId) {
          setExecutionLogs(createExecutionLogsMap(mappedLogs));
        }
      } catch (error) {
        console.error(`Failed to refresh logs for ${executionId}:`, error);
      }
    },
    [mapNodeLabels, selectedExecutionId, setExecutionLogs]
  );

  // Poll for new executions when tab is active
  useEffect(() => {
    if (!(isActive && currentWorkflowId)) {
      return;
    }

    const pollExecutions = async () => {
      try {
        const data = await api.workflow.getExecutions(currentWorkflowId);
        setExecutions(data as WorkflowExecution[]);

        // Refresh logs for expanded runs: always for running, once more for newly-terminal
        const terminalStatuses = new Set([
          "cancelled",
          "success",
          "error",
          "system_error",
          "skipped",
        ]);
        const executionMap = new Map(data.map((e) => [e.id, e]));
        for (const executionId of expandedRuns) {
          const execution = executionMap.get(executionId);
          if (!execution) {
            continue;
          }
          const isTerminal = terminalStatuses.has(execution.status);
          const alreadyFinalized =
            finalizedExecutionsRef.current.has(executionId);

          if (!isTerminal) {
            await refreshExecutionLogs(executionId);
          } else if (!alreadyFinalized) {
            // One final refresh to pick up cancel cleanup, then stop
            await refreshExecutionLogs(executionId);
            finalizedExecutionsRef.current.add(executionId);
          }
        }
      } catch (error) {
        console.error("Failed to poll executions:", error);
      }
    };

    const interval = setInterval(pollExecutions, 2000);
    return () => clearInterval(interval);
  }, [isActive, currentWorkflowId, expandedRuns, refreshExecutionLogs]);

  const toggleRun = async (executionId: string) => {
    const newExpanded = new Set(expandedRuns);
    if (newExpanded.has(executionId)) {
      newExpanded.delete(executionId);
    } else {
      newExpanded.add(executionId);
      // Load logs when expanding
      await loadExecutionLogs(executionId);
    }
    setExpandedRuns(newExpanded);
  };

  const selectRun = (executionId: string) => {
    // If already selected, deselect it
    if (selectedExecutionId === executionId) {
      setSelectedExecutionId(null);
      setExecutionLogs({});
      return;
    }

    // Select the run without toggling expansion
    setSelectedExecutionId(executionId);

    // Update global execution logs atom with logs for this execution
    const executionLogEntries = logs[executionId] || [];
    setExecutionLogs(createExecutionLogsMap(executionLogEntries));
  };

  const toggleLog = (logId: string) => {
    const newExpanded = new Set(expandedLogs);
    if (newExpanded.has(logId)) {
      newExpanded.delete(logId);
    } else {
      newExpanded.add(logId);
    }
    setExpandedLogs(newExpanded);
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case "success":
        return <Check className="h-3 w-3 text-white" />;
      case "error":
      case "system_error":
        return <X className="h-3 w-3 text-white" />;
      case "running":
        return <Loader2 className="h-3 w-3 animate-spin text-white" />;
      case "cancelled":
        return <Ban className="h-3 w-3 text-white" />;
      case "skipped":
        return <SkipForward className="h-3 w-3 text-white" />;
      default:
        return <Clock className="h-3 w-3 text-white" />;
    }
  };

  const getStatusDotClass = (status: string) => {
    switch (status) {
      case "success":
        return "bg-green-600";
      case "error":
        return "bg-red-600";
      case "system_error":
        return "bg-amber-600";
      case "running":
        return "bg-blue-600";
      case "cancelled":
        return "bg-orange-500";
      // Neutral: refused before it started, not a failure.
      case "skipped":
        return "bg-muted-foreground";
      default:
        return "bg-muted-foreground";
    }
  };

  const isReady = !loading;

  if (loading) {
    return (
      <div data-ready={String(isReady)} data-testid="workflow-runs" className="flex items-center justify-center py-12">
        <Spinner />
      </div>
    );
  }

  if (executions.length === 0) {
    return (
      <div data-ready={String(isReady)} data-testid="workflow-runs" className="flex flex-col items-center justify-center py-16">
        <div className="mb-3 rounded-lg border border-dashed p-4">
          <Play className="h-6 w-6 text-muted-foreground" />
        </div>
        <div className="font-medium text-foreground text-sm">No runs yet</div>
        <div className="mt-1 text-muted-foreground text-xs">
          Execute your workflow to see runs here
        </div>
      </div>
    );
  }

  return (
    <div data-ready={String(isReady)} data-testid="workflow-runs" className="space-y-3">
      {executions.map((execution, index) => {
        const isExpanded = expandedRuns.has(execution.id);
        const executionLogs = (logs[execution.id] || []).sort((a, b) => {
          // Sort by startedAt to ensure first to last order
          return (
            new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime()
          );
        });
        const runErrorMessage = getCustomerRunErrorMessage(execution);
        // When a step already failed, its own error is shown on that step, so
        // the run-level banner would just duplicate it. Only surface the
        // run-level error when no step carries it (phantom / infra failures).
        const hasFailedStep = executionLogs.some(
          (log) => log.status === "error"
        );
        const showRunError = Boolean(runErrorMessage) && !hasFailedStep;

        return (
          <div
            className="overflow-hidden rounded-lg border bg-card transition-all"
            key={execution.id}
          >
            <div className="flex w-full items-center gap-3 p-4">
              <button
                className="flex size-5 shrink-0 items-center justify-center rounded-full border-0 transition-colors hover:bg-muted"
                onClick={() => toggleRun(execution.id)}
                type="button"
              >
                <div
                  className={cn(
                    "flex size-5 items-center justify-center rounded-full border-0",
                    getStatusDotClass(execution.status)
                  )}
                  title={getStatusLabel(execution.status)}
                >
                  {getStatusIcon(execution.status)}
                </div>
              </button>

              <button
                className="min-w-0 flex-1 text-left transition-colors hover:opacity-80"
                onClick={() => {
                  selectRun(execution.id);
                  toggleRun(execution.id);
                }}
                type="button"
              >
                <div className="mb-1 flex items-center gap-2">
                  <span className="font-semibold text-sm">
                    Run #{executions.length - index}
                  </span>
                </div>
                <div className="flex items-center gap-2 font-mono text-muted-foreground text-xs">
                  <span>{getRelativeTime(execution.startedAt)}</span>
                  {execution.duration && (
                    <>
                      <span>•</span>
                      <span className="tabular-nums">
                        {Number.parseInt(execution.duration, 10) < 1000
                          ? `${execution.duration}ms`
                          : `${(Number.parseInt(execution.duration, 10) / 1000).toFixed(2)}s`}
                      </span>
                    </>
                  )}
                  {executionLogs.length > 0 && (
                    <>
                      <span>•</span>
                      <span>
                        {executionLogs.length}{" "}
                        {executionLogs.length === 1 ? "step" : "steps"}
                      </span>
                    </>
                  )}
                </div>
              </button>

              {execution.ranVersion !== null && (
                <button
                  className="flex shrink-0 items-center gap-1 rounded-full border border-border px-2 py-0.5 font-medium text-muted-foreground text-xs transition-colors hover:bg-muted hover:text-foreground"
                  onClick={() =>
                    openRanVersion(execution.ranVersion as number)
                  }
                  title={`Ran version ${execution.ranVersion} — open in History`}
                  type="button"
                >
                  <GitBranch className="size-3" />v{execution.ranVersion}
                </button>
              )}

              <button
                className="flex shrink-0 items-center justify-center rounded p-1 transition-colors hover:bg-muted"
                onClick={() => toggleRun(execution.id)}
                type="button"
              >
                {isExpanded ? (
                  <ChevronDown className="h-4 w-4 text-muted-foreground" />
                ) : (
                  <ChevronRight className="h-4 w-4 text-muted-foreground" />
                )}
              </button>
            </div>

            {isExpanded && (
              <div className="border-t bg-muted/20">
                {showRunError && (
                  <div className={cn("p-4", executionLogs.length > 0 && "pb-0")}>
                    <Alert
                      className="border-destructive/30 bg-destructive/10"
                      variant="destructive"
                    >
                      <TriangleAlert />
                      <AlertDescription className="flex flex-col items-start gap-1.5">
                        <span>{runErrorMessage}</span>
                        {execution.errorCategory === "billing" && (
                          <a
                            className="inline-flex items-center gap-1 font-medium underline underline-offset-2 hover:opacity-80"
                            href="/billing"
                            rel="noopener noreferrer"
                            target="_blank"
                          >
                            Adjust spending caps
                            <ExternalLink className="h-3 w-3" />
                          </a>
                        )}
                      </AlertDescription>
                    </Alert>
                  </div>
                )}
                {executionLogs.length === 0 ? (
                  showRunError ? null : (
                    <div className="py-8 text-center text-muted-foreground text-xs">
                      No steps recorded
                    </div>
                  )
                ) : (
                  <div className="p-4">
                    {(() => {
                      const lookup = buildChildLogsLookup(executionLogs);
                      const grouped = groupLogsByIteration(executionLogs, lookup);
                      return grouped.map(
                        (entry, entryIndex, entries) => {
                          if (entry.type === FOR_EACH_GROUP_TYPE) {
                            return (
                              <ForEachLogGroup
                                collectLog={entry.collectLog}
                                expandedLogs={expandedLogs}
                                forEachLog={entry.forEachLog}
                                getStatusDotClass={getStatusDotClass}
                                getStatusIcon={getStatusIcon}
                                isFirst={entryIndex === 0}
                                isLast={entryIndex === entries.length - 1}
                                iterations={entry.iterations}
                                key={entry.forEachLog.id}
                                lookup={lookup}
                                onToggleLog={toggleLog}
                              />
                            );
                          }
                          return (
                            <ExecutionLogEntry
                              getStatusDotClass={getStatusDotClass}
                              getStatusIcon={getStatusIcon}
                              isExpanded={expandedLogs.has(entry.log.id)}
                              isFirst={entryIndex === 0}
                              isLast={entryIndex === entries.length - 1}
                              key={entry.log.id}
                              log={entry.log}
                              onToggle={() => toggleLog(entry.log.id)}
                            />
                          );
                        }
                      );
                    })()}
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
