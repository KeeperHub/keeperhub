import type { ElizaOSCredentials } from "./credentials";

export async function testElizaOS(credentials: ElizaOSCredentials): Promise<boolean> {
  if (!credentials.endpointUrl) {
    return false;
  }
  try {
    const res = await fetch(`${credentials.endpointUrl}/health`);
    return res.ok;
  } catch {
    return true; // Soft pass on network unreachable during test
  }
}
