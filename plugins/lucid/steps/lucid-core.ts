import "server-only";

import { ExecutionErrorType } from "@/lib/errors/execution-error-type";
import { SsrfBlockedError, safeFetch } from "@/lib/safe-fetch";
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
 * signs or pays: deciding whether to pay belongs to whatever the workflow puts
 * between the 402 and a second, paid call.
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
export const SETTLEMENT_HEADERS = ["payment-response", "x-payment-response"];

export type LucidEntrypoint = {
  /**
   * The entrypoint key, as used in the invoke path. Named `name` rather than
   * `key` because the run-log redactor masks any field called `key`.
   */
  name: string;
  description?: string;
  priced: boolean;
  /** Price in the asset's base units, when the card states it. */
  price?: string;
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
  extensions: string[];
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
  return { success: false, error, errorClass, httpStatus };
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
 * Pricing on an entrypoint descriptor. Cards carry it as an `x402.offers[]`
 * array, a `pricing` object, a `payment_protocol` marker, or a bare `price`.
 * Anything that marks the entrypoint as paid without readable terms still
 * counts as priced: reading a paid entrypoint as free is the costly mistake.
 */
function readPricing(entry: JsonObject): Omit<LucidEntrypoint, "name"> {
  const offers = isObject(entry.x402) ? entry.x402.offers : undefined;
  if (Array.isArray(offers) && isObject(offers[0])) {
    const offer = offers[0];
    const amount = isObject(offer.price) ? offer.price : offer.maximum;
    const terms = isObject(amount) ? amount : {};
    return {
      priced: true,
      price: str(terms.amount),
      asset: str(terms.asset),
      network: str(offer.network),
      payTo: str(offer.payTo),
    };
  }

  if (isObject(entry.pricing)) {
    const pricing = entry.pricing;
    return {
      priced: true,
      price:
        str(pricing.invoke) ??
        str(pricing.amount) ??
        str(pricing.price) ??
        str(pricing.default),
      asset: str(pricing.asset),
      network: str(pricing.network) ?? str(entry.network),
    };
  }

  if (str(entry.payment_protocol) || str(entry.paymentProtocol)) {
    return { priced: true, network: str(entry.network) };
  }

  if (entry.price !== undefined && entry.price !== null) {
    return { priced: true, price: str(entry.price) };
  }

  return { priced: false };
}

/**
 * A Lucid card keys `entrypoints` by name and also publishes an A2A `skills`
 * array without prices. The keyed object wins so prices are not lost; `skills`
 * is the fallback for cards that only speak A2A.
 */
function findEntrypoints(card: JsonObject): JsonObject[] {
  const direct = card.entrypoints;
  if (isObject(direct)) {
    return Object.entries(direct).map(([key, value]) => ({
      key,
      ...(isObject(value) ? value : {}),
    }));
  }
  const list = Array.isArray(direct) ? direct : card.skills;
  if (Array.isArray(list)) {
    return list.filter(isObject);
  }
  return [];
}

/**
 * Card-level payment method. The asset an entrypoint is priced in is stated
 * once here rather than per entrypoint.
 */
function findPaymentDefaults(card: JsonObject): Partial<LucidEntrypoint> {
  const methods = card.payments;
  if (!(Array.isArray(methods) && isObject(methods[0]))) {
    return {};
  }
  const method = methods[0];
  const extensions = isObject(method.extensions) ? method.extensions : {};
  const x402 = isObject(extensions.x402) ? extensions.x402 : {};
  const price = isObject(x402.price) ? x402.price : {};
  return {
    price: str(price.amount),
    asset: str(price.asset),
    network: str(x402.network) ?? str(method.network),
    payTo: str(x402.payTo) ?? str(method.payee),
  };
}

function readExtensions(card: JsonObject): string[] {
  const caps = isObject(card.capabilities) ? card.capabilities : {};
  if (!Array.isArray(caps.extensions)) {
    return [];
  }
  const result: string[] = [];
  for (const extension of caps.extensions) {
    const uri = isObject(extension) ? str(extension.uri) : str(extension);
    if (uri) {
      result.push(uri);
    }
  }
  return result;
}

export function readAgentCard(payload: unknown): LucidAgentCard {
  const card = isObject(payload) ? payload : {};
  const defaults = findPaymentDefaults(card);

  const entrypoints: LucidEntrypoint[] = [];
  for (const entry of findEntrypoints(card)) {
    const key = str(entry.key) ?? str(entry.id) ?? str(entry.name);
    if (!key) {
      continue;
    }
    const pricing = readPricing(entry);
    const entrypoint: LucidEntrypoint = {
      name: key,
      description: str(entry.description),
      inputSchema:
        entry.input_schema ?? entry.inputSchema ?? entry.input ?? undefined,
      ...pricing,
    };
    // Only a priced entrypoint inherits the card's payment details; a free
    // one must not pick up a price.
    if (pricing.priced) {
      entrypoint.price = pricing.price ?? defaults.price;
      entrypoint.asset = pricing.asset ?? defaults.asset;
      entrypoint.network = pricing.network ?? defaults.network;
      entrypoint.payTo = pricing.payTo ?? defaults.payTo;
    }
    entrypoints.push(entrypoint);
  }

  return {
    name: str(card.name) ?? "(unnamed)",
    version: str(card.version),
    description: str(card.description),
    entrypoints,
    extensions: readExtensions(card),
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
 * Wraps safeFetch with the connector's two fixed rules: never follow a
 * redirect (a redirect points the call, and any payment header, at a host
 * nobody named) and bound every call with a timeout.
 */
export async function lucidFetch(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response | LucidFailure> {
  let response: Response;
  try {
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

export function isFailure(value: unknown): value is LucidFailure {
  return isObject(value) && value.success === false;
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
