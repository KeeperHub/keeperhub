/**
 * Per-chain target contract addresses for every protocol surfaced in the
 * policy wizard. Sourced from the `protocols/*.ts` definitions at
 * `/home/joel/work-stage/techops/keeperhub/protocols/`.
 *
 * Used by the target-only fallback template when a defi-kit preset does
 * not exist for a protocol. The Zodiac Roles modifier scopes each
 * address in this list so workflows can call the contract (any function)
 * but nothing else.
 *
 * Follow-up: derive these at build time from the protocol definitions so
 * new plugins do not need a manual edit here.
 */

import type { ProtocolSlug } from "@/lib/safe/protocol-registry";

const ETH = 1;
const OPT = 10;
const BASE = 8453;
const ARB = 42_161;

export const PROTOCOL_TARGETS: Readonly<
  Record<ProtocolSlug, Readonly<Record<number, readonly string[]>>>
> = {
  "aave-v3": {
    [ETH]: ["0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2"],
    [BASE]: ["0xA238Dd80C259a72e81d7e4664a9801593F98d1c5"],
    [ARB]: ["0x794a61358D6845594F94dc1DB02A252b5b4814aD"],
    [OPT]: ["0x794a61358D6845594F94dc1DB02A252b5b4814aD"],
  },
  "aave-v4": {
    [ETH]: ["0xe1900480ac69f0B296841Cd01cC37546d92F35Cd"],
  },
  "compound-v3": {
    [ETH]: ["0xc3d688B66703497DAA19211EEdff47f25384cdc3"],
    [BASE]: ["0xb125E6687d4313864e53df431d5425969c15Eb2F"],
    [ARB]: ["0x9c4ec768c28520B50860ea7a15bd7213a9fF58bf"],
  },
  cowswap: {
    [ETH]: ["0x9008D19f58AAbD9eD0D60971565AA8510560ab41"],
    [BASE]: ["0x9008D19f58AAbD9eD0D60971565AA8510560ab41"],
    [ARB]: ["0x9008D19f58AAbD9eD0D60971565AA8510560ab41"],
    [OPT]: ["0x9008D19f58AAbD9eD0D60971565AA8510560ab41"],
  },
  "uniswap-v3": {
    [ETH]: ["0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45"],
    [BASE]: ["0x2626664c2603336E57B271c5C0b26F421741e481"],
    [ARB]: ["0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45"],
    [OPT]: ["0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45"],
  },
  curve: {
    [ETH]: ["0xbEbc44782C7dB0a1A60Cb6fe97d0b483032FF1C7"],
    [BASE]: [],
    [ARB]: [],
    [OPT]: [],
  },
  lido: {
    [ETH]: ["0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0"],
  },
  "rocket-pool": {
    [ETH]: [
      "0xae78736Cd615f374D3085123A210448E74Fc6393",
      "0xDD3f50F8A6CafbE9b31a427582963f465E745AF8",
    ],
  },
  morpho: {
    [ETH]: ["0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb"],
    [BASE]: ["0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb"],
  },
  spark: {
    [ETH]: ["0xC13e21B648A5Ee794902342038FF3aDAB66BE987"],
  },
  sky: {
    [ETH]: ["0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD"],
  },
  ethena: {
    [ETH]: ["0x9D39A5DE30e57443BfF2A8307A4256c8797A3497"],
  },
  "yearn-v3": {
    [ETH]: ["0x22028E652a2e937c876F2577f8E78f692d6DAA93"],
    [ARB]: [],
  },
  pendle: {
    [ETH]: ["0x888888888889758F76e7103c6CbF23ABbF58F946"],
    [BASE]: ["0x888888888889758F76e7103c6CbF23ABbF58F946"],
    [ARB]: ["0x888888888889758F76e7103c6CbF23ABbF58F946"],
    [OPT]: ["0x888888888889758F76e7103c6CbF23ABbF58F946"],
  },
  aerodrome: {
    [BASE]: ["0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43"],
  },
  ajna: {
    [BASE]: ["0x97fa9b0909C238D170C1ab3B5c728A3a45BBEcBa"],
  },
  chainlink: {
    [ETH]: ["0x80226fc0Ee2b096224EeAc085Bb9a8cba1146f7D"],
    [BASE]: ["0x881e3A65B4d4a04dD529061dd0071cf975F58bCD"],
    [ARB]: ["0x141fa059441E0ca23ce184B6A78bafD2A517DdE8"],
    [OPT]: ["0x3206695CaE29952f4b0c22a169725a865bc8Ce0f"],
  },
  wrapped: {
    [ETH]: ["0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"],
    [BASE]: ["0x4200000000000000000000000000000000000006"],
    [ARB]: ["0x82aF49447D8a07e3bd95BD0d56f35241523fBab1"],
    [OPT]: ["0x4200000000000000000000000000000000000006"],
  },
} as const;

export function getProtocolTargets(
  slug: ProtocolSlug,
  chainId: number
): readonly string[] {
  const perChain = PROTOCOL_TARGETS[slug];
  if (!perChain) {
    return [];
  }
  return perChain[chainId] ?? [];
}
