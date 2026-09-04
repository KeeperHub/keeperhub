import type { AbiParam } from "@/lib/abi/types";
import { SelectorParameterRole } from "@/lib/policy/catalog/constants";

const RECIPIENT_NAMES: readonly string[] = [
  "to",
  "recipient",
  "receiver",
  "dst",
  "dest",
  "destination",
  "beneficiary",
  "onbehalfof",
  "target",
];

const SPENDER_NAMES: readonly string[] = [
  "spender",
  "operator",
  "delegate",
  "guy",
];

const ASSET_NAMES: readonly string[] = [
  "asset",
  "token",
  "underlying",
  "currency",
  "reserve",
  "tokenaddress",
];

const AMOUNT_NAMES: readonly string[] = [
  "amount",
  "value",
  "amt",
  "wad",
  "assets",
  "shares",
  "quantity",
  "qty",
  "amountin",
  "amount0",
  "amount1",
  "tokenamount",
];

const LEADING_UNDERSCORES = /^_+/;

/** Strips the leading underscore convention so `_to` reads as `to`. */
function normalizeName(name: string): string {
  return name.replace(LEADING_UNDERSCORES, "").toLowerCase();
}

function addressRole(name: string): SelectorParameterRole | null {
  if (RECIPIENT_NAMES.includes(name)) {
    return SelectorParameterRole.RECIPIENT;
  }
  if (SPENDER_NAMES.includes(name)) {
    return SelectorParameterRole.SPENDER;
  }
  if (ASSET_NAMES.includes(name)) {
    return SelectorParameterRole.ASSET;
  }
  return null;
}

function roleOf(param: AbiParam): SelectorParameterRole | null {
  const name = normalizeName(param.name);
  if (param.type === "address") {
    return addressRole(name);
  }
  if (param.type.startsWith("uint") && AMOUNT_NAMES.includes(name)) {
    return SelectorParameterRole.AMOUNT;
  }
  return null;
}

/**
 * The parameter roles a function exposes, deduplicated and in declaration
 * order. Only named roles are reported: an unrecognised parameter contributes
 * nothing rather than being guessed at.
 */
export function deriveParameterRoles(
  inputs: readonly AbiParam[]
): readonly SelectorParameterRole[] {
  const roles: SelectorParameterRole[] = [];
  for (const param of inputs) {
    const role = roleOf(param);
    if (role !== null && !roles.includes(role)) {
      roles.push(role);
    }
  }
  return roles;
}

/** True when any parameter is address-shaped, named or not. */
export function hasAddressParameter(inputs: readonly AbiParam[]): boolean {
  return inputs.some((param) => param.type === "address");
}

/** True when any parameter is an unsigned integer, named or not. */
export function hasNumericParameter(inputs: readonly AbiParam[]): boolean {
  return inputs.some((param) => param.type.startsWith("uint"));
}
