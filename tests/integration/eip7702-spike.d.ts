declare module "@getpara/server-sdk/dist/esm/wallet/privateKey.js" {
  export function getPrivateKey(
    ctx: unknown,
    userId: string,
    walletId: string,
    userShare: string
  ): Promise<string>;
}
