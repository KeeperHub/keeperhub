import { ethers } from "ethers";

/**
 * Extra error sources for revert decoding.
 *
 * A direct execution decodes a revert against ONE ABI: the one `abi` names.
 * That is the contract being called, which is the right ABI for encoding and
 * the wrong one when the revert is raised somewhere else - a hook the target
 * calls, an ERC-1967 implementation behind a proxy, a router, a multicall
 * target. Those reverts reach the caller as hex with no way to name them, and
 * merging the extra fragments into `abi` is not a workaround: the same string
 * resolves the function being encoded and reports `ambiguous` when a merge
 * brings in a second fragment under that name.
 *
 * So the extras travel in their own field and join the DECODE path only.
 * `buildErrorDecodeInterface` returns an interface the error formatter can
 * consult; nothing that encodes a call or coerces its arguments ever sees it.
 *
 * Order is target first, then the extras, then the common-error list
 * `decodeRevertReason` already carries. Matching is by selector alone, so the
 * first fragment holding a selector wins and a colliding extra can only decode
 * a revert the target's own ABI left undecoded.
 */

/** How many extra documents one request may put on the decode path. */
export const MAX_ERROR_ABI_DOCUMENTS = 4;

/** Size bound per document. Four of these is the most a request can add. */
export const MAX_ERROR_ABI_DOCUMENT_BYTES = 16_384;

export type ErrorAbiDocumentsResult =
  | { ok: true; documents: string[] }
  | { ok: false; message: string; details: string };

/**
 * Validate the `errorAbis` request field.
 *
 * Every rejection here is caller error rather than something to absorb: a
 * document that will not parse, or one declaring no error at all, would be
 * silently inert, and a field that cannot do what it says is worse than a
 * refused request. The decode path itself is a different matter - see
 * `buildErrorDecodeInterface`, which is best-effort by design because it runs
 * inside a catch where a throw would lose the failure it was called to
 * describe.
 */
export function readErrorAbiDocuments(value: unknown): ErrorAbiDocumentsResult {
  if (value === undefined || value === null) {
    return { ok: true, documents: [] };
  }

  if (!Array.isArray(value)) {
    return {
      ok: false,
      message: "Invalid field type",
      details: "errorAbis must be an array of JSON ABI strings when provided",
    };
  }

  if (value.length > MAX_ERROR_ABI_DOCUMENTS) {
    return {
      ok: false,
      message: "Invalid field value",
      details: `errorAbis accepts at most ${MAX_ERROR_ABI_DOCUMENTS} documents, received ${value.length}`,
    };
  }

  const documents: string[] = [];
  for (const [index, entry] of value.entries()) {
    if (typeof entry !== "string" || entry.trim() === "") {
      return {
        ok: false,
        message: "Invalid field value",
        details: `errorAbis[${index}] must be a non-empty JSON ABI string`,
      };
    }

    if (entry.length > MAX_ERROR_ABI_DOCUMENT_BYTES) {
      return {
        ok: false,
        message: "Invalid field value",
        details: `errorAbis[${index}] exceeds ${MAX_ERROR_ABI_DOCUMENT_BYTES} bytes`,
      };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(entry);
    } catch {
      return {
        ok: false,
        message: "Invalid field value",
        details: `errorAbis[${index}] is not valid JSON`,
      };
    }

    if (!Array.isArray(parsed)) {
      return {
        ok: false,
        message: "Invalid field value",
        details: `errorAbis[${index}] must be a JSON array of ABI entries`,
      };
    }

    // A document with no error entry the decoder can build cannot decode
    // anything, and accepting it would read as though the extra source had
    // been consulted. Building it here is what catches an entry ethers would
    // otherwise skip with a warning - `name: "Paused()"` is the common way to
    // get that wrong, and it is exactly the silently-inert case this field
    // exists to remove.
    let usableErrors = 0;
    try {
      const iface = new ethers.Interface(parsed as ethers.InterfaceAbi);
      usableErrors = iface.fragments.filter(
        (fragment) => fragment.type === "error"
      ).length;
    } catch {
      usableErrors = 0;
    }
    if (usableErrors === 0) {
      return {
        ok: false,
        message: "Invalid field value",
        details: `errorAbis[${index}] declares no error entry the decoder can build`,
      };
    }

    documents.push(entry);
  }

  return { ok: true, documents };
}

/** The result of the reader, or an empty list for a field that failed. */
export function normalizeErrorAbiDocuments(value: unknown): string[] {
  const result = readErrorAbiDocuments(value);
  return result.ok ? result.documents : [];
}

function toInterface(
  target: string | ethers.Interface | undefined
): ethers.Interface | undefined {
  if (!target) {
    return;
  }
  if (typeof target !== "string") {
    return target;
  }
  try {
    const parsed: unknown = JSON.parse(target);
    if (!Array.isArray(parsed)) {
      return;
    }
    return new ethers.Interface(parsed as ethers.InterfaceAbi);
  } catch {
    return;
  }
}

/**
 * The error fragments the extras contribute, in the order received.
 *
 * Only `error` entries are taken. A function or event fragment in one of these
 * documents has no meaning on a decode path, and admitting it would let an
 * extra document shadow the target's own fragment anywhere the merged
 * interface is consulted.
 */
function errorFragmentsFrom(
  documents: readonly string[]
): ethers.ErrorFragment[] {
  const fragments: ethers.ErrorFragment[] = [];
  for (const document of documents.slice(0, MAX_ERROR_ABI_DOCUMENTS)) {
    if (
      typeof document !== "string" ||
      document.length > MAX_ERROR_ABI_DOCUMENT_BYTES
    ) {
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(document);
      if (!Array.isArray(parsed)) {
        continue;
      }
      const iface = new ethers.Interface(parsed as ethers.InterfaceAbi);
      for (const fragment of iface.fragments) {
        if (fragment.type === "error") {
          fragments.push(fragment as ethers.ErrorFragment);
        }
      }
    } catch {
      // A document that will not parse contributes nothing. The target's own
      // ABI and the other extras stay on the path.
    }
  }
  return fragments;
}

/**
 * The interface to decode a revert against: the target's own ABI, then every
 * error fragment the extra documents declare.
 *
 * Returns the target interface unchanged when there is nothing extra to add or
 * when the merge cannot be constructed, so a caller on an error path can call
 * this without a guard of its own. Deduped by `fragment.format()`, the same
 * test the batch path uses to merge its calls' ABIs
 * (`batch-write-contract-core.ts`).
 */
export function buildErrorDecodeInterface(
  target: string | ethers.Interface | undefined,
  documents: readonly string[] | undefined
): ethers.Interface | undefined {
  const targetInterface = toInterface(target);
  const extras = errorFragmentsFrom(documents ?? []);
  if (extras.length === 0) {
    return targetInterface;
  }

  const seen = new Set(
    (targetInterface?.fragments ?? []).map((fragment) => fragment.format())
  );
  const claimedSelectors = new Set(
    (targetInterface?.fragments ?? [])
      .filter(
        (fragment): fragment is ethers.ErrorFragment =>
          fragment.type === "error"
      )
      .map((fragment) => fragment.selector)
  );
  const fragments = [...(targetInterface?.fragments ?? [])];
  for (const fragment of extras) {
    const key = fragment.format();
    if (seen.has(key)) {
      continue;
    }
    // Matching is by selector, so a fragment that collides with one the target
    // already declares could change a decode that works today. The target's
    // copy stays authoritative and the colliding extra is dropped.
    if (claimedSelectors.has(fragment.selector)) {
      continue;
    }
    seen.add(key);
    claimedSelectors.add(fragment.selector);
    fragments.push(fragment);
  }

  try {
    return new ethers.Interface(fragments);
  } catch {
    // An incompatible pair of fragments, e.g. one name declared twice with
    // different types. The target's ABI still decodes everything it did.
    return targetInterface;
  }
}
