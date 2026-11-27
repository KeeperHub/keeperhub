import type { ConnectionHealth, ConnectionState } from "../ingest/block-source";
import type {
  ChainRegistration,
  RouteRegistration,
  RouteSpec,
} from "../registrations";
import { ROUTE_START_TIMEOUT_MS } from "./constants";
import { type PinnedEndpoint, pinEndpointHosts } from "./pinned-dns";
import type { UsageMeter, UsageRecorder } from "./usage-meter";

/** The slice of BlockIngestor the pool drives. */
export interface RouteIngestor {
  start(): Promise<void>;
  stop(): Promise<void>;
  isStarted(): boolean;
  hasConfigChanged(registration: ChainRegistration): boolean;
  canUpdateInPlace(registration: ChainRegistration): boolean;
  updateRegistration(registration: ChainRegistration): void;
  getHealth(): ConnectionHealth | undefined;
}

export type RouteIngestorFactory = (
  registration: RouteRegistration,
  endpointUsage: UsageRecorder[],
) => RouteIngestor;

const FAILED_STATES: ReadonlySet<ConnectionState> = new Set([
  "failed",
  "stale",
]);

/** One recorder per route endpoint, in the order the connection rotates through them. */
export function routeEndpointUsage(
  route: RouteSpec,
  meter: UsageMeter,
): UsageRecorder[] {
  const endpoints = route.fallback
    ? [route.primary, route.fallback]
    : [route.primary];
  return endpoints.map((endpoint) =>
    meter.recorderFor({
      organizationId: route.organizationId,
      configId: endpoint.configId,
      origin: endpoint.origin,
      chainId: route.chainId,
      transport: route.transport,
    }),
  );
}

function endpointsOf(route: RouteSpec): PinnedEndpoint[] {
  return route.fallback ? [route.primary, route.fallback] : [route.primary];
}

async function withTimeout(work: Promise<void>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      work,
      new Promise<void>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timed out")), ms);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

/** One connection per organization route key, kept out of health and metrics; never throws or logs. */
export class RoutePool {
  private readonly ingestors = new Map<string, RouteIngestor>();
  /** The endpoints each running connection dials, kept pinned until it stops. */
  private readonly dialled = new Map<RouteIngestor, PinnedEndpoint[]>();
  private reconciling = false;

  constructor(
    private readonly createIngestor: RouteIngestorFactory,
    private readonly meter: UsageMeter,
    private readonly startTimeoutMs: number = ROUTE_START_TIMEOUT_MS,
  ) {}

  keys(): string[] {
    return [...this.ingestors.keys()];
  }

  async reconcile(registrations: readonly RouteRegistration[]): Promise<void> {
    // A pass still waiting on a slow route must not be overlapped by the next poll.
    if (this.reconciling) {
      return;
    }
    this.reconciling = true;
    try {
      await this.converge(registrations);
    } finally {
      this.reconciling = false;
    }
  }

  async stopAll(): Promise<void> {
    for (const [key, ingestor] of [...this.ingestors]) {
      await this.teardown(key, ingestor);
    }
  }

  private async converge(
    registrations: readonly RouteRegistration[],
  ): Promise<void> {
    const wanted = new Map<string, RouteRegistration>();
    for (const registration of registrations) {
      wanted.set(registration.route.key, registration);
    }
    const wantedEndpoints = [...wanted.values()].flatMap(({ route }) =>
      endpointsOf(route),
    );
    // A connection still stopping keeps its pins, so it never reconnects
    // through ordinary DNS on its way out.
    this.pin(wantedEndpoints);
    const tornDown = new Set<string>();
    for (const [key, ingestor] of [...this.ingestors]) {
      if (!wanted.has(key)) {
        await this.teardown(key, ingestor);
        continue;
      }
      const state = ingestor.getHealth()?.state;
      if (state !== undefined && FAILED_STATES.has(state)) {
        await this.teardown(key, ingestor);
        tornDown.add(key);
      }
    }
    for (const [key, registration] of wanted) {
      if (!tornDown.has(key)) {
        await this.apply(key, registration);
      }
    }
    this.pin(wantedEndpoints);
  }

  private pin(wanted: readonly PinnedEndpoint[]): void {
    pinEndpointHosts([...wanted, ...[...this.dialled.values()].flat()]);
  }

  private async apply(
    key: string,
    registration: RouteRegistration,
  ): Promise<void> {
    const existing = this.ingestors.get(key);
    try {
      if (existing && !existing.hasConfigChanged(registration)) {
        return;
      }
      if (existing?.canUpdateInPlace(registration)) {
        existing.updateRegistration(registration);
        this.dialled.set(existing, endpointsOf(registration.route));
        return;
      }
      if (existing) {
        await this.teardown(key, existing);
        if (this.ingestors.has(key)) {
          return;
        }
      }
      const ingestor = this.createIngestor(
        registration,
        routeEndpointUsage(registration.route, this.meter),
      );
      this.ingestors.set(key, ingestor);
      this.dialled.set(ingestor, endpointsOf(registration.route));
      await withTimeout(ingestor.start(), this.startTimeoutMs);
    } catch {
      const failed = this.ingestors.get(key);
      if (failed) {
        await this.teardown(key, failed);
      }
    }
  }

  private async teardown(key: string, ingestor: RouteIngestor): Promise<void> {
    try {
      await withTimeout(ingestor.stop(), this.startTimeoutMs);
    } catch {
      // Kept below while still running, so the next pass retries the stop.
    }
    if (!ingestor.isStarted()) {
      this.dialled.delete(ingestor);
      if (this.ingestors.get(key) === ingestor) {
        this.ingestors.delete(key);
      }
    }
  }
}
