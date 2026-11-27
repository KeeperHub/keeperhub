// Marks a send mined inside the wallet lock, so its trace can run after it.
export const MINED_SEND_KIND = "mined-send" as const;

export type MinedSend<TResult> = {
  kind: typeof MINED_SEND_KIND;
  hash: string;
  result: TResult;
};

export function minedSend<TResult>(
  hash: string,
  result: TResult
): MinedSend<TResult> {
  return { kind: MINED_SEND_KIND, hash, result };
}

export function isMinedSend<TResult, TOther extends object>(
  value: MinedSend<TResult> | TOther
): value is MinedSend<TResult> {
  return (value as Partial<MinedSend<TResult>>).kind === MINED_SEND_KIND;
}
