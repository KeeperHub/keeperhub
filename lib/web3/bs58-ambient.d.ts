// Ambient declaration for bs58 module to satisfy typecheck
declare module "bs58" {
  const bs58: {
    encode(buffer: Uint8Array | Buffer | number[]): string;
    decode(string: string): Buffer;
  };
  export default bs58;
}
