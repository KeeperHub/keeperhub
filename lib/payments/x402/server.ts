import { createFacilitatorConfig } from "@coinbase/x402";
import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { railsFor } from "@/lib/payments/rails";

function buildFacilitatorClient(): HTTPFacilitatorClient {
  const keyId = process.env.CDP_API_KEY_ID;
  const keySecret = process.env.CDP_API_KEY_SECRET;

  if (keyId && keySecret) {
    return new HTTPFacilitatorClient(createFacilitatorConfig(keyId, keySecret));
  }

  return new HTTPFacilitatorClient({
    url:
      process.env.X402_FACILITATOR_URL ??
      "https://api.cdp.coinbase.com/platform/v2/x402",
  });
}

export const facilitatorClient = buildFacilitatorClient();

export const server = new x402ResourceServer(facilitatorClient);
// Registered from the rail table rather than a literal, so a rail's network id
// is stated once. Only rails marked x402 are registered - the MPP rails settle
// through their own server and must not be advertised as x402 payment methods.
for (const rail of railsFor("x402")) {
  server.register(rail.network, new ExactEvmScheme());
}
