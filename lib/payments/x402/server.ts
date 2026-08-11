import { createFacilitatorConfig } from "@coinbase/x402";
import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";

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
server.register("eip155:8453", new ExactEvmScheme());
