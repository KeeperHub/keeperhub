// Ambient type declaration for bs58@4 which ships no bundled types.
// bs58 is a direct dependency used only in submit-signed-solana.ts
// to encode raw Solana transaction signature bytes to base58.
declare module "bs58" {
  function encode(bytes: Uint8Array | Buffer): string;
  function decode(str: string): Buffer;
  export { encode, decode };
}
