import type { AbiItemComponent } from "@/lib/abi/utils";

const flat = [
  { name: "id", type: "uint32" },
  { name: "to", type: "bytes32" },
];
const nested = [
  { name: "inner", type: "tuple", components: flat },
  { name: "amount", type: "uint256" },
];

export const TUPLE_SHAPES: {
  label: string;
  input: AbiItemComponent;
  canonical: string;
}[] = [
  {
    label: "flat tuple",
    input: { name: "p", type: "tuple", components: flat },
    canonical: "(uint32,bytes32)",
  },
  {
    label: "nested tuple",
    input: { name: "p", type: "tuple", components: nested },
    canonical: "((uint32,bytes32),uint256)",
  },
  {
    label: "tuple array",
    input: { name: "p", type: "tuple[]", components: flat },
    canonical: "(uint32,bytes32)[]",
  },
  {
    label: "fixed tuple array",
    input: { name: "p", type: "tuple[2]", components: flat },
    canonical: "(uint32,bytes32)[2]",
  },
  {
    label: "array inside tuple",
    input: {
      name: "p",
      type: "tuple",
      components: [{ name: "inner", type: "tuple[]", components: flat }],
    },
    canonical: "((uint32,bytes32)[])",
  },
  {
    label: "multidimensional nested tuple array",
    input: { name: "p", type: "tuple[][2]", components: nested },
    canonical: "((uint32,bytes32),uint256)[][2]",
  },
  {
    label: "empty tuple",
    input: { name: "p", type: "tuple", components: [] },
    canonical: "()",
  },
];
