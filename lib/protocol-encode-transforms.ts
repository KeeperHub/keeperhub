/**
 * Protocol Encode Transform Registry
 *
 * Stores pre-ABI-encoding transform functions keyed by protocol/action/input.
 * Applied in step handlers after collecting user values, before reshapeArgsForAbi.
 *
 * Transforms are NOT serializable (they are functions). They live here,
 * separate from ProtocolActionInput, so the MCP schemas endpoint and
 * other serialization layers are unaffected.
 */

import { formatEther } from "ethers";

type EncodeTransform = (value: string) => string;

/**
 * Discriminator for registered transforms. The runtime applies the
 * transform function regardless; the codegen synthesiser switches on
 * `kind` to emit equivalent inline source. Add a new value here when
 * registering a new transform shape, then teach the synthesiser to
 * handle it.
 */
export type EncodeTransformKind = "padAddressToBytes" | "weiToEther";

type TransformEntry = {
  kind: EncodeTransformKind;
  transform: EncodeTransform;
  protocolSlug: string;
  actionSlug: string;
  inputName: string;
};

/** One registered transform, flattened for callers that need to audit the
 *  whole registry rather than look one up. Used by the invariant test that
 *  keeps weiToEther off declared ABI inputs; see the note on the kind in
 *  lib/workflow/codegen/protocol-synthesiser.ts. */
export type RegisteredEncodeTransform = {
  protocolSlug: string;
  actionSlug: string;
  inputName: string;
  kind: EncodeTransformKind;
};

type TransformKey = string;

function makeKey(
  protocolSlug: string,
  actionSlug: string,
  inputName: string
): TransformKey {
  return `${protocolSlug}/${actionSlug}/${inputName}`;
}

const transforms = new Map<TransformKey, TransformEntry>();

/**
 * Minimal view of a protocol the invariant check needs. Kept structural so
 * this module never imports the registry at runtime: `lib/protocol-registry`
 * injects its own lookup below, which keeps the dependency one-way and the
 * two modules free of an import cycle.
 */
type ActionInputsLookup = (
  protocolSlug: string,
  actionSlug: string
) => readonly { name: string }[] | undefined;

let lookupActionInputs: ActionInputsLookup | undefined;

/** Called once by lib/protocol-registry at module load. */
export function setActionInputsLookup(lookup: ActionInputsLookup): void {
  lookupActionInputs = lookup;
}

/**
 * weiToEther exists for the virtual `ethValue` field. Registered on a
 * declared ABI input it would make the runtime convert the value while the
 * emitted SDK does not (see the weiToEther branch in
 * lib/workflow/codegen/protocol-synthesiser.ts), so the two would disagree
 * for that action with nothing at runtime to say so.
 *
 * Returns an error message when the registration is illegal, undefined
 * otherwise. Unknown protocol or action returns undefined: registration
 * order is not guaranteed, and the registry-side check below covers the
 * case where the protocol lands afterwards.
 */
function weiToEtherOnAbiInput(
  protocolSlug: string,
  actionSlug: string,
  inputName: string,
  kind: EncodeTransformKind
): string | undefined {
  if (kind !== "weiToEther" || !lookupActionInputs) {
    return undefined;
  }
  const inputs = lookupActionInputs(protocolSlug, actionSlug);
  if (!inputs?.some((i) => i.name === inputName)) {
    return undefined;
  }
  return illegalWeiToEtherMessage(protocolSlug, actionSlug, inputName);
}

function illegalWeiToEtherMessage(
  protocolSlug: string,
  actionSlug: string,
  inputName: string
): string {
  return `Cannot register the weiToEther transform on "${protocolSlug}/${actionSlug}/${inputName}": that is a declared ABI input, and the emitted SDK does not apply this conversion to ABI args, so the runtime and the generated code would disagree by 10^18. weiToEther is for the virtual ethValue field only.`;
}

/**
 * Re-check every transform already registered for a protocol that is about
 * to be registered. Covers the ordering the check inside
 * registerEncodeTransform cannot: a transform registered eagerly at module
 * load, before its protocol reaches the registry.
 *
 * Takes the definition's own actions rather than reading them back out of
 * the registry, so the caller can run this BEFORE inserting the protocol.
 * That ordering matters: if the protocol were inserted first and this threw
 * afterwards, a caller that catches the throw would be left holding exactly
 * the illegal pairing the guard exists to prevent.
 */
export function assertEncodeTransformsLegalFor(
  protocolSlug: string,
  actions: readonly { slug: string; inputs: readonly { name: string }[] }[]
): void {
  for (const t of transforms.values()) {
    if (t.protocolSlug !== protocolSlug || t.kind !== "weiToEther") {
      continue;
    }
    const inputs = actions.find((a) => a.slug === t.actionSlug)?.inputs;
    if (inputs?.some((i) => i.name === t.inputName)) {
      throw new Error(
        illegalWeiToEtherMessage(t.protocolSlug, t.actionSlug, t.inputName)
      );
    }
  }
}

/**
 * Every registered transform should name a protocol and action that exist.
 * One that does not is silently inert - never applied, and invisible to the
 * weiToEther guard above, which cannot judge an action it cannot find. A
 * typo in a slug therefore reads as "the conversion is registered" while the
 * step goes on parsing a raw wei quote as ether. Returns the offenders so a
 * test can name them; nothing calls this at runtime, because registration
 * order means an entry can be legitimately orphaned until its protocol
 * loads.
 */
export function orphanEncodeTransforms(resolve: ActionInputsLookup): string[] {
  const orphans: string[] = [];
  for (const t of transforms.values()) {
    if (!resolve(t.protocolSlug, t.actionSlug)) {
      orphans.push(`${t.protocolSlug}/${t.actionSlug}/${t.inputName}`);
    }
  }
  return orphans;
}

export function registerEncodeTransform(
  protocolSlug: string,
  actionSlug: string,
  inputName: string,
  transform: EncodeTransform,
  kind: EncodeTransformKind
): void {
  const problem = weiToEtherOnAbiInput(
    protocolSlug,
    actionSlug,
    inputName,
    kind
  );
  if (problem) {
    throw new Error(problem);
  }
  transforms.set(makeKey(protocolSlug, actionSlug, inputName), {
    kind,
    transform,
    protocolSlug,
    actionSlug,
    inputName,
  });
}

export function listEncodeTransforms(): RegisteredEncodeTransform[] {
  return [...transforms.values()].map(
    ({ protocolSlug, actionSlug, inputName, kind }) => ({
      protocolSlug,
      actionSlug,
      inputName,
      kind,
    })
  );
}

/**
 * Remove one registration. Exists so a test can undo a deliberate bad
 * registration without calling clearEncodeTransforms, which would also
 * wipe the eager production entries for the rest of that file.
 */
export function unregisterEncodeTransform(
  protocolSlug: string,
  actionSlug: string,
  inputName: string
): void {
  transforms.delete(makeKey(protocolSlug, actionSlug, inputName));
}

export function getEncodeTransform(
  protocolSlug: string,
  actionSlug: string,
  inputName: string
): EncodeTransform | undefined {
  return transforms.get(makeKey(protocolSlug, actionSlug, inputName))
    ?.transform;
}

export function getEncodeTransformKind(
  protocolSlug: string,
  actionSlug: string,
  inputName: string
): EncodeTransformKind | undefined {
  return transforms.get(makeKey(protocolSlug, actionSlug, inputName))?.kind;
}

export function applyEncodeTransformsNamed(
  protocolSlug: string,
  actionSlug: string,
  inputs: Array<{ name: string; value: string }>
): Array<{ name: string; value: string }> {
  if (transforms.size === 0) {
    return inputs;
  }

  return inputs.map((input) => {
    const entry = transforms.get(makeKey(protocolSlug, actionSlug, input.name));
    if (entry) {
      return { name: input.name, value: entry.transform(input.value) };
    }
    return input;
  });
}

export function clearEncodeTransforms(): void {
  transforms.clear();
}

// -- Built-in transforms ------------------------------------------------------
// Registered eagerly here (not in protocol definition files) because the
// workflow bundler tree-shakes side-effect imports from "use step" files.
// Protocol definition modules are imported via `import "@/protocols"` which
// may not survive bundling, so transforms declared there would be missing
// at runtime.

function padAddressToBytes(value: string): string {
  if (value.startsWith("{{")) {
    return value;
  }
  const hex = value.startsWith("0x") ? value.slice(2) : value;
  return `0x${hex.padStart(64, "0")}`;
}

registerEncodeTransform(
  "chainlink",
  "ccip-get-fee",
  "receiver",
  padAddressToBytes,
  "padAddressToBytes"
);
registerEncodeTransform(
  "chainlink",
  "ccip-send",
  "receiver",
  padAddressToBytes,
  "padAddressToBytes"
);

const INTEGER_WEI = /^\d+$/;

/**
 * Convert an integer wei string into the decimal ether string the payable
 * value field expects. Exact string arithmetic via ethers.formatEther:
 * Number would lose precision above 2^53 and emit exponent notation for
 * small values, which parseEther rejects. Templates pass through so an
 * unresolved reference is left for the executor to resolve.
 */
export function weiToEther(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("{{")) {
    return value;
  }
  if (!INTEGER_WEI.test(trimmed)) {
    throw new Error(`weiToEther expects an integer wei string, got "${value}"`);
  }
  return formatEther(BigInt(trimmed));
}

// LayerZero OFT quotes take the recipient as bytes32; the form collects an
// EVM address. Both quote actions share the flattened SendParam tuple, so
// each registers the pad on its own `to` field. The payable send actions
// register here too once they exist.
registerEncodeTransform(
  "layerzero",
  "oft-quote-send",
  "to",
  padAddressToBytes,
  "padAddressToBytes"
);
registerEncodeTransform(
  "layerzero",
  "oft-quote-oft",
  "to",
  padAddressToBytes,
  "padAddressToBytes"
);
