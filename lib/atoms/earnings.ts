import { atom } from "jotai";
import type { EarningsSummary } from "@/lib/earnings/types";

export const earningsDataAtom = atom<EarningsSummary | null>(null);
export const earningsLoadingAtom = atom<boolean>(true);
export const earningsErrorAtom = atom<string | null>(null);
export const earningsLastUpdatedAtom = atom<Date | null>(null);
