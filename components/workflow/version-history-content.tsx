"use client";

import { useAtomValue } from "jotai";
import {
  ArrowRight,
  Check,
  ChevronRight,
  Clock,
  Copy,
  ExternalLink,
  Eye,
  Link2,
  Minus,
  Pencil,
  Plus,
  Power,
  PowerOff,
  Unlink,
} from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { ActorAvatar, actorLabel } from "@/components/activity/actor-avatar";
import { Pager } from "@/components/activity/pager";
import { relativeTime } from "@/components/settings/session-format";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { api, type WorkflowVersionSummary } from "@/lib/api-client";
import { groupByDate } from "@/lib/activity/time-groups";
import { usePaginatedResource } from "@/lib/hooks/use-paginated-resource";
import { currentWorkflowIdAtom, previewVersionAtom } from "@/lib/workflow/store";
import {
  type ConfigValueResolver,
  type ResolvedValue,
  useConfigValueDisplay,
} from "@/lib/workflow/use-config-value-display";
import { useVersionPreview } from "@/lib/workflow/use-version-preview";
import type { VersionDiff } from "@/lib/workflow/version-diff";
import { findActionById, flattenConfigFields } from "@/plugins/registry";

// Page size for the history list. Shared with the page-of-a-version math so a
// deep link can land on the page that holds its target version.
const WORKFLOW_HISTORY_PAGE_SIZE = 10;

type ChangeKind =
  | "add"
  | "remove"
  | "change"
  | "connect"
  | "disconnect"
  | "enable"
  | "disable";

type ChangeItem = {
  key: string;
  kind: ChangeKind;
  content: ReactNode;
};

function Arrow(): React.ReactElement {
  return (
    <ArrowRight className="inline size-3 shrink-0 text-muted-foreground" />
  );
}

function Quoted({ value }: { value: string }): React.ReactElement {
  return <span className="font-medium">&quot;{value || "untitled"}&quot;</span>;
}

// Map a stored config key to the field label the user sees in the editor
// (e.g. "functionArgs" -> "Function Arguments"); fall back to the raw key.
function configFieldLabel(
  actionType: string | undefined,
  key: string
): string {
  // Reserved keys aren't form fields; give them friendly labels.
  if (key === "actionType") {
    return "Action";
  }
  if (key === "integrationId") {
    return "Integration";
  }
  if (!actionType) {
    return key;
  }
  const action = findActionById(actionType);
  if (!action) {
    return key;
  }
  const field = flattenConfigFields(action.configFields).find(
    (f) => f.key === key
  );
  return field?.label ?? key;
}

function toneChip(tone: "before" | "after"): string {
  return tone === "before"
    ? "bg-destructive/10 text-destructive ring-1 ring-destructive/20"
    : "bg-keeperhub-green-dark/10 text-keeperhub-green-dark ring-1 ring-keeperhub-green-dark/20";
}

// A small copy-to-clipboard button that flips to a check for ~1.2s on success.
// Shared by the address chip and the generic value chip so long, trimmed values
// can be copied in full.
function CopyButton({
  value,
  label,
}: {
  value: string;
  label: string;
}): React.ReactElement {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  };
  return (
    <button
      aria-label={label}
      className="flex h-5 shrink-0 items-center opacity-70 transition-opacity hover:opacity-100"
      onClick={copy}
      type="button"
    >
      {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
    </button>
  );
}

// An EVM address value: checksummed + shortened, with the full address on
// hover, a copy button, and a network-aware explorer link when known.
function AddressChip({
  address,
  label,
  tone,
}: {
  address: { full: string; href: string | null };
  label: string;
  tone: "before" | "after";
}): React.ReactElement {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className={`inline-flex items-center gap-1.5 rounded px-1.5 py-0.5 font-medium text-xs leading-relaxed ${toneChip(
              tone
            )}`}
          >
            {label}
            <CopyButton label="Copy address" value={address.full} />
            {address.href && (
              <a
                aria-label="View on explorer"
                className="opacity-70 transition-opacity hover:opacity-100"
                href={address.href}
                rel="noopener"
                target="_blank"
              >
                <ExternalLink className="size-3" />
              </a>
            )}
          </span>
        </TooltipTrigger>
        <TooltipContent>
          <span className="font-mono text-xs">{address.full}</span>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

// A before/after value chip in a config diff: old values read as removed
// (red), new values as added (green); an absent value is a faint placeholder
// rather than a chip, so it never looks like a disabled control.
function DiffValue({
  resolved,
  tone,
}: {
  resolved: ResolvedValue;
  tone: "before" | "after";
}): React.ReactElement {
  if (resolved.empty) {
    return <span className="text-muted-foreground/60 italic">empty</span>;
  }
  if (resolved.deleted) {
    return (
      <span className="inline-flex items-start gap-1.5 rounded bg-muted px-1.5 py-0.5 leading-relaxed">
        <span className="break-all text-muted-foreground line-through">
          {resolved.label}
        </span>
        <span className="rounded bg-destructive/15 px-1 font-medium text-[10px] text-destructive uppercase">
          deleted
        </span>
        <CopyButton label="Copy value" value={resolved.label} />
      </span>
    );
  }
  if (resolved.address) {
    return (
      <AddressChip
        address={resolved.address}
        label={resolved.label}
        tone={tone}
      />
    );
  }
  return (
    <span
      className={`inline-flex max-w-full items-start gap-1.5 rounded px-1.5 py-0.5 font-medium text-xs leading-relaxed ${toneChip(
        tone
      )}`}
    >
      <span className="whitespace-pre-wrap break-all">{resolved.label}</span>
      <CopyButton label="Copy value" value={resolved.label} />
    </span>
  );
}

function settingItem(s: VersionDiff["settings"][number]): ChangeItem {
  if (s.field === "name") {
    return {
      key: "set-name",
      kind: "change",
      content: (
        <>
          Renamed workflow to <Quoted value={s.after} />
        </>
      ),
    };
  }
  if (s.field === "enabled") {
    const on = s.after === "true";
    return {
      key: "set-enabled",
      kind: on ? "enable" : "disable",
      content: on ? "Workflow enabled" : "Workflow disabled",
    };
  }
  if (s.field === "visibility") {
    return {
      key: "set-visibility",
      kind: "change",
      content: (
        <span className="inline-flex items-center gap-1">
          Visibility: {s.before} <Arrow /> {s.after}
        </span>
      ),
    };
  }
  return {
    key: "set-description",
    kind: "change",
    content: "Description updated",
  };
}

function nodeDeltaItem(
  n: VersionDiff["nodesChanged"][number],
  d: VersionDiff["nodesChanged"][number]["deltas"][number]
): ChangeItem {
  const key = `chg-${n.id}-${d.field}`;
  const who = <Quoted value={n.label} />;
  if (d.field === "name") {
    return {
      key,
      kind: "change",
      content: (
        <span className="inline-flex flex-wrap items-center gap-1">
          Renamed <Quoted value={d.before ?? ""} /> <Arrow />{" "}
          <Quoted value={d.after ?? ""} />
        </span>
      ),
    };
  }
  if (d.field === "type") {
    return {
      key,
      kind: "change",
      content: (
        <span className="inline-flex items-center gap-1">
          {who} type: {d.before} <Arrow /> {d.after}
        </span>
      ),
    };
  }
  if (d.field === "configuration") {
    return {
      key,
      kind: "change",
      content: (
        <>
          {who} configuration changed
          {d.configKeys?.length ? ` (${d.configKeys.join(", ")})` : ""}
        </>
      ),
    };
  }
  if (d.field === "enabled") {
    const on = d.after === "true";
    return {
      key,
      kind: on ? "enable" : "disable",
      content: on ? <>Enabled {who}</> : <>Disabled {who}</>,
    };
  }
  return { key, kind: "change", content: <>{who} description updated</> };
}

// The chain a node's addresses belong to: prefer the captured chainId, else
// read the network/chain field changed in this same version.
function nodeChainId(
  n: VersionDiff["nodesChanged"][number]
): string | undefined {
  if (n.chainId) {
    return n.chainId;
  }
  for (const d of n.deltas) {
    const net = d.configChanges?.find(
      (c) => c.key === "network" || c.key === "chainId" || c.key === "chain"
    );
    if (net?.after && net.after !== "empty") {
      return net.after;
    }
  }
  return;
}

function isVersionDiff(value: unknown): value is VersionDiff {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as VersionDiff).settings) &&
    Array.isArray((value as VersionDiff).nodesAdded)
  );
}

function buildChangeItems(
  diff: VersionDiff,
  resolveValue: ConfigValueResolver
): ChangeItem[] {
  const items: ChangeItem[] = diff.settings.map(settingItem);
  for (const n of diff.nodesAdded) {
    items.push({
      key: `add-${n.id}`,
      kind: "add",
      content: (
        <>
          Added <Quoted value={n.label} />
        </>
      ),
    });
  }
  for (const n of diff.nodesRemoved) {
    items.push({
      key: `rem-${n.id}`,
      kind: "remove",
      content: (
        <>
          Removed <Quoted value={n.label} />
        </>
      ),
    });
  }
  for (const n of diff.nodesChanged) {
    const chain = nodeChainId(n);
    for (const d of n.deltas) {
      // Expand a configuration change into one row per field, showing the
      // actual before -> after value (older versions without per-field detail
      // fall back to the key summary in nodeDeltaItem).
      if (d.field === "configuration" && d.configChanges?.length) {
        for (const c of d.configChanges) {
          items.push({
            key: `cfg-${n.id}-${c.key}`,
            kind: "change",
            content: (
              <span className="flex flex-col gap-1.5">
                <span className="text-muted-foreground">
                  <Quoted value={n.label} />{" "}
                  <span className="px-0.5">·</span>{" "}
                  <span className="font-medium text-foreground">
                    {configFieldLabel(n.actionType, c.key)}
                  </span>
                </span>
                <span className="flex flex-wrap items-center gap-2">
                  <DiffValue
                    resolved={resolveValue(n.actionType, c.key, c.before, chain)}
                    tone="before"
                  />
                  <Arrow />
                  <DiffValue
                    resolved={resolveValue(n.actionType, c.key, c.after, chain)}
                    tone="after"
                  />
                </span>
              </span>
            ),
          });
        }
        continue;
      }
      items.push(nodeDeltaItem(n, d));
    }
  }
  for (const c of diff.connectionsAdded) {
    items.push({
      key: `cadd-${c.from}-${c.to}`,
      kind: "connect",
      content: (
        <span className="inline-flex flex-wrap items-center gap-1">
          Connected <Quoted value={c.from} /> <Arrow /> <Quoted value={c.to} />
        </span>
      ),
    });
  }
  for (const c of diff.connectionsRemoved) {
    items.push({
      key: `crem-${c.from}-${c.to}`,
      kind: "disconnect",
      content: (
        <span className="inline-flex flex-wrap items-center gap-1">
          Disconnected <Quoted value={c.from} /> <Arrow />{" "}
          <Quoted value={c.to} />
        </span>
      ),
    });
  }
  return items;
}

const KIND_STYLE: Record<ChangeKind, { Icon: typeof Plus; color: string }> = {
  add: { Icon: Plus, color: "text-keeperhub-green-dark" },
  remove: { Icon: Minus, color: "text-destructive" },
  change: { Icon: Pencil, color: "text-foreground" },
  connect: { Icon: Link2, color: "text-keeperhub-green-dark" },
  disconnect: { Icon: Unlink, color: "text-destructive" },
  enable: { Icon: Power, color: "text-keeperhub-green-dark" },
  disable: { Icon: PowerOff, color: "text-destructive" },
};

function ChangeRow({ item }: { item: ChangeItem }): React.ReactElement {
  const { Icon, color } = KIND_STYLE[item.kind];
  return (
    <li className="flex items-start gap-2 text-xs">
      <Icon className={`mt-0.5 size-3.5 shrink-0 ${color}`} />
      <span>{item.content}</span>
    </li>
  );
}

// Narrow a version's diff to a single node: node add/remove/config/rename/
// enable match by id. Connections match by endpoint node id when the diff
// carries it, falling back to the current label for diffs recorded before ids
// were stored -- matching by label alone drops a node's connection changes once
// the node has been renamed. Workflow-level settings are dropped -- they aren't
// node-specific. Used by the per-node History tab.
function connectionTouchesNode(
  c: VersionDiff["connectionsAdded"][number],
  nodeId: string,
  nodeLabel: string | null
): boolean {
  if (c.fromId || c.toId) {
    return c.fromId === nodeId || c.toId === nodeId;
  }
  return nodeLabel ? c.from === nodeLabel || c.to === nodeLabel : false;
}

function filterDiffToNode(
  diff: VersionDiff,
  nodeId: string,
  nodeLabel: string | null
): VersionDiff {
  return {
    ...diff,
    settings: [],
    nodesAdded: diff.nodesAdded.filter((n) => n.id === nodeId),
    nodesRemoved: diff.nodesRemoved.filter((n) => n.id === nodeId),
    nodesChanged: diff.nodesChanged.filter((n) => n.id === nodeId),
    connectionsAdded: diff.connectionsAdded.filter((c) =>
      connectionTouchesNode(c, nodeId, nodeLabel)
    ),
    connectionsRemoved: diff.connectionsRemoved.filter((c) =>
      connectionTouchesNode(c, nodeId, nodeLabel)
    ),
  };
}


function VersionRow({
  version,
  isCurrent,
  isPreviewing,
  isTarget,
  onView,
  onCopyLink,
  resolveValue,
  nodeId,
  nodeLabel,
}: {
  version: WorkflowVersionSummary;
  isCurrent: boolean;
  isPreviewing: boolean;
  // The version named by the URL (?version=) -- highlighted, auto-expanded, and
  // scrolled into view so a shared/deep link lands on it.
  isTarget: boolean;
  onView: () => void;
  onCopyLink?: () => void;
  resolveValue: ConfigValueResolver;
  nodeId?: string;
  nodeLabel?: string | null;
}): React.ReactElement {
  // Each row owns its open/closed state. Switching page remounts the rows
  // (keys change), so they naturally collapse.
  const [isExpanded, setIsExpanded] = useState(isTarget);
  const rowRef = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (isTarget) {
      setIsExpanded(true);
      rowRef.current?.scrollIntoView({ block: "nearest" });
    }
  }, [isTarget]);
  // The semantic diff vs the previous version is precomputed and stored, so we
  // can show what each version changed without fetching its snapshot. Versions
  // recorded before this format shipped hold a raw diff and are skipped. When
  // scoped to a node, the diff is narrowed to that node's changes.
  const fullDiff = isVersionDiff(version.change) ? version.change : null;
  const diff =
    fullDiff && nodeId
      ? filterDiffToNode(fullDiff, nodeId, nodeLabel ?? null)
      : fullDiff;
  const items = diff ? buildChangeItems(diff, resolveValue) : [];
  return (
    <li
      className={`rounded-xl transition-colors ${
        isTarget
          ? "bg-muted/40 ring-2 ring-primary/60 ring-inset"
          : isExpanded
            ? "bg-muted/40 ring-1 ring-border/70 ring-inset"
            : "hover:bg-muted/30"
      }`}
      ref={rowRef}
    >
      <button
        className="flex w-full items-start gap-2.5 rounded-xl p-3 text-left"
        onClick={() => setIsExpanded((e) => !e)}
        type="button"
      >
        <ActorAvatar actor={version.changedBy} />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="font-medium text-sm">
              Version {version.version}
            </span>
            {isCurrent && (
              <span className="rounded-full bg-keeperhub-green-dark/15 px-1.5 py-0.5 font-medium text-[10px] text-keeperhub-green-dark">
                Current
              </span>
            )}
          </span>
          <span className="mt-0.5 flex items-center gap-1.5 text-muted-foreground text-xs">
            <span className="truncate">{actorLabel(version.changedBy)}</span>
            <span className="text-muted-foreground/60">·</span>
            <span className="flex shrink-0 items-center gap-1">
              <Clock className="size-3" />
              {relativeTime(version.createdAt)}
            </span>
          </span>
          {/* The displayed name can be renamed, so show the immutable email too
              when it isn't already what's shown as the name. */}
          {version.changedBy?.name && version.changedBy.email && (
            <span className="block truncate text-muted-foreground/70 text-xs">
              {version.changedBy.email}
            </span>
          )}
        </span>
        <ChevronRight
          className={`mt-1 size-4 shrink-0 text-muted-foreground transition-transform ${
            isExpanded ? "rotate-90" : ""
          }`}
        />
      </button>
      {/* Animated reveal (grid 0fr -> 1fr) so the box opens smoothly, like the
          right-side panel slide. */}
      <div
        className={`grid transition-[grid-template-rows] duration-300 ease-out ${
          isExpanded ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
        }`}
      >
        <div className="overflow-hidden">
          <div className="space-y-3 border-border border-t px-4 py-3">
            {items.length > 0 ? (
              <ul className="space-y-2">
                {items.map((item) => (
                  <ChangeRow item={item} key={item.key} />
                ))}
              </ul>
            ) : (
              <p className="text-muted-foreground text-xs">
                {version.previousVersion === null
                  ? "Initial version."
                  : "No tracked changes."}
              </p>
            )}
            {/* Actions are revealed with the row so the collapsed list stays
                clean. The current version is already on the canvas. */}
            <div className="flex flex-wrap items-center gap-2">
              {!isCurrent && (
                <Button
                  disabled={isPreviewing}
                  onClick={onView}
                  size="sm"
                  variant="outline"
                >
                  <Eye className="mr-1.5 size-3.5" />
                  {isPreviewing ? "Viewing on canvas" : "View on canvas"}
                </Button>
              )}
              {onCopyLink && (
                <Button onClick={onCopyLink} size="sm" variant="ghost">
                  <Link2 className="mr-1.5 size-3.5" />
                  Copy link
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>
    </li>
  );
}

/**
 * Workflow version history rendered inside the editor's right-panel "History"
 * tab. `active` mirrors the old open/closed atom: it gates the fetch and, on
 * leaving the tab, drops any on-canvas version preview so the editor returns to
 * the live workflow. The docked-panel chrome (slide/resize/close) is not carried
 * over, but the shareable ?historyPage=/?version= URL sync is: the page and the
 * selected version live in the URL so a link reopens the exact view.
 */
export function VersionHistoryContent({
  active,
  nodeId,
  nodeLabel,
}: {
  active: boolean;
  // When set, the timeline is scoped to a single node: only versions that
  // touched it are shown, each narrowed to that node's changes.
  nodeId?: string;
  nodeLabel?: string | null;
}): React.ReactElement | null {
  const workflowId = useAtomValue(currentWorkflowIdAtom);
  const previewVersion = useAtomValue(previewVersionAtom);
  const { preview, exitPreview } = useVersionPreview();
  const resolveValue = useConfigValueDisplay(active);

  // The workflow-level timeline is URL-driven so the page and the selected
  // version are shareable and survive navigation. The per-node view keeps its
  // own local paging (it is a filtered, in-place sub-view, not a shared link).
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const urlDriven = !nodeId;
  const historyPageParam = searchParams?.get("historyPage");
  const urlPage = Math.max(
    1,
    Number.parseInt(historyPageParam ?? "1", 10) || 1
  );
  // The selected version. "current" is a stable alias for whatever the latest
  // version is, so a shared link to the live version keeps tracking it instead
  // of pinning to a number that later stops being current.
  const versionParamRaw = searchParams?.get("version") ?? null;

  const setUrlParams = useCallback(
    (updates: Record<string, string | null>) => {
      const params = new URLSearchParams(searchParams?.toString() ?? "");
      for (const [key, value] of Object.entries(updates)) {
        if (value === null) {
          params.delete(key);
        } else {
          params.set(key, value);
        }
      }
      router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [router, pathname, searchParams]
  );

  const {
    items: versions,
    meta,
    page,
    setPage,
    loading,
    error,
  } = usePaginatedResource<WorkflowVersionSummary>(
    (p) =>
      api.workflow.getHistory(workflowId ?? "", {
        page: p,
        limit: WORKFLOW_HISTORY_PAGE_SIZE,
        nodeId,
        nodeLabel,
      }),
    `${workflowId}:${nodeId ?? ""}:${nodeLabel ?? ""}`,
    { enabled: active && !!workflowId, refetchIntervalMs: 30_000 }
  );

  useEffect(() => {
    if (error) {
      toast.error("Failed to load version history");
    }
  }, [error]);

  useEffect(() => {
    if (!active) {
      exitPreview().catch(() => {
        // Best-effort: leaving the tab should drop the preview, but a failure
        // here must not break tab switching.
      });
    }
  }, [active, exitPreview]);

  // The URL owns the page in the workflow-level view: mirror ?historyPage= into
  // the fetch.
  useEffect(() => {
    if (urlDriven && page !== urlPage) {
      setPage(urlPage);
    }
  }, [urlDriven, page, urlPage, setPage]);

  // A deep link with ?version= but no explicit ?historyPage= lands on whatever
  // page holds that version (versions are contiguous and listed newest-first,
  // so its offset from the newest gives the page; "current" is always page 1).
  // Runs once per target.
  const pagedForVersionRef = useRef<string | null>(null);
  useEffect(() => {
    if (!(active && urlDriven) || versionParamRaw === null || historyPageParam) {
      return;
    }
    if (pagedForVersionRef.current === versionParamRaw) {
      return;
    }
    let targetPage: number | null = null;
    if (versionParamRaw === "current") {
      targetPage = 1;
    } else if (meta) {
      const v = Number.parseInt(versionParamRaw, 10);
      if (!Number.isNaN(v)) {
        targetPage = Math.max(
          1,
          Math.floor((meta.total - v) / WORKFLOW_HISTORY_PAGE_SIZE) + 1
        );
      }
    }
    if (targetPage === null) {
      return;
    }
    pagedForVersionRef.current = versionParamRaw;
    setUrlParams({ historyPage: String(targetPage) });
  }, [active, urlDriven, versionParamRaw, historyPageParam, meta, setUrlParams]);

  const copyVersionLink = useCallback(
    async (versionValue: string) => {
      const params = new URLSearchParams(searchParams?.toString() ?? "");
      params.set("tab", "history");
      params.set("version", versionValue);
      params.set("historyPage", String(page));
      const url = `${window.location.origin}${pathname}?${params.toString()}`;
      try {
        await navigator.clipboard.writeText(url);
        toast.success("Version link copied");
      } catch {
        toast.error("Failed to copy link");
      }
    },
    [searchParams, pathname, page]
  );

  if (!workflowId) {
    return null;
  }

  // The newest version only ever appears on page 1 (descending order).
  const latestVersion = page === 1 ? versions[0]?.version : undefined;
  // Resolve the highlighted version: "current" tracks the latest version.
  const parsedVersionParam = versionParamRaw
    ? Number.parseInt(versionParamRaw, 10)
    : Number.NaN;
  const targetVersion =
    versionParamRaw === "current"
      ? (latestVersion ?? null)
      : Number.isNaN(parsedVersionParam)
        ? null
        : parsedVersionParam;
  // Node scope is applied by the query, not here: filtering the fetched page
  // dropped every version on it whenever the node's changes lived on another
  // page, and left the pager counting versions it would not show.
  const groups = groupByDate(versions, (v) => v.createdAt);
  const emptyMessage = nodeId
    ? "No changes recorded for this node yet."
    : "No versions recorded yet.";

  return (
    <div>
      <div className="thin-scrollbar overflow-y-auto">
        {loading && (
          <div className="space-y-3 p-1">
            {[0, 1, 2].map((i) => (
              <div className="flex items-center gap-2.5" key={i}>
                <Skeleton className="size-7 rounded-full" />
                <div className="flex-1 space-y-1.5">
                  <Skeleton className="h-3 w-1/2" />
                  <Skeleton className="h-2.5 w-1/3" />
                </div>
              </div>
            ))}
          </div>
        )}
        {!loading && versions.length === 0 && (
          <p className="p-2 text-muted-foreground text-sm">{emptyMessage}</p>
        )}
        {groups.map((group) => (
          <div className="mb-3" key={group.label}>
            <p className="px-2.5 py-1 font-medium text-muted-foreground text-xs uppercase tracking-wide">
              {group.label}
            </p>
            <ul className="space-y-2">
              {group.items.map((v) => (
                <VersionRow
                  isCurrent={v.version === latestVersion}
                  isPreviewing={previewVersion === v.version}
                  isTarget={urlDriven && targetVersion === v.version}
                  key={v.version}
                  nodeId={nodeId}
                  nodeLabel={nodeLabel}
                  onCopyLink={
                    urlDriven
                      ? () => {
                          void copyVersionLink(
                            v.version === latestVersion
                              ? "current"
                              : String(v.version)
                          );
                        }
                      : undefined
                  }
                  onView={() => {
                    if (urlDriven) {
                      setUrlParams({ version: String(v.version) });
                    } else {
                      preview(v.version);
                    }
                  }}
                  resolveValue={resolveValue}
                  version={v}
                />
              ))}
            </ul>
          </div>
        ))}
      </div>
      {meta && (
        <div className="mt-2 border-border border-t pt-2.5">
          <Pager
            meta={meta}
            onPage={(p) => {
              if (urlDriven) {
                setUrlParams({ historyPage: String(p) });
              } else {
                setPage(p);
              }
            }}
            unit="versions"
          />
        </div>
      )}
    </div>
  );
}
