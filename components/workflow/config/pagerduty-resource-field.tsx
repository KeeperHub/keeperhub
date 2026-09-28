"use client";

import {
  AlertTriangle,
  ExternalLink,
  Info,
  KeyRound,
  Loader2,
  RefreshCw,
  Send,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth-client";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { pagerDutyServiceUrl } from "@/plugins/pagerduty/event-payload";
import {
  type PagerDutyNodeTestReadiness,
  pagerDutyNodeTestReadiness,
} from "@/plugins/pagerduty/node-test-readiness";
import type {
  PagerDutyEscalationPolicy,
  PagerDutyPriority,
  PagerDutyService,
} from "@/plugins/pagerduty/steps/pagerduty-core";

type Resource = "services" | "escalation-policies" | "priorities";

type LoadState<T> = {
  items: T[];
  loading: boolean;
  /** A message from PagerDuty or the route, shown instead of the list. */
  error: string | null;
  /** The account these came from, e.g. "acme" for acme.pagerduty.com. */
  accountSubdomain?: string;
  /** Whether that account is in the EU service region, when it could be told. */
  euRegion?: boolean;
  /** True when the account holds more than the route paged through. */
  truncated?: boolean;
};

/**
 * Lists a PagerDuty connection's services or escalation policies.
 *
 * Names are never stored on the node: only the id is, so a service renamed in
 * PagerDuty keeps paging the same rota and simply shows its new name here.
 * The flip side is that a deleted object cannot be resolved to a name, which
 * is exactly the case the warning below exists for.
 */
function usePagerDutyResources<T>(
  integrationId: string | undefined,
  resource: Resource,
  pick: (body: {
    services?: PagerDutyService[];
    escalationPolicies?: PagerDutyEscalationPolicy[];
    priorities?: PagerDutyPriority[];
    accountSubdomain?: string;
    euRegion?: boolean;
    truncated?: boolean;
  }) => T[]
): LoadState<T> & { reload: () => void } {
  const [state, setState] = useState<LoadState<T>>({
    items: [],
    loading: false,
    error: null,
  });
  const [nonce, setNonce] = useState(0);

  const reload = useCallback(() => setNonce((value) => value + 1), []);

  useEffect(() => {
    if (!integrationId) {
      setState({ items: [], loading: false, error: null });
      return;
    }

    let cancelled = false;
    setState({ items: [], loading: true, error: null });

    fetch(
      `/api/integrations/${encodeURIComponent(integrationId)}/pagerduty/resources?resource=${resource}`
    )
      .then(async (response) => {
        const body = await response.json().catch(() => ({}));
        if (cancelled) {
          return;
        }
        if (!response.ok) {
          setState({
            items: [],
            loading: false,
            error:
              typeof body?.error === "string"
                ? body.error
                : `PagerDuty could not be reached (HTTP ${response.status}).`,
          });
          return;
        }
        setState({
          items: pick(body),
          loading: false,
          error: null,
          accountSubdomain:
            typeof body?.accountSubdomain === "string"
              ? body.accountSubdomain
              : undefined,
          euRegion:
            typeof body?.euRegion === "boolean" ? body.euRegion : undefined,
          truncated: body?.truncated === true,
        });
      })
      .catch((error: unknown) => {
        if (cancelled) {
          return;
        }
        // A fetch that rejects never reached KeeperHub, so this says nothing
        // about PagerDuty or the credentials. Saying "could not load services"
        // here would send someone looking at the wrong thing, and the stored
        // service id is deliberately left alone: see `missing` below, which
        // only warns when the list actually loaded.
        setState({
          items: [],
          loading: false,
          error:
            typeof navigator !== "undefined" && navigator.onLine === false
              ? "You are offline, so the service list could not be loaded. What is already configured on this node is untouched."
              : `Could not reach KeeperHub to load the service list${error instanceof Error ? ` (${error.message})` : ""}. Nothing configured on this node has changed.`,
        });
      });

    return () => {
      cancelled = true;
    };
  }, [integrationId, resource, pick, nonce]);

  return { ...state, reload };
}

function Notice({
  tone,
  children,
}: {
  tone: "info" | "warning";
  children: React.ReactNode;
}) {
  const Icon = tone === "warning" ? AlertTriangle : Info;
  return (
    <div
      className={`flex items-start gap-2 rounded-md border p-2 text-xs ${
        tone === "warning"
          ? "border-yellow-500/40 bg-yellow-500/10 text-yellow-700 dark:text-yellow-300"
          : "border-border bg-muted/30 text-muted-foreground"
      }`}
    >
      <Icon className="mt-0.5 size-3.5 shrink-0" />
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/**
 * Opens the object in PagerDuty. On a service the picker can no longer
 * account for this is a diagnostic rather than a convenience: the warning
 * names two causes, and they look identical from here. A 404 means it really
 * was deleted; a service that loads means the credential simply cannot see
 * it - a scoped OAuth app without access to it, or a connection pointing at a
 * different account than somebody thinks.
 */
function OpenInPagerDutyButton({ href }: { href: string }) {
  return (
    <Button asChild size="sm" variant="ghost">
      <a href={href} rel="noopener noreferrer" target="_blank">
        <ExternalLink className="size-3" />
        Open in PagerDuty
      </a>
    </Button>
  );
}

/**
 * Takes somebody to the connection when PagerDuty would not answer for it.
 *
 * The messages above this say what PagerDuty returned - a rejected
 * credential, a missing scope, a lapsed plan - but every one of them is fixed
 * somewhere other than this node. Test Connection on the connection itself is
 * the thing that tells a bad token from a wrong service region from a rate
 * limit, and it is also where the token is replaced, so that is where this
 * goes.
 *
 * Renders nothing when the organisation is not loaded yet, rather than a link
 * that would land somewhere wrong.
 */
function CheckConnectionButton() {
  const { data: activeOrg } = authClient.useActiveOrganization();
  if (!activeOrg?.id) {
    return null;
  }
  return (
    <Button asChild size="sm" variant="ghost">
      <a
        href={`/settings/${activeOrg.id}/connections`}
        rel="noopener noreferrer"
        target="_blank"
      >
        <KeyRound className="size-3" />
        Check the connection
      </a>
    </Button>
  );
}

function ReloadButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      className="inline-flex items-center gap-1 text-muted-foreground text-xs underline hover:text-foreground"
      onClick={onClick}
      type="button"
    >
      <RefreshCw className="size-3" />
      Reload from PagerDuty
    </button>
  );
}

const pickServices = (body: { services?: PagerDutyService[] }) =>
  body.services ?? [];

/** The same live service list, for the payload and incident preview. */
export function usePagerDutyServices(integrationId: string | undefined) {
  return usePagerDutyResources(integrationId, "services", pickServices);
}
const pickPolicies = (body: {
  escalationPolicies?: PagerDutyEscalationPolicy[];
}) => body.escalationPolicies ?? [];

const pickPriorities = (body: { priorities?: PagerDutyPriority[] }) =>
  body.priorities ?? [];

export function PagerDutyServiceField({
  value,
  disabled,
  integrationId,
  onChange,
}: {
  value: string;
  disabled?: boolean;
  integrationId?: string;
  onChange: (value: string) => void;
}) {
  const {
    items,
    loading,
    error,
    reload,
    accountSubdomain,
    euRegion,
    truncated,
  } = usePagerDutyResources(integrationId, "services", pickServices);

  const selected = items.find((service) => service.id === value);
  // A stored id that the account no longer lists: deleted, moved, or outside
  // what these credentials can see. The id is kept exactly as it is - silently
  // repointing a node at another service would send a page to another team.
  // Never claimed on a truncated list, where the service may simply be on a
  // page nobody fetched.
  const missing =
    Boolean(value) && !(loading || error || truncated) && !selected;

  if (!integrationId) {
    return (
      <Notice tone="info">
        Select a PagerDuty connection first - the services are read from that
        account.
      </Notice>
    );
  }

  return (
    <div className="space-y-2">
      <Select
        disabled={disabled || loading}
        onValueChange={onChange}
        value={value || undefined}
      >
        <SelectTrigger className="w-full">
          {loading ? (
            <span className="flex items-center gap-2 text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              Loading services
            </span>
          ) : null}
          {/*
            A stored id with no matching entry in the list - the account could
            not be read, or the list is truncated, or the service is gone.
            Radix draws the placeholder in that case, so a node that is
            configured reads as though nothing is selected, and somebody
            "fixes" it by picking another service. The stored id is shown
            instead, which is the one thing that survives a rename.
          */}
          {!loading && value && !selected ? (
            <span className="font-mono text-muted-foreground">{value}</span>
          ) : null}
          {loading || (value && !selected) ? null : (
            <SelectValue placeholder="Select a service" />
          )}
        </SelectTrigger>
        <SelectContent>
          {items.map((service) => (
            <SelectItem key={service.id} value={service.id}>
              <span className="flex flex-col items-start">
                <span>{service.name}</span>
                <span className="text-muted-foreground text-xs">
                  {/*
                    The id, and the id first. A service renamed in PagerDuty
                    comes back under its new name on the next load while the
                    node still points at the same id, so the id is the only
                    thing somebody can recognise it by.
                  */}
                  <span className="font-mono">{service.id}</span>
                  {" - "}
                  {service.escalationPolicyName
                    ? `pages ${service.escalationPolicyName}`
                    : "no escalation policy visible"}
                  {service.acceptsEvents ? "" : " - takes no events"}
                </span>
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {(accountSubdomain || selected) && (
        <p className="ml-1 text-muted-foreground text-xs">
          {accountSubdomain ? (
            <span className="font-mono">
              {accountSubdomain}
              {euRegion ? ".eu" : ""}.pagerduty.com
            </span>
          ) : null}
          {accountSubdomain && selected ? " - " : null}
          {selected ? <span className="font-mono">{selected.id}</span> : null}
        </p>
      )}

      {error && (
        <Notice tone="warning">
          <p>{error}</p>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <ReloadButton onClick={reload} />
            <CheckConnectionButton />
          </div>
        </Notice>
      )}

      {!(loading || error) && items.length === 0 && (
        <Notice tone="warning">
          This PagerDuty account has no services. A service is what an alert
          attaches to and what carries the escalation policy - create one in
          PagerDuty, give it an Events API v2 integration, then reload.
          <div className="mt-1">
            <ReloadButton onClick={reload} />
          </div>
        </Notice>
      )}

      {missing && (
        <Notice tone="warning">
          Service <code className="font-mono">{value}</code> is not in this
          account any more - deleted, or outside what this connection can see.
          The node still points at it, so nothing has been quietly repointed at
          another team. Open it in PagerDuty to tell those two apart: gone means
          deleted, and a service that loads means this connection cannot see it.
          Pick a service to fix it.
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <ReloadButton onClick={reload} />
            {accountSubdomain ? (
              <OpenInPagerDutyButton
                href={pagerDutyServiceUrl(accountSubdomain, euRegion, value)}
              />
            ) : null}
          </div>
        </Notice>
      )}

      {selected && !selected.acceptsEvents && (
        <Notice tone="warning">
          {selected.name} has no Events API v2 integration, so it cannot accept
          events. Add one in PagerDuty under Service, Integrations, then reload.
        </Notice>
      )}

      {selected && selected.status === "disabled" && (
        <Notice tone="warning">
          {selected.name} is disabled in PagerDuty. It accepts events and raises
          no incident, so a page sent to it goes nowhere. This node fails rather
          than reporting a page that never happened.
        </Notice>
      )}

      {selected && selected.status === "maintenance" && (
        <Notice tone="warning">
          {selected.name} is in a maintenance window, so PagerDuty will take the
          event and raise no incident until the window ends. The node reports
          that rather than claiming someone was paged.
        </Notice>
      )}

      {truncated && (
        <Notice tone="warning">
          This account has more services than this list can show, and there is
          no way to reach one past the end of it here. If the service you want
          is missing, set its id on this node through the API or MCP, or ask
          PagerDuty support to tidy up services nobody uses.
        </Notice>
      )}

      {selected?.acceptsEvents && (
        <Notice tone="info">
          Pages{" "}
          <span className="text-foreground">
            {selected.escalationPolicyName ?? "the service's escalation policy"}
          </span>
          . Events route by the service's own policy; only the REST Create
          Incident action can override it.
        </Notice>
      )}
    </div>
  );
}

/**
 * Radix will not take an empty option value, so "no override" needs a sentinel
 * of its own. It is mapped back to "" on the way out: the node stores a blank
 * escalation policy, exactly as it does before anyone touches the field.
 */
const SERVICE_DEFAULT_POLICY = "service-default-policy";

export function PagerDutyEscalationPolicyField({
  value,
  disabled,
  integrationId,
  onChange,
}: {
  value: string;
  disabled?: boolean;
  integrationId?: string;
  onChange: (value: string) => void;
}) {
  const {
    items,
    loading,
    error,
    reload,
    accountSubdomain,
    euRegion,
    truncated,
  } = usePagerDutyResources(integrationId, "escalation-policies", pickPolicies);

  const selected = items.find((policy) => policy.id === value);
  // Not claimed on a truncated list, for the same reason as the service field
  // above: a policy on a page nobody fetched is not a deleted policy, and
  // telling someone their escalation policy is gone during setup sends them
  // to PagerDuty to look for something that is still there.
  const missing =
    Boolean(value) && !(loading || error || truncated) && !selected;

  if (!integrationId) {
    return <Notice tone="info">Select a PagerDuty connection first.</Notice>;
  }

  return (
    <div className="space-y-2">
      <Select
        disabled={disabled || loading}
        onValueChange={(next) =>
          onChange(next === SERVICE_DEFAULT_POLICY ? "" : next)
        }
        value={value || undefined}
      >
        <SelectTrigger className="w-full">
          {/* A stored id the account cannot account for: show the id itself
              rather than the placeholder, which would read as "no override
              set" on a node that has one. */}
          {!loading && value && !selected ? (
            <span className="font-mono text-muted-foreground">{value}</span>
          ) : (
            <SelectValue
              placeholder={
                loading ? "Loading policies" : "Service default (recommended)"
              }
            />
          )}
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={SERVICE_DEFAULT_POLICY}>
            Service default (recommended)
          </SelectItem>
          {items.map((policy) => (
            <SelectItem key={policy.id} value={policy.id}>
              <span className="flex flex-col items-start">
                <span>{policy.name}</span>
                {/* Policies get renamed too, and the node stores the id. */}
                <span className="font-mono text-muted-foreground text-xs">
                  {policy.id}
                </span>
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {accountSubdomain && (
        <p className="ml-1 font-mono text-muted-foreground text-xs">
          {accountSubdomain}
          {euRegion ? ".eu" : ""}.pagerduty.com
        </p>
      )}

      {error && (
        <Notice tone="warning">
          <p>{error}</p>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <ReloadButton onClick={reload} />
            <CheckConnectionButton />
          </div>
        </Notice>
      )}

      {missing && (
        <Notice tone="warning">
          Escalation policy <code className="font-mono">{value}</code> is not in
          this account any more. Unless the fallback below is off, the incident
          will page the service's own policy instead.
        </Notice>
      )}

      {truncated && (
        <Notice tone="warning">
          This account has more escalation policies than this list can show. If
          the one you want is missing, leave this on the service default - the
          service's own policy is what every other action uses anyway.
        </Notice>
      )}
    </div>
  );
}

/**
 * "Leave it to PagerDuty" needs a sentinel because Radix rejects an empty
 * option value, and it is mapped back to "" on the way out so the node stores
 * a blank priority. The step still recognises the literal, so a node saved
 * before this did survives.
 */
const NO_PRIORITY = "none";

/**
 * The account's incident priorities. REST-only, and a paid-plan feature, so an
 * empty list is a normal state rather than an error.
 */
export function PagerDutyPriorityField({
  value,
  disabled,
  integrationId,
  onChange,
}: {
  value: string;
  disabled?: boolean;
  integrationId?: string;
  onChange: (value: string) => void;
}) {
  const { items, loading, error } = usePagerDutyResources(
    integrationId,
    "priorities",
    pickPriorities
  );
  const selected = items.find((priority) => priority.id === value);

  if (!integrationId) {
    return <Notice tone="info">Select a PagerDuty connection first.</Notice>;
  }

  if (!(loading || error) && items.length === 0) {
    return (
      <Notice tone={value ? "warning" : "info"}>
        This PagerDuty account has no incident priorities. They come with the
        plans that include them; without one, PagerDuty decides the priority
        itself.
        {value ? (
          <>
            {" "}
            This node still asks for <code className="font-mono">{value}</code>,
            which PagerDuty will reject - a plan that used to include priorities
            and no longer does looks exactly like this.
          </>
        ) : null}
      </Notice>
    );
  }

  return (
    <div className="space-y-2">
      <Select
        disabled={disabled || loading}
        onValueChange={(next) => onChange(next === NO_PRIORITY ? "" : next)}
        value={value || undefined}
      >
        <SelectTrigger className="w-full">
          {!loading && value && !selected ? (
            <span className="font-mono text-muted-foreground">{value}</span>
          ) : (
            <SelectValue placeholder="Leave it to PagerDuty" />
          )}
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NO_PRIORITY}>Leave it to PagerDuty</SelectItem>
          {items.map((priority) => (
            <SelectItem key={priority.id} value={priority.id}>
              <span className="flex flex-col items-start">
                <span>{priority.name}</span>
                <span className="text-muted-foreground text-xs">
                  {/* P1 and P2 are the names, not the ids, and an account can
                      rename them. The id is what the node stores. */}
                  <span className="font-mono">{priority.id}</span>
                  {priority.description ? ` - ${priority.description}` : ""}
                </span>
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {error && (
        <Notice tone="warning">
          <p>{error}</p>
          <div className="mt-1">
            <CheckConnectionButton />
          </div>
        </Notice>
      )}
      {/* The service and escalation-policy pickers both say when the id on the
          node is not in the account; this one only said so when the account
          had no priorities at all. An imported workflow carries the exporting
          organisation's priority id, which is exactly this case, and the node
          failed on its first fire instead. */}
      {!(loading || error) && value && !selected && items.length > 0 && (
        <Notice tone="warning">
          Priority <code className="font-mono">{value}</code> is not in this
          account. It most often means the workflow was imported from another
          PagerDuty account, whose priority ids do not carry over. Pick one
          above, or leave it to PagerDuty.
        </Notice>
      )}
    </div>
  );
}

/**
 * Picks the Trigger Incident node whose alert an acknowledge or resolve
 * closes. A node reference, not a template: the healthy branch of a check is
 * exactly the branch where the trigger node did not run, so a reference to its
 * output would be unresolved and the run would fail.
 */
export type TriggerNodeChoice = {
  id: string;
  label: string;
  /** The service that trigger pages, so a mismatch can be caught here. */
  serviceId?: string;
  /** Set when that trigger uses a dedup key of its own rather than the derived one. */
  dedupKey?: string;
};

/**
 * Picks the Trigger Incident node whose alert an acknowledge or resolve
 * closes, and catches the two ways this silently closes nothing.
 *
 * PagerDuty drops an update that names a different service from the trigger,
 * or a dedup key no alert carries, and answers 202 to both - so neither shows
 * up at run time. The editor has the trigger node's own configuration, so it
 * can say so while there is still someone reading.
 */
export function PagerDutyTriggerNodeField({
  value,
  disabled,
  nodes,
  currentServiceId,
  currentDedupKey,
  onChange,
}: {
  value: string;
  disabled?: boolean;
  nodes: TriggerNodeChoice[];
  currentServiceId?: string;
  currentDedupKey?: string;
  onChange: (value: string) => void;
}) {
  const selected = nodes.find((node) => node.id === value);
  const serviceMismatch =
    selected?.serviceId &&
    currentServiceId &&
    selected.serviceId !== currentServiceId;
  const dedupKeyMissing =
    Boolean(selected?.dedupKey?.trim()) && !currentDedupKey?.trim();

  if (nodes.length === 0) {
    return (
      <Notice tone="info">
        No Trigger Incident node in this workflow yet. Add one, or set the dedup
        key below by hand on both nodes.
      </Notice>
    );
  }

  return (
    <div className="space-y-2">
      <Select
        disabled={disabled}
        onValueChange={onChange}
        value={value || undefined}
      >
        <SelectTrigger className="w-full">
          <SelectValue placeholder="Select the trigger node" />
        </SelectTrigger>
        <SelectContent>
          {nodes.map((node) => (
            <SelectItem key={node.id} value={node.id}>
              {node.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {Boolean(value) && !selected && (
        <Notice tone="warning">
          The trigger node this pointed at is gone from the workflow. Pick
          another, or set the dedup key by hand - otherwise this closes nothing.
        </Notice>
      )}

      {!(value || currentDedupKey?.trim()) && (
        <Notice tone="warning">
          Nothing is selected and no dedup key is set below, so this node has no
          alert to close and the run will fail when it reaches it. Pick the
          trigger node, or set the same dedup key on both nodes.
        </Notice>
      )}

      {serviceMismatch && (
        <Notice tone="warning">
          {selected?.label} pages service{" "}
          <code className="font-mono">{selected?.serviceId}</code>, and this
          node names <code className="font-mono">{currentServiceId}</code>.
          PagerDuty drops an update that arrives through a different service,
          and answers 202 while doing it, so this would close nothing and look
          like it worked. Use the same service on both.
        </Notice>
      )}

      {dedupKeyMissing && (
        <Notice tone="warning">
          {selected?.label} sets its own dedup key (
          <code className="font-mono">{selected?.dedupKey}</code>). Put the same
          value in the dedup key field below, or this closes nothing.
        </Notice>
      )}
    </div>
  );
}

type TestLeg = { step: string; ok: boolean; error?: string };
type TestOutcome = {
  ok: boolean;
  legs: TestLeg[];
  incidentUrl?: string;
  warning?: string;
  error?: string;
};

const LEG_LABEL: Record<string, string> = {
  trigger: "Opened an alert",
  acknowledge: "Acknowledged it",
  resolve: "Resolved it",
};

/**
 * Why the test cannot be run yet, in the words of whatever is actually
 * missing. A connection whose credential is rejected lists no services, so
 * "pick a service" would be an instruction nobody can follow.
 */
function PagerDutyTestNotReady({
  reason,
  servicesError,
}: {
  reason: PagerDutyNodeTestReadiness;
  servicesError: string | null;
}) {
  if (reason === "no-connection") {
    return (
      <Notice tone="info">
        Pick a connection above, then a service, and you can send one real test
        alert through them from here.
      </Notice>
    );
  }
  if (reason === "loading-services") {
    return (
      <Notice tone="info">Reading the services on this connection.</Notice>
    );
  }
  if (reason === "connection-unreadable") {
    return (
      <Notice tone="warning">
        This connection could not be read, so there is no service to test
        against: {servicesError} Fix the connection in Settings, then reload the
        list above. Nothing has been sent to PagerDuty.
      </Notice>
    );
  }
  if (reason === "no-services") {
    return (
      <Notice tone="warning">
        This connection reached PagerDuty and the account has no services yet.
        Create one in PagerDuty, then reload the list above. A missing
        <code>services.read</code> scope does not land here - that fails the
        credential outright and is reported as such.
      </Notice>
    );
  }
  return (
    <Notice tone="info">
      Pick a service above, then you can send one real test alert through it
      from here.
    </Notice>
  );
}

/**
 * Sends one real alert through the selected service and takes it back again.
 *
 * The reason to do this from the node rather than trust the connection test:
 * a valid credential proves nothing about the service somebody just picked.
 * A service with no Events API v2 integration, one that is disabled, one in a
 * maintenance window and one that pages the wrong rota all look identical in
 * the picker, and the first time anybody finds out is during an incident.
 *
 * It is explicit about what it does. The button says so before it is pressed,
 * because it genuinely reaches on-call's service, and the round trip ends
 * resolved so nothing is left for somebody to tidy up.
 */
export function PagerDutyTestNodeButton({
  integrationId,
  serviceId,
  disabled,
}: {
  integrationId?: string;
  serviceId?: string;
  disabled?: boolean;
}) {
  const [running, setRunning] = useState(false);
  const [outcome, setOutcome] = useState<TestOutcome | null>(null);

  // The same list the picker above reads. The button needs it to tell three
  // states apart that all look like "no service is selected": no connection
  // chosen yet, a connection that cannot be read, and a connection that reads
  // fine and simply has nothing picked. Telling somebody to pick a service
  // when the list failed to load asks them to do something they cannot.
  const {
    items: services,
    loading: servicesLoading,
    error: servicesError,
  } = usePagerDutyServices(serviceId ? undefined : integrationId);

  const reason = pagerDutyNodeTestReadiness({
    hasConnection: Boolean(integrationId),
    hasService: Boolean(serviceId),
    serviceCount: services.length,
    servicesError,
    servicesLoading,
  });
  const ready = reason === "ready";

  const runTest = async (): Promise<void> => {
    if (!(ready && integrationId) || running) {
      return;
    }
    setRunning(true);
    setOutcome(null);
    try {
      const res = await fetch(
        `/api/integrations/${encodeURIComponent(integrationId)}/pagerduty/test-node`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ serviceId }),
        }
      );
      const body = (await res.json().catch(() => ({}))) as TestOutcome;
      setOutcome(
        res.ok
          ? body
          : {
              ok: false,
              legs: [],
              error:
                typeof body?.error === "string"
                  ? body.error
                  : `The test could not be run (HTTP ${res.status}).`,
            }
      );
    } catch (error) {
      setOutcome({
        ok: false,
        legs: [],
        error: `Could not reach KeeperHub to run the test${error instanceof Error ? ` (${error.message})` : ""}. Nothing was sent to PagerDuty.`,
      });
    } finally {
      setRunning(false);
    }
  };

  if (!ready) {
    return (
      <PagerDutyTestNotReady reason={reason} servicesError={servicesError} />
    );
  }

  return (
    <div className="space-y-2">
      <Button
        disabled={disabled || running}
        onClick={runTest}
        size="sm"
        type="button"
        variant="outline"
      >
        {running ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : (
          <Send className="size-3.5" />
        )}
        {running ? "Sending" : "Send a test alert"}
      </Button>

      <p className="ml-1 text-muted-foreground text-xs">
        Opens a real alert on this service at the lowest severity, acknowledges
        it and resolves it, in about a second. It uses a dedup key of its own,
        so it cannot touch an alert a workflow opened, and it reads the alert
        back afterwards to say whether it really closed. If the service notifies
        on info-severity events, on-call may see it briefly.
      </p>

      {outcome?.error && (
        <Notice tone="warning">
          <p>{outcome.error}</p>
        </Notice>
      )}

      {outcome && !outcome.error && (
        <Notice tone={outcome.ok ? "info" : "warning"}>
          <div className="space-y-0.5">
            {outcome.legs.map((leg) => (
              <p key={leg.step}>
                {leg.ok ? "Done: " : "Failed: "}
                {LEG_LABEL[leg.step] ?? leg.step}
                {leg.error ? ` - ${leg.error}` : ""}
              </p>
            ))}
            {outcome.ok && (
              <p className="pt-1">
                This node can page {serviceId} and close what it opens.
              </p>
            )}
            {outcome.incidentUrl && (
              <p className="pt-1">
                <a
                  className="underline hover:text-foreground"
                  href={outcome.incidentUrl}
                  rel="noopener noreferrer"
                  target="_blank"
                >
                  See it in PagerDuty
                </a>
              </p>
            )}
          </div>
        </Notice>
      )}

      {outcome?.warning && <Notice tone="warning">{outcome.warning}</Notice>}
    </div>
  );
}

/** Connection types that can carry a backup notification if a page fails. */
const BACKUP_TYPES: ReadonlySet<string> = new Set([
  "discord",
  "slack",
  "telegram",
]);

/** Same sentinel-to-blank mapping as the pickers above; Radix needs it. */
const NO_BACKUP = "no-backup";

const BACKUP_TYPE_LABEL: Record<string, string> = {
  discord: "Discord",
  slack: "Slack",
  telegram: "Telegram",
};

/**
 * Picks the connection that gets told when PagerDuty will not take the page.
 *
 * Only existing connections are offered - no URL field - so the step keeps
 * talking to a fixed set of hosts, and the credential stays where credentials
 * belong.
 */
export function PagerDutyBackupConnectionField({
  value,
  disabled,
  connections,
  onChange,
}: {
  value: string;
  disabled?: boolean;
  connections: { id: string; name: string; type: string }[];
  onChange: (value: string) => void;
}) {
  const usable = connections.filter((connection) =>
    BACKUP_TYPES.has(connection.type)
  );
  const selected = usable.find((connection) => connection.id === value);
  const missing = Boolean(value) && !selected;

  if (usable.length === 0) {
    return (
      <Notice tone="info">
        No Discord, Slack or Telegram connection in this organisation yet. Add
        one under Settings, Connections to use it as a backup when a page cannot
        be delivered.
      </Notice>
    );
  }

  return (
    <div className="space-y-2">
      <Select
        disabled={disabled}
        onValueChange={(next) => onChange(next === NO_BACKUP ? "" : next)}
        value={value || undefined}
      >
        <SelectTrigger className="w-full">
          <SelectValue placeholder="No backup - just fail the run" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NO_BACKUP}>
            No backup - just fail the run
          </SelectItem>
          {usable.map((connection) => (
            <SelectItem key={connection.id} value={connection.id}>
              {connection.name}
              <span className="ml-1 text-muted-foreground text-xs">
                {BACKUP_TYPE_LABEL[connection.type] ?? connection.type}
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {missing && (
        <Notice tone="warning">
          The backup connection this node pointed at has been removed. Pick
          another one, or the node will only report the failure.
        </Notice>
      )}

      {selected && selected.type !== "discord" && (
        <Notice tone="info">
          {BACKUP_TYPE_LABEL[selected.type]} also needs a destination below: a
          channel like #alerts for Slack, a chat id for Telegram.
        </Notice>
      )}
    </div>
  );
}

/**
 * Warns when a Create Incident node has no From email to run with.
 *
 * PagerDuty's REST create call attributes the incident to a user and refuses
 * without one, so the step fails at run time with a message naming both places
 * it can be set. That message arrives on the first run, which for a scheduled
 * workflow can be the night it was needed - the connection form marks the
 * field optional, correctly, because only this one action reads it.
 *
 * This closes that gap in the editor. It asks the server whether the selected
 * connection carries one rather than reading it from the node, because the
 * address is stored on the connection and credential values are never sent to
 * the browser. Only the boolean comes back.
 */
export function PagerDutyFromEmailNotice({
  integrationId,
  nodeFromEmail,
}: {
  integrationId: string | undefined;
  nodeFromEmail: string | undefined;
}) {
  const [connectionHasOne, setConnectionHasOne] = useState<boolean | undefined>(
    undefined
  );

  useEffect(() => {
    if (!integrationId) {
      setConnectionHasOne(undefined);
      return;
    }
    let cancelled = false;
    fetch(
      `/api/integrations/${encodeURIComponent(integrationId)}/pagerduty/resources?resource=from-email`
    )
      .then(async (response) => {
        const body = await response.json().catch(() => ({}));
        if (!cancelled) {
          // Anything other than a clear "no" leaves this quiet. A route that
          // failed says nothing about the connection, and a warning that the
          // From email is missing when it is not would send somebody editing a
          // connection that was already right.
          setConnectionHasOne(
            typeof body?.hasFromEmail === "boolean" ? body.hasFromEmail : true
          );
        }
      })
      .catch(() => {
        if (!cancelled) {
          setConnectionHasOne(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [integrationId]);

  // The node's own value wins over the connection's, and a template counts as
  // filled: what it resolves to is not knowable here, and guessing it empty
  // would warn on every node that sets the address from an earlier step.
  const nodeHasOne = (nodeFromEmail ?? "").trim().length > 0;
  if (!integrationId || nodeHasOne || connectionHasOne !== false) {
    return null;
  }

  return (
    <Notice tone="warning">
      Neither this node nor its connection carries a From email, and PagerDuty
      will not create an incident without one - this node would fail on its
      first run. Put one in the field above, or on the connection so every
      Create Incident node inherits it. It has to be the login email of a user
      who exists in the PagerDuty account.
    </Notice>
  );
}
