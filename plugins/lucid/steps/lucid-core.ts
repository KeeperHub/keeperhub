import "server-only";

import { ExecutionErrorType } from "@/lib/errors/execution-error-type";
import { PAYMENT_RAILS, type PaymentRail } from "@/lib/payments/rails";
import {
  assertUrlIsPublic,
  SsrfBlockedError,
  safeFetch,
} from "@/lib/safe-fetch";
import { getErrorMessage } from "@/lib/utils";
import { stripTrailingSlashes } from "@/lib/utils/url";

/**
 * Shared logic for the Lucid Agents connector.
 *
 * A Lucid agent publishes two HTTP surfaces:
 *
 *   GET  {agentUrl}/.well-known/agent-card.json   what the agent offers
 *   POST {agentUrl}/entrypoints/{key}/invoke      calling one entrypoint
 *
 * A priced entrypoint answers the invoke with HTTP 402 and x402 payment terms
 * instead of a result. The connector returns those terms as data and never
 * signs or pays.
 */

export const DISCOVER_TIMEOUT_MS = 10_000;
export const INVOKE_TIMEOUT_MS = 30_000;
const ERROR_BODY_PREVIEW = 300;

/** An x402 amount is an integer count of the asset's base units, never a decimal. */
const BASE_UNITS = /^\d+$/;

export const AGENT_URL_ERROR =
  "Agent URL must be an absolute http(s) URL with no credentials, e.g. https://agent.example.com";

// x402 v2 servers carry the terms in PAYMENT-REQUIRED; older ones use the
// X-prefixed names. KeeperHub's own call route sets the first two.
export const CHALLENGE_HEADERS = [
  "payment-required",
  "x-payment-requirements",
  "x-payment-required",
];

/** The unit `LucidEntrypoint.price` is stated in. */
export type PriceUnit = "usd" | "base_units" | "unknown";

export type LucidEntrypoint = {
  /**
   * The entrypoint key, as used in the invoke path. Named `name` rather than
   * `key` because the run-log redactor masks any field called `key`.
   */
  name: string;
  description?: string;
  priced: boolean;
  /** The price exactly as the card states it; see `priceUnit`. */
  price?: string;
  /**
   * "usd" for Lucid's canonical USD decimal string ("0.01" is one cent),
   * "base_units" when the entrypoint is priced as a token amount (then
   * `asset` names the token), "unknown" when no offer on the card declares
   * the unit or two offers at this price disagree about it.
   */
  priceUnit?: PriceUnit;
  asset?: string;
  network?: string;
  payTo?: string;
  inputSchema?: unknown;
};

export type LucidAgentCard = {
  name: string;
  version?: string;
  description?: string;
  entrypoints: LucidEntrypoint[];
};

export type PaymentTerms = {
  scheme?: string;
  network?: string;
  /** Amount in the asset's base units; absent unless the server sent an integer. */
  amount?: string;
  /** The amount exactly as served, when it was not a base-units integer. */
  amountRejected?: string;
  asset?: string;
  /** Decimals of the settlement asset, when `network` is a rail this repo knows. */
  assetDecimals?: number;
  /** True when `network` is a known rail and `asset` is not that rail's settlement asset. */
  assetMismatch?: boolean;
  payTo?: string;
  resource?: string;
  description?: string;
  maxTimeoutSeconds?: number;
};

export type LucidFailure = {
  success: false;
  error: string;
  errorClass: ExecutionErrorType;
  httpStatus?: number;
};

export type JsonObject = Record<string, unknown>;

// Failures are recognised by identity, not by shape: user input or an agent
// response can itself contain `success: false`.
const failures = new WeakSet<object>();

export function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "bigint") {
    return String(value);
  }
  return;
}

export function parseJson(text: string): unknown {
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function failure(
  error: string,
  errorClass: ExecutionErrorType,
  httpStatus?: number
): LucidFailure {
  const result: LucidFailure = { success: false, error, errorClass, httpStatus };
  failures.add(result);
  return result;
}

export function isFailure(value: unknown): value is LucidFailure {
  return typeof value === "object" && value !== null && failures.has(value);
}

/**
 * Validates the agent base URL and returns its origin and path, without
 * trailing slashes. Returns undefined when it is not an absolute http(s) URL
 * or when it carries credentials.
 */
export function normalizeAgentUrl(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return;
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return;
  }
  // Userinfo is a credential, and this url is echoed into errors where the
  // redactor drops query strings but not userinfo.
  if (parsed.username || parsed.password) {
    return;
  }
  // Rebuilt rather than returned as given, so a query or fragment cannot
  // swallow the path each caller appends.
  return stripTrailingSlashes(`${parsed.origin}${parsed.pathname}`);
}

type PaymentMatch = { unit: PriceUnit; asset?: string; payTo?: string };

/**
 * Matches one offer in the card's `payments` list against an entrypoint's
 * `pricing.invoke`. `extensions.x402.price` is either the USD string the
 * author wrote or a `{ amount, asset }` token amount, which is how the unit
 * and asset are told apart; `priceModel.default` restates the same figure
 * without saying which unit it is in.
 */
function matchOffer(
  method: JsonObject,
  price: string,
  network: string | undefined
): PaymentMatch | undefined {
  const extensions = isObject(method.extensions) ? method.extensions : {};
  const offer = isObject(extensions.x402) ? extensions.x402 : {};
  if (network && str(offer.network ?? method.network) !== network) {
    return;
  }
  const payTo = str(offer.payTo) ?? str(method.payee);
  if (isObject(offer.price) && str(offer.price.amount) === price) {
    return { unit: "base_units", asset: str(offer.price.asset), payTo };
  }
  if (str(offer.price) === price) {
    return { unit: "usd", payTo };
  }
  const priceModel = isObject(method.priceModel) ? method.priceModel : {};
  if (str(priceModel.default) === price) {
    return { unit: "unknown", payTo };
  }
  return;
}

/**
 * The offer an entrypoint's price belongs to. Always reports a unit: a price
 * no offer explains, and a price two offers state in different units, are both
 * "unknown", because the agent chooses the order of `payments[]` and reading
 * whichever came first as the unit is how a token amount passes for dollars.
 */
function findPaymentMethod(
  card: JsonObject,
  price: string,
  network: string | undefined
): PaymentMatch {
  const methods = Array.isArray(card.payments) ? card.payments : [];
  const matches: PaymentMatch[] = [];
  for (const method of methods) {
    if (isObject(method)) {
      const match = matchOffer(method, price, network);
      if (match) {
        matches.push(match);
      }
    }
  }
  const first = matches[0];
  if (!first) {
    return { unit: "unknown" };
  }
  if (matches.some((match) => match.unit !== first.unit)) {
    return { unit: "unknown" };
  }
  return first;
}

function readEntrypoint(
  card: JsonObject,
  name: string,
  entry: JsonObject
): LucidEntrypoint {
  const network = str(entry.network);
  const pricing = isObject(entry.pricing) ? entry.pricing : undefined;
  const price = pricing ? str(pricing.invoke) : undefined;
  // A payment marker without readable terms still counts as priced: reading
  // a paid entrypoint as free is the costly mistake.
  const priced = Boolean(price) || Boolean(str(entry.payment_protocol));

  const entrypoint: LucidEntrypoint = {
    name,
    description: str(entry.description),
    priced,
    inputSchema: entry.input_schema ?? undefined,
  };
  if (!priced) {
    return entrypoint;
  }
  entrypoint.network = network;
  if (price) {
    entrypoint.price = price;
    const method = findPaymentMethod(card, price, network);
    entrypoint.priceUnit = method.unit;
    entrypoint.asset = method.asset;
    entrypoint.payTo = method.payTo;
  }
  return entrypoint;
}

/**
 * Reads a Lucid agent card. Returns null when the payload has no keyed
 * `entrypoints` object, which every Lucid card carries: anything else is not
 * an agent this plugin can call. The A2A `skills` list is not read, because
 * the invoke route is Lucid's own.
 */
export function readAgentCard(payload: unknown): LucidAgentCard | null {
  if (!(isObject(payload) && isObject(payload.entrypoints))) {
    return null;
  }
  const entrypoints: LucidEntrypoint[] = [];
  for (const [name, value] of Object.entries(payload.entrypoints)) {
    if (isObject(value)) {
      entrypoints.push(readEntrypoint(payload, name, value));
    }
  }
  return {
    name: str(payload.name) ?? "(unnamed)",
    version: str(payload.version),
    description: str(payload.description),
    entrypoints,
  };
}

/** Decodes a header value that is either JSON or base64-encoded JSON. */
function decodeHeaderJson(value: string): unknown {
  const direct = parseJson(value.trim());
  if (direct !== null) {
    return direct;
  }
  try {
    return parseJson(Buffer.from(value.trim(), "base64").toString("utf8"));
  } catch {
    return null;
  }
}

export function readHeaderJson(headers: Headers, names: string[]): unknown {
  for (const name of names) {
    const value = headers.get(name);
    if (value) {
      const decoded = decodeHeaderJson(value);
      if (decoded !== null) {
        return decoded;
      }
    }
  }
  return null;
}

/** The rail a CAIP-2 network id names, when this repo settles on it. */
function railFor(network: string | undefined): PaymentRail | undefined {
  return network && Object.hasOwn(PAYMENT_RAILS, network)
    ? PAYMENT_RAILS[network]
    : undefined;
}

/**
 * Reads the first payment requirement from an x402 envelope
 * (`{ x402Version, accepts: [...] }`) or a bare requirement object.
 * Returns null when nothing in it looks like payment terms.
 *
 * The amount is the server's unvalidated string, so it is published as an
 * amount only when it is the integer count of base units the field claims to
 * be; anything else lands in `amountRejected`, where no arithmetic reaches it.
 */
export function readPaymentTerms(envelope: unknown): PaymentTerms | null {
  if (!isObject(envelope)) {
    return null;
  }
  const accepts = envelope.accepts;
  const terms =
    Array.isArray(accepts) && isObject(accepts[0]) ? accepts[0] : envelope;

  const looksPriced =
    terms.maxAmountRequired !== undefined ||
    terms.amount !== undefined ||
    terms.payTo !== undefined ||
    terms.scheme !== undefined;
  if (!looksPriced) {
    return null;
  }

  // The spec's examples carry `resource` as a string; live servers often send
  // an object with a url, on the requirement or on the envelope.
  const resource =
    str(terms.resource) ??
    (isObject(terms.resource) ? str(terms.resource.url) : undefined) ??
    (isObject(envelope.resource) ? str(envelope.resource.url) : undefined);

  const served = str(terms.maxAmountRequired) ?? str(terms.amount);
  const amount =
    served !== undefined && BASE_UNITS.test(served) ? served : undefined;
  const network = str(terms.network);
  const asset = str(terms.asset);
  const rail = railFor(network);

  return {
    scheme: str(terms.scheme),
    network,
    amount,
    amountRejected: amount === undefined ? served : undefined,
    asset,
    assetDecimals: rail?.assetDecimals,
    assetMismatch:
      rail && asset
        ? asset.toLowerCase() !== rail.asset.toLowerCase()
        : undefined,
    payTo: str(terms.payTo),
    resource,
    description: str(terms.description),
    maxTimeoutSeconds:
      typeof terms.maxTimeoutSeconds === "number"
        ? terms.maxTimeoutSeconds
        : undefined,
  };
}

/**
 * Wraps safeFetch with the connector's fixed rules: the agent URL must be
 * public, never follow a redirect (a redirect points the call at a host
 * nobody named), and bound every call with a timeout.
 */
export async function lucidFetch(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response | LucidFailure> {
  let response: Response;
  try {
    // The agent URL is user-supplied. `assertUrlIsPublic` is always-on -- it
    // ignores `SAFE_FETCH_SHADOW` -- so an agent URL pointing at an internal
    // address is blocked here even where `safeFetch` would only log. Mirrors
    // plugins/blockscout/steps/blockscout-core.ts.
    await assertUrlIsPublic(url);
    response = await safeFetch(url, {
      ...init,
      plugin: "lucid",
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (error instanceof SsrfBlockedError) {
      return failure(
        `Agent URL is not allowed: ${error.message}`,
        ExecutionErrorType.USER
      );
    }
    return failure(
      `Request to ${url} failed: ${getErrorMessage(error)}`,
      ExecutionErrorType.EXTERNAL
    );
  }

  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get("location") ?? "an unstated location";
    return failure(
      `${url} redirected to ${location}. Use the final agent URL instead; redirects are not followed.`,
      ExecutionErrorType.USER,
      response.status
    );
  }
  return response;
}

export function httpFailure(
  what: string,
  response: Response,
  text: string
): LucidFailure {
  const body = text.slice(0, ERROR_BODY_PREVIEW);
  return failure(
    `${what}: HTTP ${response.status}${body ? ` ${body}` : ""}`,
    response.status >= 500
      ? ExecutionErrorType.EXTERNAL
      : ExecutionErrorType.USER,
    response.status
  );
}
