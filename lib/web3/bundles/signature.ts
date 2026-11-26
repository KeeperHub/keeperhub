import { ethers } from "ethers";

/**
 * X-Flashbots-Signature value for a request body: `<address>:<signature>`,
 * an EIP-191 personal signature over the 0x-hex keccak256 of the exact body.
 */
export async function flashbotsSignature(
  searcher: ethers.Signer,
  body: string
): Promise<string> {
  const [address, signature] = await Promise.all([
    searcher.getAddress(),
    searcher.signMessage(ethers.id(body)),
  ]);
  return `${address}:${signature}`;
}
