import "server-only";

import { ExecutionErrorType } from "@/lib/errors/execution-error-type";
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

// x402 v2 servers carry the terms in PAYMENT-REQUIRED; older ones use the
// X-prefixed names. KeeperHub's own call route sets the first two.
export const CHALLENGE_HEADERS = [
  "payment-required",
  "x-payment-requirements",
  "x-payment-required",
];

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
   * `asset` names the token). Absent when the card does not say.
   */
  priceUnit?: "usd" | "base_units";
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
  /** Amount in the asset's base units. */
  amount?: string;
  asset?: string;
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

type JsonObject = Record<string, unknown>;

// Failures are recognised by identity, not by shape: user input or an agent
// response can itself contain `success: false`.
const failures = new WeakSet<object>();

function isObject(value: unknown): value is JsonObject {
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
 * Validates the agent base URL and returns it without trailing slashes.
 * Returns undefined when it is not an absolute http(s) URL.
 */
export function normalizeAgentUrl(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return;
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return;
    }
  } catch {
    return;
  }
  return stripTrailingSlashes(trimmed);
}

/**
 * The card's `payments` list holds one x402 method per offer. Its
 * `extensions.x402.price` is either the USD string the author wrote or a
 * `{ amount, asset }` token amount, which is how the unit and asset of an
 * entrypoint's `pricing.invoke` are told apart.
 */
function findPaymentMethod(
  card: JsonObject,
  price: string,
  network: string | undefined
): { unit: "usd" | "base_units"; asset?: string; payTo?: string } | undefined {
  const methods = Array.isArray(card.payments) ? card.payments : [];
  for (const method of methods) {
    if (!isObject(method)) {
      continue;
    }
    const extensions = isObject(method.extensions) ? method.extensions : {};
    const offer = isObject(extensions.x402) ? extensions.x402 : {};
    if (network && str(offer.network ?? method.network) !== network) {
      continue;
    }
    const payTo = str(offer.payTo) ?? str(method.payee);
    if (isObject(offer.price) && str(offer.price.amount) === price) {
      return { unit: "base_units", asset: str(offer.price.asset), payTo };
    }
    if (str(offer.price) === price) {
      return { unit: "usd", payTo };
    }
  }
  return;
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
    entrypoint.priceUnit = method?.unit;
    entrypoint.asset = method?.asset;
    entrypoint.payTo = method?.payTo;
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

/**
 * Reads the first payment requirement from an x402 envelope
 * (`{ x402Version, accepts: [...] }`) or a bare requirement object.
 * Returns null when nothing in it looks like payment terms.
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

  return {
    scheme: str(terms.scheme),
    network: str(terms.network),
    amount: str(terms.maxAmountRequired) ?? str(terms.amount),
    asset: str(terms.asset),
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
